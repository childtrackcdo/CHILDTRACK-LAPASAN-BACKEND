import { Request, Response } from 'express';
import pool from '../../lib/db';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Expo } = require('expo-server-sdk');
type ExpoPushMessage = any;

const expo = new Expo();

// ─── GET /api/parent-notifications ───────────────────────────────────────────
export async function getParentNotifications(req: Request, res: Response): Promise<void> {
  try {
    const { student_name, lrn, is_read, limit } =
      req.query as Record<string, string>;

    const maxLimit = Math.min(Number(limit) || 100, 500);

    let sql            = 'SELECT * FROM parent_notifications WHERE 1=1';
    const params: any[] = [];

    if (student_name) { sql += ' AND student_name LIKE ?'; params.push(`%${student_name}%`); }
    if (lrn)          { sql += ' AND lrn = ?';            params.push(lrn); }
    if (is_read !== undefined) { sql += ' AND is_read = ?'; params.push(Number(is_read)); }

    sql += ` ORDER BY created_at DESC LIMIT ${maxLimit}`;

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('[getParentNotifications]', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/parent-notifications/:id/read ────────────────────────────────
export async function markParentNotificationRead(req: Request, res: Response): Promise<void> {
  try {
    const [result] = await pool.execute(
      'UPDATE parent_notifications SET is_read = 1 WHERE id = ?',
      [req.params.id],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }

    res.json({ message: 'Marked as read' });
  } catch (err: any) {
    console.error('[markParentNotificationRead]', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/parent-notifications/read-all ────────────────────────────────
export async function markAllParentNotificationsRead(req: Request, res: Response): Promise<void> {
  try {
    const { student_name, lrn } = req.body as { student_name?: string; lrn?: string };

    if (!student_name && !lrn) {
      res.status(400).json({ error: 'student_name or lrn is required' });
      return;
    }

    let sql           = 'UPDATE parent_notifications SET is_read = 1 WHERE is_read = 0';
    const params: any[] = [];

    if (student_name) { sql += ' AND student_name = ?'; params.push(student_name); }
    if (lrn)          { sql += ' AND lrn = ?';          params.push(lrn); }

    const [result] = await pool.execute(sql, params) as any[];

    res.json({ message: 'All marked as read', updated: (result as any).affectedRows });
  } catch (err: any) {
    console.error('[markAllParentNotificationsRead]', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── POST /api/parent-notifications/push-token ───────────────────────────────
export async function saveExpoPushToken(req: Request, res: Response): Promise<void> {
  try {
    const { student_name, lrn, token } = req.body;

    if (!token) {
      res.status(400).json({ error: 'token is required' });
      return;
    }

    if (!Expo.isExpoPushToken(token)) {
      res.status(400).json({ error: 'Invalid Expo push token' });
      return;
    }

    await pool.execute(
      `UPDATE parent_accounts
       SET expo_push_token = ?
       WHERE student_name = ? OR lrn = ?`,
      [token, student_name || '', lrn || ''],
    );

    res.json({ message: 'Token saved' });
  } catch (err: any) {
    console.error('[saveExpoPushToken]', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── Internal: send push notification + persist to parent_notifications ───────
export async function sendPushToParent(
  studentName: string,
  title: string,
  body: string,
  type: string,
): Promise<void> {
  try {
    const [rows] = await pool.execute(
      'SELECT expo_push_token FROM parent_accounts WHERE student_name LIKE ?',
      [`%${studentName}%`],
    ) as any[];

    // Always persist the notification record
    await pool.execute(
      'INSERT INTO parent_notifications (student_name, title, body, type) VALUES (?,?,?,?)',
      [studentName, title, body, type],
    );

    const tokens = (rows as any[])
      .map((r: any) => r.expo_push_token)
      .filter((t: any) => t && Expo.isExpoPushToken(t));

    if (!tokens.length) return;

    const messages: ExpoPushMessage[] = tokens.map((t: string) => ({
      to:    t,
      sound: 'default',
      title,
      body,
      data:  { type, studentName },
    }));

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (err) {
    console.error('[sendPushToParent]', err);
  }
}

// ─── Internal: notify ALL parents of a new school event ──────────────────────
export async function notifyParentsNewEvent(
  title: string,
  description: string,
  scheduled_at: string | null,
  location: string | null,
  teacher_name: string | null,
): Promise<void> {
  try {
    const dateStr     = scheduled_at
      ? new Date(scheduled_at).toLocaleString('en-PH', {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : '';
    const locationStr = location ? ` — 📍 ${location}` : '';
    const notifTitle  = `📢 New Event: ${title}${locationStr}`;
    const notifBody   = [
      description,
      dateStr      ? `🗓 ${dateStr}`      : '',
      teacher_name ? `by ${teacher_name}` : '',
    ].filter(Boolean).join(' | ');

    const [parents] = await pool.execute(
      `SELECT DISTINCT student_name, expo_push_token
       FROM parent_accounts
       WHERE student_name IS NOT NULL`,
    ) as any[];

    const pushMessages: ExpoPushMessage[] = [];

    for (const parent of parents as any[]) {
      await pool.execute(
        'INSERT INTO parent_notifications (student_name, title, body, type) VALUES (?,?,?,?)',
        [parent.student_name, notifTitle, notifBody, 'new_event'],
      );

      if (parent.expo_push_token && Expo.isExpoPushToken(parent.expo_push_token)) {
        pushMessages.push({
          to:    parent.expo_push_token,
          sound: 'default',
          title: notifTitle,
          body:  notifBody,
          data:  { type: 'new_event' },
        });
      }
    }

    if (pushMessages.length) {
      const chunks = expo.chunkPushNotifications(pushMessages);
      for (const chunk of chunks) {
        await expo.sendPushNotificationsAsync(chunk);
      }
    }
  } catch (err) {
    console.error('[notifyParentsNewEvent]', err);
  }
}