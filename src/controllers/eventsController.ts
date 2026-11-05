import { Request, Response } from 'express';
import pool from '../../lib/db';
import { AuthRequest } from '../../middleware/authMiddleware';
import { notifyParentsNewEvent } from './parentNotificationControllers';

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_EVENT_TYPES = [
  'Meeting', 'Conference', 'School Event', 'Reminder',
  'Holiday', 'Other', 'Academic', 'Clearance',
] as const;

// ─── Validation ───────────────────────────────────────────────────────────────

function validateEvent(body: any): string[] {
  const errors: string[] = [];
  if (!body.title?.trim())  errors.push('title is required');
  if (!body.scheduled_at)   errors.push('scheduled_at is required (ISO 8601)');
  if (body.event_type && !(VALID_EVENT_TYPES as readonly string[]).includes(body.event_type))
    errors.push(`event_type must be one of: ${VALID_EVENT_TYPES.join(', ')}`);
  return errors;
}

// ─── GET /api/events ──────────────────────────────────────────────────────────
export async function getAllEvents(req: Request, res: Response): Promise<void> {
  try {
    const { type, upcoming, search } = req.query as Record<string, string>;

    let sql            = 'SELECT * FROM events WHERE 1=1';
    const params: any[] = [];

    if (type)               { sql += ' AND event_type = ?';   params.push(type); }
    if (upcoming === 'true')  sql += ' AND scheduled_at >= NOW()';
    if (upcoming === 'false') sql += ' AND scheduled_at <  NOW()';
    if (search) {
      sql += ' AND (title LIKE ? OR description LIKE ? OR location LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY scheduled_at ASC LIMIT 200';

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('[getAllEvents]', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/events/:id ──────────────────────────────────────────────────────
export async function getEventById(req: Request, res: Response): Promise<void> {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM events WHERE id = ?',
      [req.params.id],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Event not found.' });
      return;
    }

    res.json((rows as any[])[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// ─── POST /api/events ─────────────────────────────────────────────────────────
export async function createEvent(req: AuthRequest, res: Response): Promise<void> {
  const errors = validateEvent(req.body);
  if (errors.length) { res.status(422).json({ error: errors.join('; ') }); return; }

  try {
    const {
      title,
      description  = null,
      event_type   = 'Other',
      scheduled_at,
      location     = null,
      teacher_name = null,
      teacher_id   = null,
    } = req.body;

    const [result] = await pool.execute(
      `INSERT INTO events
         (teacher_id, title, description, event_type, scheduled_at, location, teacher_name)
       VALUES (?,?,?,?,?,?,?)`,
      [teacher_id, title.trim(), description, event_type, scheduled_at, location, teacher_name],
    ) as any[];

    const [rows] = await pool.execute(
      'SELECT * FROM events WHERE id = ?',
      [(result as any).insertId],
    ) as any[];

    const newEvent = (rows as any[])[0];

    // Notify all parents (fire-and-forget)
    notifyParentsNewEvent(
      newEvent.title,
      newEvent.description || '',
      newEvent.scheduled_at,
      newEvent.location,
      newEvent.teacher_name,
    ).catch(console.error);

    res.status(201).json(newEvent);
  } catch (err: any) {
    console.error('[createEvent]', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── PATCH /api/events/:id ────────────────────────────────────────────────────
export async function updateEvent(req: AuthRequest, res: Response): Promise<void> {
  const errors = validateEvent(req.body);
  if (errors.length) { res.status(422).json({ error: errors.join('; ') }); return; }

  try {
    const {
      title,
      description  = null,
      event_type   = 'Other',
      scheduled_at,
      location     = null,
      teacher_name = null,
      teacher_id   = null,
    } = req.body;

    const [result] = await pool.execute(
      `UPDATE events
       SET teacher_id=?, title=?, description=?, event_type=?,
           scheduled_at=?, location=?, teacher_name=?
       WHERE id=?`,
      [
        teacher_id, title.trim(), description, event_type,
        scheduled_at, location, teacher_name,
        req.params.id,
      ],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Event not found.' });
      return;
    }

    const [rows] = await pool.execute(
      'SELECT * FROM events WHERE id = ?',
      [req.params.id],
    ) as any[];

    res.json((rows as any[])[0]);
  } catch (err: any) {
    console.error('[updateEvent]', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── DELETE /api/events/:id ───────────────────────────────────────────────────
export async function deleteEvent(req: AuthRequest, res: Response): Promise<void> {
  try {
    const [result] = await pool.execute(
      'DELETE FROM events WHERE id = ?',
      [req.params.id],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Event not found.' });
      return;
    }

    res.json({ message: 'Event deleted.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}