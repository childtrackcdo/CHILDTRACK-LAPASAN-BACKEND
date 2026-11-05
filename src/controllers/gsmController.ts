// src/controllers/gsmController.ts
//
// SMS queue + plugin config.
//
// Two possible senders can drain the SMS queue:
//   1. A modem wired DIRECTLY to whatever machine runs this process
//      (sendSMSDirect() via gsmSerial.ts, gated by isGSMReady()).
//   2. A separate ESP32+SIM800L BRIDGE (see /sms-bridge) — it polls
//      GET /api/gsm/pending, sends via serial itself, then calls
//      POST /api/gsm/ack/:id or /api/gsm/fail/:id.
//
// The bridge is a true plugin: it hardcodes only WiFi creds, BASE_URL,
// and wiring. Whether it's active at all, and how fast it polls, is
// decided here and served via GET/PUT /api/gsm/config — see
// gsmConfigService.ts for persistence. Flip a kiosk off or retune its
// poll rate with a PUT; every device picks it up on its next config
// check, no reflash.
//
// On a cloud host (Render, etc.) there is no physical serial port, so
// isGSMReady() is always false there — processNext() below detects this
// and leaves the row 'pending' instead of marking it 'failed', so the
// bridge can pick it up on its next poll.
//
// Flow:
//   kioskScan → enqueueSMS() → row inserted (status='pending')
//                            → processNext() tries sendSMSDirect()
//                              IF a local modem is ready on THIS host.
//                              Otherwise the row stays 'pending' for
//                              the bridge to relay.
//
// ── UPDATE ───────────────────────────────────────────────────────────────
// processNext() used to grab and handle exactly ONE pending row per call,
// triggered only from enqueueSMS() (i.e. once per scan). If several scans
// queued up faster than they could be sent (e.g. while the modem was still
// initializing, or during a brief GSM hiccup), only one row advanced per
// new scan — everything else behind it in the queue could get stranded in
// 'pending' indefinitely, since nothing else was re-triggering the drain.
//
// processNext() now loops, draining the entire pending backlog in one
// call: it keeps pulling and sending the oldest pending row until either
// the queue is empty or the modem isn't ready (at which point it stops
// and leaves whatever's left for the bridge / next trigger). This makes
// a single scan's processNext() call catch up on any backlog, not just
// advance by one.
// ────────────────────────────────────────────────────────────────────────
//
import { Request, Response } from 'express';
import pool from '../../lib/db';
import { sendSMSDirect, isGSMReady } from '../../services/gsmSerial';
import { getConfig, updateConfig } from '../../services/gsmConfigService';

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function normalisePH(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('63') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('0')  && digits.length === 11) return `+63${digits.slice(1)}`;
  if (digits.length === 10)                            return `+63${digits}`;
  return `+${digits}`;
}

function buildMessage(
  studentName: string,
  status: 'Present' | 'Late',
  section: string,
  time: string,
  direction: 'IN' | 'OUT' = 'IN',
): string {
  if (direction === 'OUT') {
    return (
      `CHILDTrack Attendance\n` +
      `CHECKED OUT\n` +
      `Student: ${studentName}\n` +
      `Section: ${section}\n` +
      `Time: ${time}\n` +
      `Your child has left the school premises.`
    );
  }

  const statusLine = status === 'Late' ? 'LATE ARRIVAL' : 'PRESENT';
  return (
    `CHILDTrack Attendance\n` +
    `${statusLine}\n` +
    `Student: ${studentName}\n` +
    `Section: ${section}\n` +
    `Time: ${time}\n` +
    `Your child has arrived at school premises.`
  );
}

/* ── Internal queue processor ────────────────────────────────────────────── */

let processing = false;

async function processNext(): Promise<void> {
  if (processing) return;
  processing = true;

  try {
    // Loop until the pending queue is empty or the modem stops being ready.
    // This lets a single call catch up on any backlog instead of only
    // advancing by one row.
    while (true) {
      const [rows]: any = await (pool as any).query(
        `SELECT id, phone_number, message
           FROM sms_queue
          WHERE status = 'pending'
          ORDER BY created_at ASC
          LIMIT 1`,
      );

      const row = rows?.[0];
      if (!row) break; // queue is empty — nothing left to do

      // ── No modem physically attached to THIS process ────────────────────
      // (always true on a cloud host like Render). Leave the row 'pending' —
      // the ESP32 bridge will pick it up via GET /api/gsm/pending, PROVIDED
      // its config has enabled=true (see gsmConfigService.getConfig).
      if (!isGSMReady()) {
        console.log(`[GSM] No local modem ready on this host — leaving SMS ${row.id} pending for bridge relay`);
        break; // stop looping — nothing more we can do right now
      }

      await (pool as any).query(
        `UPDATE sms_queue SET status = 'queued' WHERE id = ?`,
        [row.id],
      );

      const success = await sendSMSDirect(row.phone_number, row.message);

      if (success) {
        await (pool as any).query(
          `UPDATE sms_queue SET status = 'sent', sent_at = NOW() WHERE id = ?`,
          [row.id],
        );
        console.log(`[GSM] SMS ${row.id} → sent`);
      } else {
        await (pool as any).query(
          `UPDATE sms_queue SET status = 'failed', failed_at = NOW(),
           error_message = 'sendSMSDirect returned false' WHERE id = ?`,
          [row.id],
        );
        console.warn(`[GSM] SMS ${row.id} → failed`);
      }
      // loop continues — pick up the next pending row, if any
    }
  } catch (err: any) {
    console.error('[GSM] processNext error:', err.message);
  } finally {
    processing = false;
  }
}

