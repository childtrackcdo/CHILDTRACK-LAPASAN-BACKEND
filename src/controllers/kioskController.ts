
// src/controllers/kioskController.ts
import { Request, Response } from 'express';
import pool from '../../lib/db';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_hs_secret';
const SCAN_PHOTOS_DIR = path.join(__dirname, '../../uploads/scans');

// sms-service now owns the SMS queue + GSM modem as a separate process —
// enqueueSMS() can no longer be a direct import, so this fires an HTTP
// request instead. Falls back to localhost for same-machine dev.
const SMS_SERVICE_URL = process.env.SMS_SERVICE_URL ?? 'http://localhost:5002';

/* ─────────────────────────────────────────────────────────────────
   Manila time helpers
   PHT = UTC+8. We build a Date shifted by +8h from raw UTC, then
   read it back with UTC getters (getUTCFullYear, getUTCHours, etc.)
   everywhere. Using local getters (getFullYear, getHours, ...) here
   would double-apply the offset whenever the host machine's own
   system timezone is also set to UTC+8 (e.g. a PH-based dev machine
   or server), producing timestamps ~8-16h off and records landing
   on the wrong calendar date. UTC getters make this correct
   regardless of the host's local timezone setting.
───────────────────────────────────────────────────────────────── */
function manilaDate(): Date {
  return new Date(Date.now() + 8 * 60 * 60 * 1_000);
}

function toMySQLDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function toLocalDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/* ─────────────────────────────────────────────────────────────────
   Student ID resolution helper
   in_out_campus does not store student_id — only lrn/name/section
   captured from the QR payload at scan time. When confirming a scan
   into the `attendance` table, we must resolve the real student_id
   via lrn, otherwise attendance.student_id is left NULL. Downstream
   reports (SF2, class record, SF9/SF10) key their rosters by
   student_id and fall back to a name-based key only when it's NULL —
   a NULL student_id causes the same student's attendance to land on
   a DIFFERENT key than their roster entry, producing a phantom
   "all absent" duplicate row instead of merging into the real one.
───────────────────────────────────────────────────────────────── */
async function resolveStudentIdByLRN(lrn: string): Promise<number | null> {
  if (!lrn) return null;
  const [rows]: any = await pool.query(
    'SELECT id FROM students WHERE lrn = ? LIMIT 1',
    [lrn],
  );
  return rows?.[0]?.id ?? null;
}

/* ─────────────────────────────────────────────────────────────────
   Notification helper
───────────────────────────────────────────────────────────────── */
async function insertNotification(params: {
  teacher_id:    number;
  status:        string;
  student_name:  string | null;
  section:       string | null;
  subject:       string | null;
  date:          string | null;
  guardian_name: string | null;
}): Promise<void> {
  const { teacher_id, status, student_name, section, subject, date, guardian_name } = params;
  const normalizedStatus = String(status ?? '').trim().toLowerCase();
  const NOTIFY_STATUSES  = ['present', 'late', 'absent', 'pick-up', 'pickup', 'drop-off', 'dropoff'];

  console.log(
    '[notifications][kiosk] attempt → teacher_id:', teacher_id,
    '| raw status:', JSON.stringify(status),
    '| normalized:', normalizedStatus,
    '| eligible:', NOTIFY_STATUSES.includes(normalizedStatus),
  );

  if (!teacher_id) {
    console.warn('[notifications][kiosk] SKIPPED — no teacher_id resolved');
    return;
  }
  if (!NOTIFY_STATUSES.includes(normalizedStatus)) {
    console.log('[notifications][kiosk] SKIPPED — status not in notify list');
    return;
  }

  const notifType =
    normalizedStatus === 'absent'                    ? 'absent'  :
    normalizedStatus === 'late'                      ? 'late'    :
    normalizedStatus === 'present'                    ? 'present' :
    ['pick-up','pickup'].includes(normalizedStatus)  ? 'pickup'  :
    'dropoff';

  const statusLabel =
    normalizedStatus === 'absent'                    ? 'Absent'   :
    normalizedStatus === 'late'                      ? 'Late'     :
    normalizedStatus === 'present'                    ? 'Present'  :
    ['pick-up','pickup'].includes(normalizedStatus)  ? 'Pick-Up'  :
    'Drop-Off';

  const body =
    `${student_name ?? 'A student'} marked as ${statusLabel}` +
    (section       ? ` · ${section}`                 : '') +
    (subject       ? ` · ${subject}`                 : '') +
    (date          ? ` on ${date}`                   : '') +
    (guardian_name ? ` (Guardian: ${guardian_name})` : '');

  try {
    const [notifResult]: any = await pool.query(
      'INSERT INTO notifications (teacher_id, type, body, is_read) VALUES (?, ?, ?, 0)',
      [teacher_id, notifType, body],
    );
    console.log('[notifications][kiosk] INSERT SUCCESS, insertId:', notifResult.insertId);
  } catch (e) {
    console.error('[notifications][kiosk] INSERT FAILED:', e);
  }
}

