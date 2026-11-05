// src/routes/alertsRoutes.ts
//
// Polling-based emergency alert state. No sockets — every client GETs
// /status periodically; when it sees a fresh alert_code it starts ringing.
// alert_code: 0 = none, 1 = earthquake, 2 = lockdown, 3 = active shooter
//
// Elapsed time is computed entirely in MySQL (UNIX_TIMESTAMP / TIMESTAMPDIFF)
// so there's no risk of a mismatch between the DB server's timezone and the
// Node process's timezone — the client only ever sees epoch milliseconds.

import { Router, Request, Response } from 'express';
import { dbQuery, dbExecute } from '../../lib/db';
// ⚠️ Adjust this import to your real student-JWT middleware. It must reject
// invalid tokens and attach the student to the request (req.student or req.user).
import { authenticateStudent } from '../../middleware/studentAuth';

const router = Router();
const ALERT_DURATION_MS = 2 * 60 * 1000; // must match frontend ALERT_DURATION_MS
const STUDENT_COOLDOWN_MS = 5 * 60 * 1000; // per-student cooldown between sends

// student key -> last time that student sent an alert (in-memory; resets on restart)
const lastStudentTrigger = new Map<string, number>();

interface AlertStatusRow {
  alert_code: number;
  triggered_by: string | null;
  triggered_at_ms: number | null;
  seconds_elapsed: number | null;
}

interface AlertActiveRow {
  alert_code: number;
  seconds_elapsed: number | null;
}

async function isAlertActive(): Promise<boolean> {
  const rows = await dbQuery<AlertActiveRow>(
    `SELECT alert_code, TIMESTAMPDIFF(SECOND, triggered_at, NOW()) AS seconds_elapsed
     FROM emergency_alert
     WHERE id = 1`,
  );
  const row = rows[0];
  if (!row || row.alert_code === 0 || row.seconds_elapsed == null) return false;
  return row.seconds_elapsed * 1000 <= ALERT_DURATION_MS;
}

// POST /api/alerts/trigger  { code: 1 | 2 | 3, triggeredBy?: string }
// Staff (web) trigger.
router.post('/trigger', async (req: Request, res: Response) => {
  const { code, triggeredBy } = req.body ?? {};

  if (code !== 1 && code !== 2 && code !== 3) {
    res.status(400).json({ error: 'code must be 1 (earthquake), 2 (lockdown) or 3 (active shooter)' });
    return;
  }

  try {
    await dbExecute(
      'UPDATE emergency_alert SET alert_code = ?, triggered_at = NOW(), triggered_by = ? WHERE id = 1',
      [code, triggeredBy ?? null],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[alerts] trigger failed:', err);
    res.status(500).json({ error: 'Failed to trigger alert' });
  }
});

// POST /api/alerts/student-trigger — students can ONLY send code 3.
// Requires a valid student token. Refuses while another alert is active and
// enforces a per-student cooldown so it can't be spammed.
router.post('/student-trigger', authenticateStudent, async (req: Request, res: Response) => {
  const student = (req as any).student ?? (req as any).user;
  const studentKey = student?.id != null ? String(student.id) : student?.lrn ? String(student.lrn) : null;

  if (!studentKey) {
    res.status(401).json({ error: 'Student not identified' });
    return;
  }

  const now = Date.now();
  const last = lastStudentTrigger.get(studentKey);
  if (last && now - last < STUDENT_COOLDOWN_MS) {
    const waitSec = Math.ceil((STUDENT_COOLDOWN_MS - (now - last)) / 1000);
    res.status(429).json({ error: `You already sent an alert recently. Try again in ${waitSec}s.` });
    return;
  }

  try {
    if (await isAlertActive()) {
      res.status(409).json({ error: 'An alert is already active.' });
      return;
    }

    const name = student?.name ? String(student.name) : 'Student';
    await dbExecute(
      'UPDATE emergency_alert SET alert_code = 3, triggered_at = NOW(), triggered_by = ? WHERE id = 1',
      [`${name} (Student)`],
    );
    lastStudentTrigger.set(studentKey, now);
    console.warn(`[alerts] STUDENT ACTIVE-SHOOTER ALERT by ${name} (key=${studentKey})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[alerts] student-trigger failed:', err);
    res.status(500).json({ error: 'Failed to send alert' });
  }
});

// POST /api/alerts/stop — cancels early for everyone (staff only, students have no stop)
router.post('/stop', async (_req: Request, res: Response) => {
  try {
    await dbExecute(
      'UPDATE emergency_alert SET alert_code = 0, triggered_at = NULL, triggered_by = NULL WHERE id = 1',
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[alerts] stop failed:', err);
    res.status(500).json({ error: 'Failed to stop alert' });
  }
});

// GET /api/alerts/status — polled by every connected client every few seconds
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const rows = await dbQuery<AlertStatusRow>(
      `SELECT
         alert_code,
         triggered_by,
         UNIX_TIMESTAMP(triggered_at) * 1000 AS triggered_at_ms,
         TIMESTAMPDIFF(SECOND, triggered_at, NOW()) AS seconds_elapsed
       FROM emergency_alert
       WHERE id = 1`,
    );

    const row = rows[0] ?? { alert_code: 0, triggered_by: null, triggered_at_ms: null, seconds_elapsed: null };

    let code = row.alert_code;
    const elapsedMs = row.seconds_elapsed != null ? row.seconds_elapsed * 1000 : null;
    if (code !== 0 && (elapsedMs === null || elapsedMs > ALERT_DURATION_MS)) {
      code = 0; // stale row — treat as no active alert
    }

    res.json({
      code,
      triggered_at: row.triggered_at_ms,
      triggered_by: row.triggered_by,
    });
  } catch (err) {
    console.error('[alerts] status failed:', err);
    res.status(500).json({ error: 'Failed to read alert status' });
  }
});

export default router;