/* ── Public: called by kioskScan ─────────────────────────────────────────── */

export async function enqueueSMS(params: {
  studentName:   string;
  contactNumber: string;
  status:        'Present' | 'Late';
  section:       string;
  scanTimestamp: string;
  direction?:    'IN' | 'OUT';
  kioskId?:      number;
}): Promise<void> {
  const {
    studentName,
    contactNumber,
    status,
    section,
    scanTimestamp,
    direction = 'IN',
    kioskId   = 1,
  } = params;

  if (!contactNumber?.trim()) return;

  const phone   = normalisePH(contactNumber.trim());
  const timeStr = new Date(scanTimestamp).toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit',
  });
  const message = buildMessage(studentName, status, section, timeStr, direction);

  await (pool as any).query(
    `INSERT INTO sms_queue
       (phone_number, message, status, kiosk_id, created_at)
     VALUES (?, ?, 'pending', ?, NOW())`,
    [phone, message, kioskId],
  );

  // Attempt delivery immediately IF a modem is attached to this host.
  // processNext() now drains the whole pending backlog, not just this
  // one row, so this call also mops up anything stranded from earlier.
  // Otherwise the row(s) simply wait in 'pending' for the bridge.
  processNext().catch(err => console.error('[GSM] processNext threw:', err));
}

/* ── Route handlers: SMS queue (bridge-facing) ───────────────────────────── */

// Used by the ESP32 bridge to fetch work. Honors the kiosk's own config —
// if an admin has disabled this kiosk, the bridge itself will already have
// stopped polling here (see fetchConfig() in main.cpp), but this check is
// a second line of defense in case a device is running stale firmware or
// missed a config refresh.
export async function getPendingSMS(req: Request, res: Response): Promise<void> {
  const kioskId = Number(req.query.kiosk_id ?? 1);
  try {
    const config = await getConfig(kioskId);
    if (!config.enabled) {
      res.json([]);
      return;
    }

    const [rows]: any = await (pool as any).query(
      `SELECT id, phone_number, message, created_at
         FROM sms_queue
        WHERE status = 'pending' AND kiosk_id = ?
        ORDER BY created_at ASC LIMIT 10`,
      [kioskId],
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'DB error' });
  }
}

// Called by the bridge after a successful serial send.
export async function ackSMS(req: Request, res: Response): Promise<void> {
  try {
    await (pool as any).query(
      `UPDATE sms_queue SET status = 'sent', sent_at = NOW() WHERE id = ?`,
      [req.params.id],
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'DB error' });
  }
}

// Called by the bridge after a failed serial send.
export async function failSMS(req: Request, res: Response): Promise<void> {
  try {
    await (pool as any).query(
      `UPDATE sms_queue SET status = 'failed', error_message = ?, failed_at = NOW() WHERE id = ?`,
      [req.body.error_message ?? 'Unknown', req.params.id],
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'DB error' });
  }
}

export async function getSMSLogs(req: Request, res: Response): Promise<void> {
  try {
    const [rows]: any = await (pool as any).query(
      `SELECT id, phone_number, message, status, kiosk_id,
              created_at, sent_at, failed_at, error_message
         FROM sms_queue ORDER BY created_at DESC LIMIT 100`,
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'DB error' });
  }
}

export async function retrySMS(req: Request, res: Response): Promise<void> {
  try {
    await (pool as any).query(
      `UPDATE sms_queue SET status = 'pending', error_message = NULL WHERE id = ?`,
      [req.params.id],
    );
    processNext().catch(() => {});
    res.json({ ok: true, message: 'Queued for retry' });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'DB error' });
  }
}

export async function gsmStatus(_req: Request, res: Response): Promise<void> {
  const [rows]: any = await (pool as any).query(
    `SELECT status, COUNT(*) as count FROM sms_queue GROUP BY status`,
  ).catch(() => [[]]);

  res.json({
    gsmReady: isGSMReady(),
    port:     process.env.GSM_PORT    ?? 'COM3',
    enabled:  process.env.GSM_ENABLED === 'true',
    queue:    rows,
  });
}

/* ── Route handlers: plugin config (bridge-facing + admin-facing) ────────── */

// GET /api/gsm/config?kiosk_id=1
// Called by the ESP32 bridge on boot and every CONFIG_FETCH_INTERVAL_MS.
export async function getGSMConfig(req: Request, res: Response): Promise<void> {
  const kioskId = Number(req.query.kiosk_id ?? 1);
  try {
    const config = await getConfig(kioskId);
    res.json({ enabled: config.enabled, pollIntervalMs: config.pollIntervalMs });
  } catch (err: any) {
    // Fail-open with sane defaults rather than a 500 with no body — the
    // ESP32's fetchConfig() already keeps its previous settings on any
    // non-200, but a well-formed fallback body costs nothing extra here.
    res.status(500).json({ error: err.message ?? 'DB error' });
  }
}

// PUT /api/gsm/config?kiosk_id=1   body: { enabled?, pollIntervalMs? }
// Called from an admin panel/route to turn a kiosk's bridge on/off or
// retune its poll rate. Values are clamped in gsmConfigService.
export async function updateGSMConfig(req: Request, res: Response): Promise<void> {
  const kioskId = Number(req.query.kiosk_id ?? req.body.kiosk_id ?? 1);
  try {
    const { enabled, pollIntervalMs } = req.body ?? {};
    const config = await updateConfig(kioskId, { enabled, pollIntervalMs });
    res.json({ ok: true, config });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'DB error' });
  }
}