/* ─────────────────────────────────────────────────────────────────
   SMS helper — now an HTTP call to sms-service, not a local import.
   Fire-and-forget: callers (kioskScan) already wrap this in
   setImmediate + .catch(), so failures here just log and never
   affect the attendance response already sent to the client.
───────────────────────────────────────────────────────────────── */
async function enqueueSMSViaService(params: {
  studentName:   string;
  contactNumber: string;
  status:        'Present' | 'Late';
  section:       string;
  scanTimestamp: string;
  direction?:    'IN' | 'OUT';
  kioskId?:      number;
}): Promise<void> {
  const res = await fetch(`${SMS_SERVICE_URL}/api/gsm/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sms-service responded ${res.status}: ${text}`);
  }
}

/* ─────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────── */
export function getKioskTeacherId(req: Request): number | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const decoded: any = jwt.verify(header.slice(7), JWT_SECRET);
    return decoded?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * saveScanPhotoToDisk — runs async, never blocks the scan response.
 * Call with .catch() and move on; the return value is not awaited.
 */
export function saveScanPhotoToDisk(photoDataUrl: string, studentName: string): string | null {
  try {
    const match = photoDataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return null;
    const ext    = match[1] === 'jpeg' ? 'jpg' : match[1];
    const base64 = match[2];
    const safeName = studentName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'student';
    const filename = `scan_${Date.now()}_${safeName}.${ext}`;
    fs.mkdirSync(SCAN_PHOTOS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SCAN_PHOTOS_DIR, filename), Buffer.from(base64, 'base64'));
    return `/uploads/scans/${filename}`;
  } catch (err) {
    console.error('[saveScanPhotoToDisk]', err);
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────
   POST /api/kiosk/login
───────────────────────────────────────────────────────────────── */
export const kioskLogin = async (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });
  try {
    const [rows]: any = await pool.query(
      'SELECT * FROM teachers WHERE username = ? LIMIT 1', [username],
    );
    const user = rows?.[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });
    const token = jwt.sign(
      { id: user.id, username: user.username, role: 'kiosk' },
      JWT_SECRET,
      { expiresIn: '12h' },
    );
    return res.json({
      token,
      admin: { id: user.id, username: user.username, name: user.name || user.username },
    });
  } catch (err) {
    console.error('[kioskLogin]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};

/* ─────────────────────────────────────────────────────────────────
   POST /api/kiosk/scan
   ─ First scan of the day  → IN  (basis for attendance)
   ─ Second scan of the day → OUT (logged, excluded from confirm queue)
   ─ Third+ scan            → alreadyRecorded: true, nothing inserted
   Body:    { qr_data, photo }
   Returns: { record, isNew, alreadyRecorded, direction }

   SPEED OPTIMISATIONS vs the original:
   1. Single SELECT for IN/OUT check (unchanged — already one query).
   2. INSERT result used directly to build the response row instead of
      doing a follow-up SELECT WHERE id = ? (saves one round-trip).
   3. Photo disk write, scan_photos INSERT, and SMS enqueue are ALL
      fire-and-forget — they run after the response is sent so the
      client gets the confirmation in ≤ 200 ms instead of waiting for
      disk I/O + an extra DB write + a network call to sms-service.
   4. Add a composite index on (lrn, date, status) if you haven't
      already — see the migration note at the bottom of this file.

   NOTE: in_out_campus intentionally does NOT store student_id — it's
   a staging table keyed by lrn from the QR payload. student_id is
   resolved and written only when a scan is confirmed into the real
   `attendance` table (see kioskConfirm / kioskConfirmBulk below).
───────────────────────────────────────────────────────────────── */
export const kioskScan = async (req: Request, res: Response) => {
  const { qr_data, photo } = req.body;
  if (!qr_data) return res.status(400).json({ error: 'qr_data is required.' });

  let payload: any;
  try {
    payload = typeof qr_data === 'string' ? JSON.parse(qr_data) : qr_data;
  } catch {
    return res.status(422).json({ error: 'Invalid QR payload — not valid JSON.' });
  }

  const { lrn, name: studentName, section, gender, parent1, contact } = payload;
  if (!lrn || !studentName)
    return res.status(422).json({ error: 'QR missing required fields (lrn, name).' });

  const teacherId = getKioskTeacherId(req);
  const now       = manilaDate();
  const localDate = toLocalDateStr(now);
  const session   = now.getUTCHours() < 12 ? 'AM' : 'PM';
  const timestamp = toMySQLDateTime(now);

  try {
    // ── 1. Single query: fetch both IN and OUT for today ─────────────────────
    // Requires a composite index on (lrn, date, status) for speed at scale.
    // See migration note at bottom of file.
    const [todayRows]: any = await pool.query(
      `SELECT id, direction, status, confirmed, attendance_id
       FROM in_out_campus
       WHERE lrn = ? AND date = ? AND status IN ('Present','Late')
       ORDER BY timestamp ASC`,
      [lrn, localDate],
    );

    const inRow  = (todayRows as any[]).find((r: any) => r.direction === 'IN');
    const outRow = (todayRows as any[]).find((r: any) => r.direction === 'OUT');

    // ── Both IN and OUT already exist — nothing to do ────────────────────────
    if (inRow && outRow) {
      // Build a minimal response without a DB round-trip
      return res.status(200).json({
        record: outRow,
        isNew: false,
        alreadyRecorded: true,
        direction: 'OUT',
      });
    }

    const direction: 'IN' | 'OUT' = inRow ? 'OUT' : 'IN';

    // ── 2. Compute status ─────────────────────────────────────────────────────
    let status: 'Present' | 'Late';
    if (direction === 'IN') {
      const nowMinutes   = now.getUTCHours() * 60 + now.getUTCMinutes();
      const classMinutes = 7 * 60 + 30;
      status = nowMinutes - classMinutes >= 30 ? 'Late' : 'Present';
    } else {
      status = inRow.status === 'Late' ? 'Late' : 'Present';
    }

    // ── 3. INSERT into in_out_campus — core record (blocking) ─────────────────
    const qrString = typeof qr_data === 'string' ? qr_data : JSON.stringify(qr_data);

    const [result]: any = await pool.query(
      `INSERT INTO in_out_campus
         (teacher_id, student_name, lrn, gender, guardian_name,
          section, status, session, date, qr_data,
          photo_data, photo_path, direction, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        teacherId ?? null,
        studentName,
        lrn,
        gender  || '',
        parent1 || '',
        section || '',
        status,
        session,
        localDate,
        qrString,
        photo     || null,   // photo_data stored inline (large but unchanged from original)
        null,                // photo_path filled in asynchronously below
        direction,
        timestamp,
      ],
    );

    const insertId: number = (result as any).insertId;

    // ── 4. Build response from known values — NO follow-up SELECT ─────────────
    // We already have every field; constructing the object here saves one
    // full DB round-trip (~5-20 ms) and is the single biggest speedup.
    const record = {
      id:            insertId,
      teacher_id:    teacherId ?? null,
      student_name:  studentName,
      lrn,
      gender:        gender  || '',
      guardian_name: parent1 || '',
      section:       section || '',
      status,
      session,
      date:          localDate,
      qr_data:       qrString,
      photo_data:    photo || null,
      photo_path:    null,          // will be updated on disk async; kiosk display uses photo_data anyway
      direction,
      timestamp,
      confirmed:     0,
      confirmed_at:  null,
      confirmed_by:  null,
      attendance_id: null,
    };

    // ── 5. Respond immediately — client unblocked here ───────────────────────
    res.status(201).json({ record, isNew: true, alreadyRecorded: false, direction });

    // ── 6. Fire-and-forget: photo disk write + scan_photos row + SMS ──────────
    // None of these affect the attendance record — they are logging/alerting
    // side-effects. Running them after the response keeps the critical path
    // under ~200 ms even on a slow disk, congested GSM queue, or a slow
    // sms-service response.
    setImmediate(async () => {
      let photoPath: string | null = null;

      // 6a. Write photo to disk
      if (photo) {
        photoPath = saveScanPhotoToDisk(photo, studentName);
        if (photoPath) {
          // Back-fill photo_path so the record is complete in the DB
          pool.query(
            'UPDATE in_out_campus SET photo_path = ? WHERE id = ?',
            [photoPath, insertId],
          ).catch((e: unknown) => console.error('[kioskScan] photo_path update failed:', e));
        }
      }

      // 6b. Optional scan_photos log
      pool.query(
        `INSERT INTO scan_photos
           (teacher_id, student_name, status, photo_path, photo_data, captured_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [teacherId, studentName, status, photoPath, photo || null, timestamp],
      ).catch(() => { /* table is optional */ });

      // 6c. SMS alert — now a network call to sms-service (port 5002),
      // not a direct in-process function call.
      enqueueSMSViaService({
        studentName,
        contactNumber: contact ?? '',
        status,
        section:       section ?? '—',
        scanTimestamp: timestamp,
        direction,
      }).catch((err: unknown) => {
        console.error('[GSM] Failed to reach sms-service:', err);
      });
    });

  } catch (err) {
    console.error('[kioskScan]', err);
    // Only reachable before res.json() fires — safe to send an error response
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Server error while recording scan.' });
    }
  }
};

