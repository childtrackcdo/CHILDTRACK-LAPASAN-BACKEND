import { Response } from 'express';
import pool from '../../lib/db';
import { AuthRequest } from '../../middleware/authMiddleware';

const VALID_DAYS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

// ─── GET /api/admin/schedules ─────────────────────────────────────────────────
// Query params: subject, teacher_id, section, grade_level
export async function adminGetSchedules(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { subject, teacher_id, section, grade_level } = req.query as Record<string, string>;

    let sql = `
      SELECT ss.*, t.name AS teacher_name, t.section AS teacher_advisory
      FROM student_schedules ss
      LEFT JOIN teachers t ON t.id = ss.teacher_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (subject)     { sql += ' AND ss.subject = ?';     params.push(subject); }
    if (teacher_id)  { sql += ' AND ss.teacher_id = ?';  params.push(teacher_id); }
    if (section)     { sql += ' AND ss.section = ?';     params.push(section); }
    if (grade_level) { sql += ' AND ss.grade_level = ?'; params.push(grade_level); }

    sql += `
      ORDER BY
        CASE ss.day_of_week
          WHEN 'Monday'    THEN 1
          WHEN 'Tuesday'   THEN 2
          WHEN 'Wednesday' THEN 3
          WHEN 'Thursday'  THEN 4
          WHEN 'Friday'    THEN 5
          WHEN 'Saturday'  THEN 6
          ELSE 7
        END,
        ss.start_time
    `;

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('adminGetSchedules error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── POST /api/admin/schedules ────────────────────────────────────────────────
export async function adminCreateSchedule(req: AuthRequest, res: Response): Promise<void> {
  try {
    const {
      teacher_id, subject, day_of_week, start_time, end_time,
      room, section, grade_level, strand,
    } = req.body;

    if (!teacher_id || !subject || !day_of_week || !start_time || !end_time || !section) {
      res.status(400).json({
        error: 'teacher_id, subject, day_of_week, start_time, end_time, and section are required',
      });
      return;
    }

    if (!(VALID_DAYS as readonly string[]).includes(day_of_week)) {
      res.status(400).json({ error: `day_of_week must be one of: ${VALID_DAYS.join(', ')}` });
      return;
    }

    // Prevent double-booking the same teacher/section/day/time
    const [conflicts] = await pool.execute(
      `SELECT id FROM student_schedules
       WHERE teacher_id = ? AND day_of_week = ? AND section = ?
         AND (
           (start_time < ? AND end_time > ?)
           OR (start_time < ? AND end_time > ?)
           OR (start_time >= ? AND end_time <= ?)
         )`,
      [
        teacher_id, day_of_week, section,
        end_time,   start_time,
        end_time,   start_time,
        start_time, end_time,
      ],
    ) as any[];

    if ((conflicts as any[]).length > 0) {
      res.status(409).json({ error: 'This teacher already has a class in that time slot for this section.' });
      return;
    }

    const [result] = await pool.execute(
      `INSERT INTO student_schedules
         (teacher_id, subject, day_of_week, start_time, end_time, room, section, grade_level, strand)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        teacher_id, subject, day_of_week, start_time, end_time,
        room || null, section, grade_level || null, strand || null,
      ],
    ) as any[];

    res.status(201).json({ id: (result as any).insertId, message: 'Assignment created.' });
  } catch (err: any) {
    console.error('adminCreateSchedule error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/admin/schedules/:id ───────────────────────────────────────────
export async function adminUpdateSchedule(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const {
      teacher_id, subject, day_of_week, start_time, end_time,
      room, section, grade_level, strand,
    } = req.body;

    if (day_of_week && !(VALID_DAYS as readonly string[]).includes(day_of_week)) {
      res.status(400).json({ error: `day_of_week must be one of: ${VALID_DAYS.join(', ')}` });
      return;
    }

    const fields: string[] = [];
    const values: any[] = [];

    if (teacher_id  !== undefined) { fields.push('teacher_id = ?');  values.push(teacher_id); }
    if (subject     !== undefined) { fields.push('subject = ?');     values.push(subject); }
    if (day_of_week !== undefined) { fields.push('day_of_week = ?'); values.push(day_of_week); }
    if (start_time  !== undefined) { fields.push('start_time = ?');  values.push(start_time); }
    if (end_time    !== undefined) { fields.push('end_time = ?');    values.push(end_time); }
    if (room        !== undefined) { fields.push('room = ?');        values.push(room || null); }
    if (section     !== undefined) { fields.push('section = ?');     values.push(section || null); }
    if (grade_level !== undefined) { fields.push('grade_level = ?'); values.push(grade_level || null); }
    if (strand      !== undefined) { fields.push('strand = ?');      values.push(strand || null); }

    if (!fields.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(id);
    const [result] = await pool.execute(
      `UPDATE student_schedules SET ${fields.join(', ')} WHERE id = ?`,
      values,
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }

    res.json({ message: 'Assignment updated.' });
  } catch (err: any) {
    console.error('adminUpdateSchedule error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── DELETE /api/admin/schedules/:id ──────────────────────────────────────────
export async function adminDeleteSchedule(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const [result] = await pool.execute(
      'DELETE FROM student_schedules WHERE id = ?', [id],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }

    res.json({ message: 'Assignment deleted.' });
  } catch (err: any) {
    console.error('adminDeleteSchedule error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}