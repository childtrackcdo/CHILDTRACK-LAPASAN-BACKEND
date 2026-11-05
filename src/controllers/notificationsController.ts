import { Request, Response } from 'express';
import pool from '../../lib/db';

// GET /api/notifications
export async function getNotifications(req: any, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher?.id;
    console.log('[notif] teacher payload =', req.teacher);
    console.log('[notif] teacherId =', teacherId);
    if (!teacherId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const [rows]: any = await pool.query(
      `SELECT * FROM notifications
       WHERE teacher_id = ?
       ORDER BY created_at DESC
       LIMIT 200`,
      [teacherId],
    );
    res.json({ data: rows });
  } catch (err: any) {
    console.error('[getNotifications]', err);
    res.status(500).json({ error: err.message });
  }
}

// Alias — route file uses both names
export const getAllNotifications        = getNotifications;
export const getPersistentNotifications = getNotifications;

// GET /api/notifications/summary
export async function getNotificationsSummary(req: any, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher?.id;
    if (!teacherId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const [rows]: any = await pool.query(
      `SELECT
         COUNT(*)               AS total,
         SUM(is_read = 0)       AS unread,
         SUM(type = 'present')  AS present,
         SUM(type = 'absent')   AS absent,
         SUM(type = 'late')     AS late,
         SUM(type = 'pickup')   AS pickup,
         SUM(type = 'dropoff')  AS dropoff
       FROM notifications
       WHERE teacher_id = ?`,
      [teacherId],
    );
    res.json(rows[0]);
  } catch (err: any) {
    console.error('[getNotificationsSummary]', err);
    res.status(500).json({ error: err.message });
  }
}

// GET /api/notifications/persistent/unread-count
export async function getUnreadCount(req: any, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher?.id;
    if (!teacherId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const [rows]: any = await pool.query(
      'SELECT COUNT(*) AS unread FROM notifications WHERE teacher_id = ? AND is_read = 0',
      [teacherId],
    );
    res.json({ unread: rows[0].unread });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// PATCH /api/notifications/persistent/read-all
export async function markAllNotificationsRead(req: any, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher?.id;
    if (!teacherId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    await pool.query(
      'UPDATE notifications SET is_read = 1 WHERE teacher_id = ? AND is_read = 0',
      [teacherId],
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// PATCH /api/notifications/persistent/:id/read
export async function markNotificationRead(req: any, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher?.id;
    if (!teacherId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    await pool.query(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND teacher_id = ?',
      [req.params.id, teacherId],
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// DELETE /api/notifications/:id
export async function deleteNotification(req: any, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher?.id;
    if (!teacherId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    await pool.query(
      'DELETE FROM notifications WHERE id = ? AND teacher_id = ?',
      [req.params.id, teacherId],
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// DELETE /api/notifications  (clear all read)
export async function clearReadNotifications(req: any, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher?.id;
    if (!teacherId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    await pool.query(
      'DELETE FROM notifications WHERE teacher_id = ? AND is_read = 1',
      [teacherId],
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/notifications/test
// Fires a real notification row for the logged-in teacher so the UI (list,
// unread badge, chime, stat cards) can be verified end-to-end without
// needing an actual kiosk scan. Body: { type?: 'present'|'late'|'absent'|'pickup'|'dropoff'|'info' }
const TEST_TYPES = ['present', 'late', 'absent', 'pickup', 'dropoff', 'info'] as const;
const TEST_LABELS: Record<string, string> = {
  present: 'Present', late: 'Late', absent: 'Absent',
  pickup: 'Pick-Up', dropoff: 'Drop-Off', info: 'Info',
};

export async function sendTestNotification(req: any, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher?.id;
    if (!teacherId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const requested = String(req.body?.type ?? 'present').trim().toLowerCase();
    const type = (TEST_TYPES as readonly string[]).includes(requested) ? requested : 'present';
    const label = TEST_LABELS[type];
    const stamp = new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true });

    const body = `[TEST] Sample Student marked as ${label} · Test Section (sent ${stamp})`;

    const [result]: any = await pool.query(
      'INSERT INTO notifications (teacher_id, type, body, is_read) VALUES (?, ?, ?, 0)',
      [teacherId, type, body],
    );

    res.json({ ok: true, id: result.insertId, type });
  } catch (err: any) {
    console.error('[sendTestNotification]', err);
    res.status(500).json({ error: err.message });
  }
}