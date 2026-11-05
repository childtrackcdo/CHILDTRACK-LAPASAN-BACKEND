import { Request, Response } from 'express';
import pool from '../lib/db';
import { getKioskTeacherId, saveScanPhotoToDisk } from '../src/controllers/kioskController';

/* ─────────────────────────────────────────────────────────────────
   POST /api/kiosk/sync
   Body: { kiosk_id, scans: [...], sms: [...] }
   Used by the Raspberry Pi kiosk to upload everything it captured
   (possibly while offline).

   scans → in_out_campus: keeps the ORIGINAL timestamp/status/direction
           (nothing is recomputed) and is idempotent via client_uuid.
   sms   → sms_queue as an ALREADY 'sent' or 'failed' log row. It is NEVER
           inserted as 'pending', so sms-service can't send it a second time.
   No SMS is triggered here — the Pi already sent it from its own modem.
───────────────────────────────────────────────────────────────── */
export const kioskSync = async (req: Request, res: Response) => {
  try {
    const teacherId = getKioskTeacherId(req);
    const kioskId   = Number(req.body?.kiosk_id) || 1;
    const scans: any[]   = Array.isArray(req.body?.scans) ? req.body.scans : [];
    const smsRows: any[] = Array.isArray(req.body?.sms)   ? req.body.sms   : [];

    const accepted: string[]    = [];
    const smsAccepted: string[] = [];

    for (const s of scans) {
      if (!s?.client_uuid) continue;

      // Malformed rows are acknowledged so they can't block the queue forever.
      if (!s.lrn || !s.student_name || !s.date || !s.timestamp || !s.direction) {
        console.warn('[kioskSync] dropping malformed scan', s.client_uuid);
        accepted.push(s.client_uuid);
        continue;
      }

      try {
        const [result]: any = await pool.query(
          `INSERT IGNORE INTO in_out_campus
             (client_uuid, teacher_id, student_name, lrn, gender, guardian_name,
              section, status, session, date, qr_data, photo_data, photo_path,
              direction, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            s.client_uuid, teacherId ?? null, s.student_name, s.lrn,
            s.gender || '', s.guardian_name || '', s.section || '',
            s.status,
            s.session || (String(s.timestamp).slice(11, 13) < '12' ? 'AM' : 'PM'),
            s.date, s.qr_data || null, s.photo || null, null,
            s.direction, s.timestamp,
          ],
        );

        if ((result as any).affectedRows > 0 && s.photo) {
          const photoPath = saveScanPhotoToDisk(s.photo, s.student_name);
          if (photoPath) {
            pool.query('UPDATE in_out_campus SET photo_path = ? WHERE id = ?', [photoPath, (result as any).insertId])
              .catch((e: unknown) => console.error('[kioskSync] photo_path update failed:', e));
          }
        }
        accepted.push(s.client_uuid);
      } catch (err) {
        console.error('[kioskSync] scan failed', s.client_uuid, err);
        // not accepted → the Pi keeps it and retries
      }
    }

    for (const m of smsRows) {
      if (!m?.client_uuid) continue;

      const status = m.status === 'failed' ? 'failed' : m.status === 'sent' ? 'sent' : null;
      if (!status || !m.phone_number || !m.message) {
        console.warn('[kioskSync] dropping malformed sms log', m.client_uuid);
        smsAccepted.push(m.client_uuid);
        continue;
      }

      try {
        await pool.query(
          `INSERT IGNORE INTO sms_queue
             (client_uuid, phone_number, message, status, kiosk_id,
              created_at, sent_at, failed_at, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            m.client_uuid, m.phone_number, m.message, status, kioskId,
            m.created_at || null,
            status === 'sent'   ? (m.sent_at || m.created_at || null) : null,
            status === 'failed' ? (m.created_at || null) : null,
            m.error_message ? String(m.error_message).slice(0, 250) : null,
          ],
        );
        smsAccepted.push(m.client_uuid);
      } catch (err) {
        console.error('[kioskSync] sms log failed', m.client_uuid, err);
      }
    }

    return res.json({ ok: true, accepted, smsAccepted });
  } catch (e) {
    console.error('[kioskSync] fatal', e);
    return res.status(500).json({ error: 'sync failed' });
  }
};