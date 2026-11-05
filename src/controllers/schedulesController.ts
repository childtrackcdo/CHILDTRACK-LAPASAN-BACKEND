import { Request, Response } from 'express';
import pool from '../../lib/db';
import { AuthRequest } from '../../middleware/authMiddleware';

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_DAYS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

// ─── GET /api/schedules ───────────────────────────────────────────────────────
// Query params: day_of_week, section, grade_level, subject, teacher_id
export async function getSchedules(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { day_of_week, section, grade_level, subject } =
      req.query as Record<string, string>;

    let sql = `
      SELECT *
      FROM student_schedules
      WHERE teacher_id = ?
    `;
    const params: any[] = [teacherId];

    if (day_of_week) { sql += ' AND day_of_week = ?';        params.push(day_of_week); }
    if (section)     { sql += ' AND section LIKE ?';         params.push(`%${section}%`); }
    if (grade_level) { sql += ' AND grade_level = ?';        params.push(grade_level); }
    if (subject)     { sql += ' AND subject LIKE ?';    params.push(`%${subject}%`); }

    sql += `
      ORDER BY
        CASE day_of_week
          WHEN 'Monday'    THEN 1
          WHEN 'Tuesday'   THEN 2
          WHEN 'Wednesday' THEN 3
          WHEN 'Thursday'  THEN 4
          WHEN 'Friday'    THEN 5
          WHEN 'Saturday'  THEN 6
          ELSE 7
        END,
        start_time
    `;

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('getSchedules error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/schedules/:id ───────────────────────────────────────────────────
export async function getScheduleById(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { id }    = req.params;

    const [rows] = await pool.execute(
      'SELECT * FROM student_schedules WHERE id = ? AND teacher_id = ?',
      [id, teacherId],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }

    res.json((rows as any[])[0]);
  } catch (err: any) {
    console.error('getScheduleById error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── POST /api/schedules ──────────────────────────────────────────────────────
export async function createSchedule(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const {
      subject,
      day_of_week,
      start_time,
      end_time,
      room,
      section,
      grade_level,
      strand,
    } = req.body;

    if (!subject || !day_of_week || !start_time || !end_time) {
      res.status(400).json({
        error: 'subject, day_of_week, start_time, and end_time are required',
      });
      return;
    }

    if (!(VALID_DAYS as readonly string[]).includes(day_of_week)) {
      res.status(400).json({ error: `day_of_week must be one of: ${VALID_DAYS.join(', ')}` });
      return;
    }

    // Detect time conflicts for the same teacher/day
    const [conflicts] = await pool.execute(
      `SELECT id FROM student_schedules
       WHERE teacher_id = ?
         AND day_of_week = ?
         AND section = ?
         AND (
           (start_time < ? AND end_time > ?)
           OR (start_time < ? AND end_time > ?)
           OR (start_time >= ? AND end_time <= ?)
         )`,
      [
        teacherId, day_of_week, section || null,
        end_time,   start_time,
        end_time,   start_time,
        start_time, end_time,
      ],
    ) as any[];

    if ((conflicts as any[]).length > 0) {
      res.status(409).json({ error: 'Schedule conflict: another subject occupies that time slot' });
      return;
    }

    const [result] = await pool.execute(
      `INSERT INTO student_schedules
   (teacher_id, subject, day_of_week, start_time, end_time,
    room, section, grade_level)
 VALUES (?,?,?,?,?,?,?,?)`,
[
  teacherId, subject, day_of_week, start_time, end_time,
  room || null, section || null, grade_level || null,
],
    ) as any[];

    res.status(201).json({
      id:      (result as any).insertId,
      message: 'Schedule created successfully',
    });
  } catch (err: any) {
    console.error('createSchedule error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/schedules/:id ─────────────────────────────────────────────────
export async function updateSchedule(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { id }    = req.params;
    const {
      subject,
      day_of_week,
      start_time,
      end_time,
      room,
      section,
      grade_level,
      strand,
    } = req.body;

    if (day_of_week && !(VALID_DAYS as readonly string[]).includes(day_of_week)) {
      res.status(400).json({ error: `day_of_week must be one of: ${VALID_DAYS.join(', ')}` });
      return;
    }

    const fields: string[] = [];
    const values: any[]    = [];

    if (subject !== undefined) { fields.push('subject = ?'); values.push(subject); }
    if (day_of_week  !== undefined) { fields.push('day_of_week = ?');  values.push(day_of_week); }
    if (start_time   !== undefined) { fields.push('start_time = ?');   values.push(start_time); }
    if (end_time     !== undefined) { fields.push('end_time = ?');     values.push(end_time); }
    if (room         !== undefined) { fields.push('room = ?');         values.push(room || null); }
    if (section      !== undefined) { fields.push('section = ?');      values.push(section || null); }
    if (grade_level  !== undefined) { fields.push('grade_level = ?');  values.push(grade_level || null); }
    if (strand       !== undefined) { fields.push('strand = ?');       values.push(strand || null); }

    if (!fields.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(id, teacherId);

    const [result] = await pool.execute(
      `UPDATE student_schedules SET ${fields.join(', ')} WHERE id = ? AND teacher_id = ?`,
      values,
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Schedule not found or not yours' });
      return;
    }

    res.json({ message: 'Schedule updated successfully' });
  } catch (err: any) {
    console.error('updateSchedule error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── DELETE /api/schedules/:id ────────────────────────────────────────────────
export async function deleteSchedule(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { id }    = req.params;

    const [result] = await pool.execute(
      'DELETE FROM student_schedules WHERE id = ? AND teacher_id = ?',
      [id, teacherId],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Schedule not found or not yours' });
      return;
    }

    res.json({ message: 'Schedule deleted successfully' });
  } catch (err: any) {
    console.error('deleteSchedule error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/schedules/weekly ────────────────────────────────────────────────
// Returns schedules grouped by day — convenient for a weekly timetable view.
export async function getWeeklySchedule(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { section, grade_level } = req.query as Record<string, string>;

    let sql = `
      SELECT *
      FROM student_schedules
      WHERE teacher_id = ?
    `;
    const params: any[] = [teacherId];

    if (section)     { sql += ' AND section LIKE ?';  params.push(`%${section}%`); }
    if (grade_level) { sql += ' AND grade_level = ?'; params.push(grade_level); }

    sql += ' ORDER BY start_time';

    const [rows] = await pool.execute(sql, params) as any[];

    // Group by day
    const weekly: Record<string, any[]> = {
      Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [],
    };

    for (const row of rows as any[]) {
      if (weekly[row.day_of_week]) {
        weekly[row.day_of_week].push(row);
      }
    }

    res.json({
      teacher_id:  teacherId,
      section:     section     || null,
      grade_level: grade_level || null,
      weekly,
    });
  } catch (err: any) {
    console.error('getWeeklySchedule error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/student-schedules (parent-facing) ───────────────────────────────
// Called by the parent app with an explicit teacher_id query param + parent JWT.
// Unlike getSchedules, this does NOT require req.teacher — parents aren't teachers.
export async function getSchedulesForParent(req: Request, res: Response): Promise<void> {
  try {
    const { teacher_id, day_of_week, section, grade_level, subject } =
      req.query as Record<string, string>;

    if (!teacher_id) {
      res.status(400).json({ error: 'teacher_id is required' });
      return;
    }

    let sql = `
      SELECT *
      FROM student_schedules
      WHERE teacher_id = ?
    `;
    const params: any[] = [teacher_id];

    if (day_of_week) { sql += ' AND day_of_week = ?';   params.push(day_of_week); }
    if (section)     { sql += ' AND section LIKE ?';    params.push(`%${section}%`); }
    if (grade_level) { sql += ' AND grade_level = ?';   params.push(grade_level); }
    if (subject)     { sql += ' AND subject LIKE ?';    params.push(`%${subject}%`); }

    sql += `
      ORDER BY
        CASE day_of_week
          WHEN 'Monday'    THEN 1
          WHEN 'Tuesday'   THEN 2
          WHEN 'Wednesday' THEN 3
          WHEN 'Thursday'  THEN 4
          WHEN 'Friday'    THEN 5
          WHEN 'Saturday'  THEN 6
          ELSE 7
        END,
        start_time
    `;

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('getSchedulesForParent error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}