/* ─────────────────────────────────────────────────────────────────
   GET /api/kiosk/records?date=YYYY-MM-DD
───────────────────────────────────────────────────────────────── */
export const kioskGetRecords = async (req: Request, res: Response) => {
  const now         = manilaDate();
  const defaultDate = toLocalDateStr(now);
  const date        = (req.query.date as string) || defaultDate;

  try {
    const [rows]: any = await pool.query(
      `SELECT * FROM in_out_campus WHERE date = ? ORDER BY timestamp DESC`,
      [date],
    );
    return res.json(rows || []);
  } catch (err) {
    console.error('[kioskRecords]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};

/* ─────────────────────────────────────────────────────────────────
   GET /api/kiosk/pending?date=YYYY-MM-DD&section=...&subject=...&advisory_only=true
   OUT rows are excluded — attendance is built only from IN scans.

   FIX (previously): this endpoint filtered on the scan's single global
   `confirmed` flag (`confirmed = 0`). Since in_out_campus.confirmed is
   ONE flag per scan — not per subject — the moment ANY one teacher (e.g.
   the adviser, confirming for Advisory) confirmed a scan, it disappeared
   from EVERY OTHER subject teacher's pending queue too, even though no
   attendance row existed yet for their own subject. A student who scanned
   in and got confirmed by their adviser would then show "No records" for
   every subject teacher, who had no way to confirm attendance for their
   own class.

   NOW: "pending for subject X" means "no attendance row yet exists for
   (lrn, date, subject X)" — checked via a LEFT JOIN against `attendance`
   scoped to the caller's own subject (or NULL/empty subject for Advisory,
   passed either as subject='' or advisory_only=true). Each teacher's
   pending queue is now independent: Advisory being confirmed no longer
   hides the scan from a subject teacher who still hasn't confirmed it for
   their own class, and vice versa.
───────────────────────────────────────────────────────────────── */
export const kioskGetPending = async (req: Request, res: Response) => {
  const now         = manilaDate();
  const defaultDate = toLocalDateStr(now);
  const date        = (req.query.date    as string) || defaultDate;
  const section     = (req.query.section as string) || '';
  const subjectRaw    = (req.query.subject as string) || '';
  const advisoryOnly  = String(req.query.advisory_only ?? '') === 'true';
  const isAdvisoryReq = advisoryOnly || !subjectRaw;

  try {
    const conditions = [
      "ioc.date = ?",
      "ioc.status != 'Duplicate'",
      "ioc.direction = 'IN'",
    ];
    const params: any[] = [date];

    if (section) {
      conditions.push('ioc.section = ?');
      params.push(section);
    }

    // Advisory pending queue: match attendance rows with NULL/empty subject.
    // Subject pending queue: match attendance rows for that exact subject.
    const joinSubjectCond = isAdvisoryReq
      ? `(att.subject IS NULL OR att.subject = '')`
      : `att.subject = ?`;
    const joinParams: any[] = isAdvisoryReq ? [] : [subjectRaw];

    const [rows]: any = await pool.query(
      `SELECT ioc.id, ioc.student_name, ioc.lrn, ioc.gender, ioc.guardian_name, ioc.section,
              ioc.status, ioc.session, ioc.date, ioc.photo_path, ioc.direction, ioc.confirmed, ioc.timestamp
       FROM in_out_campus ioc
       LEFT JOIN attendance att
         ON att.lrn = ioc.lrn AND att.date = ioc.date AND ${joinSubjectCond}
       WHERE ${conditions.join(' AND ')} AND att.id IS NULL
       ORDER BY ioc.timestamp ASC`,
      [...joinParams, ...params],
    );
    return res.json(rows || []);
  } catch (err) {
    console.error('[kioskGetPending]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};

/* ─────────────────────────────────────────────────────────────────
   POST /api/kiosk/confirm/:id
   Body: { subject?, section? }

   Unchanged in logic from before — this already scoped the existence
   check and the INSERT by `subject`, so confirming the same scan from
   a second subject tab correctly creates a SECOND, independent
   `attendance` row rather than being blocked by the first one. The bug
   was only ever in what kioskGetPending showed as "still pending" (see
   above) — this endpoint was already correct.
───────────────────────────────────────────────────────────────── */
export const kioskConfirm = async (req: Request, res: Response) => {
  const { id } = req.params;
  const teacherId: number | null = (req as any).teacher?.id ?? null;
  const { subject: subjectOverrideRaw, section: sectionOverrideRaw } = req.body ?? {};
  const subject         = String(subjectOverrideRaw ?? '').trim();
  const sectionOverride = String(sectionOverrideRaw ?? '').trim();

  try {
    const [rows]: any = await pool.query(
      'SELECT * FROM in_out_campus WHERE id = ? LIMIT 1', [id],
    );
    const scan = rows?.[0];
    if (!scan) return res.status(404).json({ error: 'Scan record not found.' });

    if (scan.direction !== 'IN') {
      return res.status(400).json({ error: 'Only IN scans can be confirmed into attendance.' });
    }

    // NOTE: scan.confirmed is a legacy global flag left over from before
    // subjects were independent. It's still written below (for backward
    // compatibility with anything else reading it), but it is no longer
    // used to decide whether THIS confirmation (for THIS subject) should
    // proceed — that decision is entirely the existingAtt lookup just
    // below, scoped by subject.

    const [existingAtt]: any = await pool.query(
      subject
        ? 'SELECT id FROM attendance WHERE lrn = ? AND date = ? AND subject = ? LIMIT 1'
        : `SELECT id FROM attendance WHERE lrn = ? AND date = ? AND (subject IS NULL OR subject = '') LIMIT 1`,
      subject ? [scan.lrn, scan.date, subject] : [scan.lrn, scan.date],
    );

    if (existingAtt?.[0]) {
      const [att]: any = await pool.query(
        'SELECT * FROM attendance WHERE id = ? LIMIT 1', [existingAtt[0].id],
      );
      return res.json({ ok: true, alreadyConfirmed: true, attendance: att?.[0] ?? null });
    }

    let attendanceId: number;
    const effectiveTeacherId: number | null = teacherId ?? scan.teacher_id ?? null;
    const effectiveSection = sectionOverride || scan.section || '';

    // Resolve student_id from lrn — in_out_campus doesn't store it directly,
    // and leaving this NULL causes downstream reports (SF2, class record,
    // SF9/SF10) to key this attendance row separately from the roster,
    // producing a phantom duplicate row that shows the student as absent
    // all month even though real attendance was recorded.
    const resolvedStudentId = await resolveStudentIdByLRN(scan.lrn);

    const [result]: any = await pool.query(
      `INSERT INTO attendance
         (teacher_id, student_id, student_name, lrn, gender, guardian_name,
          by_whom, status, session, date, section, subject,
          qr_data, timestamp, verified_in_class)
       VALUES (?, ?, ?, ?, ?, ?, 'kiosk', ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        effectiveTeacherId,
        resolvedStudentId,
        scan.student_name,
        scan.lrn,
        scan.gender        || '',
        scan.guardian_name || '',
        scan.status,
        scan.session,
        scan.date,
        effectiveSection,
        subject,
        scan.qr_data || null,
        scan.timestamp,
      ],
    );
    attendanceId = (result as any).insertId;

    // Mark the scan's legacy global flag confirmed the first time ANY
    // subject confirms it, so old code/dashboards reading `confirmed`
    // still see it as "touched." This no longer gates other subjects'
    // pending queues (see kioskGetPending above).
    if (scan.confirmed !== 1) {
      await pool.query(
        `UPDATE in_out_campus
         SET confirmed = 1, confirmed_at = NOW(), confirmed_by = ?, attendance_id = ?
         WHERE id = ?`,
        [teacherId, attendanceId, id],
      );
    }

    if (effectiveTeacherId) {
      await insertNotification({
        teacher_id:    effectiveTeacherId,
        status:        scan.status,
        student_name:  scan.student_name ?? null,
        section:       effectiveSection  || null,
        subject:       subject           || null,
        date:          scan.date         ?? null,
        guardian_name: scan.guardian_name ?? null,
      });
    }

    const [att]: any = await pool.query(
      'SELECT * FROM attendance WHERE id = ? LIMIT 1', [attendanceId],
    );
    return res.json({ ok: true, attendance: att?.[0] ?? null });
  } catch (err) {
    console.error('[kioskConfirm]', err);
    return res.status(500).json({ error: 'Server error while confirming scan.' });
  }
};

/* ─────────────────────────────────────────────────────────────────
   POST /api/kiosk/confirm-bulk
   Body: { date, section?, subject? }

   FIX: previously this checked
     SELECT id FROM attendance WHERE lrn = ? AND date = ? LIMIT 1
   with NO subject in the WHERE clause. That meant once ANY attendance
   row existed for a student that day (e.g. the Advisory row), bulk
   confirm would treat the student as "already has attendance" and
   silently skip creating a subject-specific row — so "Verify All
   Present" from a subject tab would never actually confirm anything
   for that subject once Advisory had already been confirmed.
   Now scoped by subject exactly like kioskConfirm, so bulk-confirming
   from a subject tab creates (or reuses) the row for THAT subject only.
───────────────────────────────────────────────────────────────── */
export const kioskConfirmBulk = async (req: Request, res: Response) => {
  const teacherId: number | null = (req as any).teacher?.id ?? null;
  const { date, section, subject: subjectRaw } = req.body;
  if (!date) return res.status(400).json({ error: 'date is required.' });

  const subject = String(subjectRaw ?? '').trim();

  try {
    const conditions = [
      "date = ?",
      "status != 'Duplicate'",
      "direction = 'IN'",
    ];
    const params: any[] = [date];
    if (section) { conditions.push('section = ?'); params.push(section); }

    const [pending]: any = await pool.query(
      `SELECT * FROM in_out_campus WHERE ${conditions.join(' AND ')} ORDER BY timestamp ASC`,
      params,
    );

    let confirmed = 0;
    for (const scan of (pending as any[])) {
      try {
        const [existingAtt]: any = await pool.query(
          subject
            ? 'SELECT id FROM attendance WHERE lrn = ? AND date = ? AND subject = ? LIMIT 1'
            : `SELECT id FROM attendance WHERE lrn = ? AND date = ? AND (subject IS NULL OR subject = '') LIMIT 1`,
          subject ? [scan.lrn, scan.date, subject] : [scan.lrn, scan.date],
        );

        // Already has a row for THIS subject — nothing to do for this scan.
        if (existingAtt?.[0]) continue;

        const effectiveTeacherId: number | null = teacherId ?? scan.teacher_id ?? null;

        // Resolve student_id from lrn — same reasoning as kioskConfirm above.
        const resolvedStudentId = await resolveStudentIdByLRN(scan.lrn);

        const [result]: any = await pool.query(
          `INSERT INTO attendance
             (teacher_id, student_id, student_name, lrn, gender, guardian_name,
              by_whom, status, session, date, section, subject,
              qr_data, timestamp, verified_in_class)
           VALUES (?, ?, ?, ?, ?, ?, 'kiosk', ?, ?, ?, ?, ?, ?, ?, 0)`,
          [
            effectiveTeacherId,
            resolvedStudentId,
            scan.student_name,
            scan.lrn,
            scan.gender        || '',
            scan.guardian_name || '',
            scan.status,
            scan.session,
            scan.date,
            scan.section       || '',
            subject,
            scan.qr_data       || null,
            scan.timestamp,
          ],
        );
        const attendanceId = (result as any).insertId;

        if (scan.confirmed !== 1) {
          await pool.query(
            `UPDATE in_out_campus
             SET confirmed = 1, confirmed_at = NOW(), confirmed_by = ?, attendance_id = ?
             WHERE id = ?`,
            [teacherId, attendanceId, scan.id],
          );
        }

        if (effectiveTeacherId) {
          await insertNotification({
            teacher_id:    effectiveTeacherId,
            status:        scan.status,
            student_name:  scan.student_name  ?? null,
            section:       scan.section       ?? null,
            subject:       subject            || null,
            date:          scan.date          ?? null,
            guardian_name: scan.guardian_name ?? null,
          });
        }
        confirmed++;
      } catch (innerErr) {
        console.error('[kioskConfirmBulk] row error', scan.id, innerErr);
      }
    }

    return res.json({ ok: true, confirmed, total: (pending as any[]).length });
  } catch (err) {
    console.error('[kioskConfirmBulk]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};

/* ─────────────────────────────────────────────────────────────────
   POST /api/kiosk/dismiss/:id
───────────────────────────────────────────────────────────────── */
export const kioskDismiss = async (req: Request, res: Response) => {
  const { id } = req.params;
  const teacherId: number | null = (req as any).teacher?.id ?? null;
  try {
    await pool.query(
      `UPDATE in_out_campus
       SET confirmed = -1, confirmed_at = NOW(), confirmed_by = ?
       WHERE id = ?`,
      [teacherId, id],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[kioskDismiss]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};

/* ─────────────────────────────────────────────────────────────────
   POST /api/kiosk/mark-absences
   Present and Late are generated automatically at scan/confirm time.
   Absent has no scan to key off of, so this endpoint scans the
   roster of students who have a scan history but did NOT scan IN
   today, and fires an 'absent' notification for each — once per
   student per day (guarded by a duplicate check on the notification
   body). Call this manually from a UI button, or wire it to a cron
   job at end-of-day.
───────────────────────────────────────────────────────────────── */
export const markAbsences = async (req: Request, res: Response) => {
  const teacherId: number | null = (req as any).teacher?.id ?? null;
  if (!teacherId) return res.status(401).json({ error: 'Unauthorized' });

  const now  = manilaDate();
  const date = toLocalDateStr(now);

  try {
    // Students who have scanned before but not today
    const [missing]: any = await pool.query(
      `SELECT DISTINCT student_name, lrn, section, guardian_name
       FROM in_out_campus
       WHERE lrn NOT IN (
         SELECT lrn FROM in_out_campus
         WHERE date = ? AND direction = 'IN'
       )
       AND date < ?`,
      [date, date]
    );

    let marked = 0;
    for (const student of missing as any[]) {
      // Avoid duplicate absent notifications for the same student+date
      const [existing]: any = await pool.query(
        `SELECT id FROM notifications
         WHERE teacher_id = ? AND type = 'absent' AND body LIKE ?`,
        [teacherId, `%${student.student_name}%${date}%`]
      );
      if (existing?.[0]) continue;

      await insertNotification({
        teacher_id:    teacherId,
        status:        'absent',
        student_name:  student.student_name,
        section:       student.section       ?? null,
        subject:       null,
        date,
        guardian_name: student.guardian_name ?? null,
      });
      marked++;
    }

    return res.json({ ok: true, marked });
  } catch (err) {
    console.error('[markAbsences]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};

/*
  ═══════════════════════════════════════════════════════════════════
  MIGRATION NOTE — run this once on your MariaDB instance:

  ALTER TABLE in_out_campus
    ADD INDEX idx_lrn_date_status (lrn, date, status);

  This covers the WHERE lrn = ? AND date = ? AND status IN (...)
  lookup in kioskScan, which runs on EVERY scan. Without it, MariaDB
  does a full table scan once the table grows past a few thousand rows,
  which is the other source of slowness that code changes alone can't fix.

  ALSO RUN ONCE — backfill existing NULL student_id rows in attendance
  caused by the bug fixed above (kioskConfirm / kioskConfirmBulk were
  not writing student_id on INSERT):

  UPDATE attendance a
  JOIN students s ON s.lrn = a.lrn
  SET a.student_id = s.id
  WHERE a.student_id IS NULL AND a.lrn IS NOT NULL AND a.lrn != '';

  ALSO RECOMMENDED — an index to speed up the new per-subject pending
  LEFT JOIN in kioskGetPending:

  ALTER TABLE attendance
    ADD INDEX idx_lrn_date_subject (lrn, date, subject);
  ═══════════════════════════════════════════════════════════════════
*/