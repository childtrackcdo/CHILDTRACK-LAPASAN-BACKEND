import { Request, Response } from 'express';
import pool from '../../lib/db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const query = async <T = RowDataPacket[]>(sql: string, params: any[] = []): Promise<T> => {
  const [rows] = await pool.query(sql, params);
  return rows as T;
};

const norm = (s: string) => s?.toLowerCase().replace(/[-_\s]/g, '') ?? '';

const getPHDateStr = (): string => {
  const now      = new Date();
  const phOffset = 8 * 60;
  const ph       = new Date(now.getTime() + (phOffset - now.getTimezoneOffset()) * 60_000);
  return ph.toISOString().slice(0, 10);
};

// ─── POST /api/principal/login ────────────────────────────────────────────────
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body as { username: string; password: string };

    if (!username || !password) {
      res.status(400).json({ message: 'Username and password are required.' });
      return;
    }

    const rows = await query<RowDataPacket[]>(
      'SELECT id,name,username,password,email,contact,photo FROM principals WHERE username=? LIMIT 1',
      [username],
    );

    if (!rows.length) { res.status(401).json({ message: 'Invalid credentials.' }); return; }

    const principal = rows[0];
    const match     = await bcrypt.compare(password, principal.password as string);
    if (!match)     { res.status(401).json({ message: 'Invalid credentials.' }); return; }

    const token = jwt.sign(
      { id: principal.id, name: principal.name, role: 'principal' },
      process.env.JWT_SECRET as string,
      { expiresIn: '8h' } as jwt.SignOptions,
    );

    res.json({
      token,
      principal: {
        id:       principal.id,
        name:     principal.name,
        username: principal.username,
        email:    principal.email,
        contact:  principal.contact,
        photo:    principal.photo,
      },
    });
  } catch (err) {
    console.error('[principal] login:', err);
    res.status(500).json({ message: 'Login failed.' });
  }
};

// ─── GET /api/principal/profile ───────────────────────────────────────────────
export const getProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const principalId = (req as any).principal?.id;
    if (!principalId) { res.status(401).json({ message: 'Unauthorized.' }); return; }

    const rows = await query<RowDataPacket[]>(
      'SELECT id,name,username,email,contact,photo FROM principals WHERE id=? LIMIT 1',
      [principalId],
    );

    if (!rows.length) { res.status(404).json({ message: 'Principal not found.' }); return; }
    res.json(rows[0]);
  } catch (err) {
    console.error('[principal] getProfile:', err);
    res.status(500).json({ message: 'Failed to fetch profile.' });
  }
};

// ─── PUT /api/principal/profile ───────────────────────────────────────────────
export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const principalId = (req as any).principal?.id;
    if (!principalId) { res.status(401).json({ message: 'Unauthorized.' }); return; }

    const { name, username, photo } = req.body as {
      name?: string; username?: string; photo?: string;
    };

    if (username) {
      const existing = await query<RowDataPacket[]>(
        'SELECT id FROM principals WHERE username=? AND id!=? LIMIT 1',
        [username, principalId],
      );
      if (existing.length) { res.status(409).json({ message: 'Username already taken.' }); return; }
    }

    const fields: string[] = [];
    const params: any[]    = [];

    if (name     !== undefined) { fields.push('name = ?');     params.push(name); }
    if (username !== undefined) { fields.push('username = ?'); params.push(username); }
    if (photo    !== undefined) { fields.push('photo = ?');    params.push(photo || null); }

    if (!fields.length) { res.status(400).json({ message: 'Nothing to update.' }); return; }

    params.push(principalId);
    await query(`UPDATE principals SET ${fields.join(', ')} WHERE id = ?`, params);

    const updated = await query<RowDataPacket[]>(
      'SELECT id,name,username,email,contact,photo FROM principals WHERE id=? LIMIT 1',
      [principalId],
    );
    res.json({ message: 'Profile updated.', principal: updated[0] });
  } catch (err) {
    console.error('[principal] updateProfile:', err);
    res.status(500).json({ message: 'Failed to update profile.' });
  }
};

// ─── PUT /api/principal/change-password ──────────────────────────────────────
export const changePassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const principalId = (req as any).principal?.id;
    if (!principalId) { res.status(401).json({ message: 'Unauthorized.' }); return; }

    const { currentPassword, newPassword } = req.body as {
      currentPassword: string; newPassword: string;
    };

    if (!currentPassword || !newPassword) {
      res.status(400).json({ message: 'currentPassword and newPassword are required.' });
      return;
    }
    if (String(newPassword).length < 6) {
      res.status(400).json({ message: 'New password must be at least 6 characters.' });
      return;
    }

    const rows = await query<RowDataPacket[]>(
      'SELECT password FROM principals WHERE id=? LIMIT 1',
      [principalId],
    );
    if (!rows.length) { res.status(404).json({ message: 'Principal not found.' }); return; }

    const match = await bcrypt.compare(currentPassword, rows[0].password as string);
    if (!match) { res.status(401).json({ message: 'Current password is incorrect.' }); return; }

    const hashed = await bcrypt.hash(newPassword, 10);
    await query('UPDATE principals SET password = ? WHERE id = ?', [hashed, principalId]);

    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    console.error('[principal] changePassword:', err);
    res.status(500).json({ message: 'Failed to change password.' });
  }
};

// ─── GET /api/principal/overview ─────────────────────────────────────────────
export const getOverview = async (_req: Request, res: Response): Promise<void> => {
  try {
    const today = getPHDateStr();

    const [teachers, students, todayAtt, enrollStats] = await Promise.all([
      query<RowDataPacket[]>(
        'SELECT id, name, section, grade_level, strand FROM teachers ORDER BY grade_level, section',
      ),
      query<RowDataPacket[]>(
        'SELECT id, teacher_id, grade_level, strand, enrollment_status FROM students',
      ),
      query<RowDataPacket[]>(
        'SELECT status, teacher_id, grade_level FROM attendance WHERE date = ?',
        [today],
      ),
      query<RowDataPacket[]>(
        `SELECT grade_level, strand, COUNT(*) AS count, enrollment_status
         FROM students
         GROUP BY grade_level, strand, enrollment_status`,
      ),
    ]);

    const sections = teachers.map(t => {
      const sectionStudents = students.filter((s: any) => s.teacher_id === t.id);
      const att             = todayAtt.filter((r: any) => r.teacher_id === t.id);
      return {
        teacher_id:   t.id,
        teacher_name: t.name,
        section:      t.section,
        grade_level:  t.grade_level,
        strand:       t.strand,
        total:        sectionStudents.length,
        present:  att.filter((r: any) => norm(r.status) === 'present').length,
        absent:   att.filter((r: any) => norm(r.status) === 'absent').length,
        late:     att.filter((r: any) => norm(r.status) === 'late').length,
        dropoff:  att.filter((r: any) => ['dropoff', 'drop-off'].includes(norm(r.status))).length,
        pickup:   att.filter((r: any) => ['pickup',  'pick-up'].includes(norm(r.status))).length,
      };
    });

    const gradeCount: Record<number, number> = {};
    for (const s of students as any[]) {
      if (s.enrollment_status === 'enrolled' && s.grade_level) {
        gradeCount[s.grade_level] = (gradeCount[s.grade_level] || 0) + 1;
      }
    }

    const totals = {
      totalStudents: students.filter((s: any) => s.enrollment_status === 'enrolled').length,
      totalTeachers: teachers.length,
      present:  todayAtt.filter((r: any) => norm(r.status) === 'present').length,
      absent:   todayAtt.filter((r: any) => norm(r.status) === 'absent').length,
      late:     todayAtt.filter((r: any) => norm(r.status) === 'late').length,
      date:     today,
      grade_count: gradeCount,
    };

    res.json({ totals, sections, enroll_stats: enrollStats });
  } catch (err) {
    console.error('[principal] getOverview:', err);
    res.status(500).json({ message: 'Failed to fetch overview.' });
  }
};

// ─── GET /api/principal/attendance ───────────────────────────────────────────
export const getAllAttendance = async (req: Request, res: Response): Promise<void> => {
  try {
    const { date, status, teacher_id, section, grade_level, subject, search } =
      req.query as Record<string, string>;

    let sql = `
      SELECT a.*, t.name AS teacher_name, t.section AS teacher_section,
             t.grade_level AS teacher_grade
      FROM attendance a
      LEFT JOIN teachers t ON t.id = a.teacher_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (date)        { sql += ' AND a.date = ?';                params.push(date); }
    if (status)      { sql += ' AND LOWER(a.status) LIKE ?';   params.push(`%${status.toLowerCase()}%`); }
    if (teacher_id)  { sql += ' AND a.teacher_id = ?';          params.push(teacher_id); }
    if (section)     { sql += ' AND t.section LIKE ?';          params.push(`%${section}%`); }
    if (grade_level) { sql += ' AND a.grade_level = ?';         params.push(grade_level); }
    if (subject)     { sql += ' AND a.subject LIKE ?';          params.push(`%${subject}%`); }
    if (search) {
      sql += ' AND (a.student_name LIKE ? OR a.lrn LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY a.date DESC, a.timestamp DESC';

    const rows = await query<RowDataPacket[]>(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('[principal] getAllAttendance:', err);
    res.status(500).json({ message: 'Failed to fetch attendance.' });
  }
};

// ─── GET /api/principal/enrollments ──────────────────────────────────────────
export const getAllEnrollments = async (req: Request, res: Response): Promise<void> => {
  try {
    const { sy, grade_level, strand, status, search } =
      req.query as Record<string, string>;

    let sql = `
      SELECT e.*, s.name AS student_name, s.gender, s.address,
             t.name AS encoded_by_name, t.section AS teacher_section
      FROM enrollments e
      JOIN students s ON s.id = e.student_id
      LEFT JOIN teachers t ON t.id = e.encoded_by
      WHERE 1=1
    `;
    const params: any[] = [];

    if (sy)          { sql += ' AND e.school_year = ?'; params.push(sy); }
    if (grade_level) { sql += ' AND e.grade_level = ?'; params.push(grade_level); }
    if (strand)      { sql += ' AND e.strand = ?';      params.push(strand); }
    if (status)      { sql += ' AND e.status = ?';      params.push(status); }
    if (search) {
      sql += ' AND (s.name LIKE ? OR e.lrn LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY e.enrolled_at DESC';

    const rows = await query<RowDataPacket[]>(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('[principal] getAllEnrollments:', err);
    res.status(500).json({ message: 'Failed to fetch enrollments.' });
  }
};

// ─── PATCH /api/principal/enrollments/:id/status ─────────────────────────────
export const updateEnrollmentStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id }     = req.params;
    const { status } = req.body as { status: string };

    const allowed = ['approved', 'pending', 'rejected'];
    if (!allowed.includes(status)) {
      res.status(400).json({ message: 'Invalid status.' });
      return;
    }

    await query('UPDATE enrollments SET status=? WHERE id=?', [status, id]);

    if (status === 'approved') {
      await query(
        `UPDATE students SET enrollment_status='enrolled'
         WHERE id = (SELECT student_id FROM enrollments WHERE id=?)`,
        [id],
      );
    }

    if (status === 'rejected') {
      await query(
        `UPDATE students SET enrollment_status='pending'
         WHERE id = (SELECT student_id FROM enrollments WHERE id=?)`,
        [id],
      );
    }

    res.json({ message: 'Status updated.', id: Number(id), status });
  } catch (err) {
    console.error('[principal] updateEnrollmentStatus:', err);
    res.status(500).json({ message: 'Failed to update status.' });
  }
};

// ─── GET /api/principal/teachers ─────────────────────────────────────────────
export const getAllTeachers = async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await query<RowDataPacket[]>(`
      SELECT t.id, t.name, t.username, t.age, t.gender,
             t.section, t.grade_level, t.strand,
             t.contact, t.address, t.created_at, t.photo_base64,
             COUNT(s.id) AS student_count
      FROM teachers t
      LEFT JOIN students s ON s.teacher_id = t.id
      GROUP BY t.id
      ORDER BY t.grade_level, t.section
    `);
    res.json(rows);
  } catch (err) {
    console.error('[principal] getAllTeachers:', err);
    res.status(500).json({ message: 'Failed to fetch teachers.' });
  }
};

// ─── GET /api/principal/students ─────────────────────────────────────────────
export const getAllStudents = async (req: Request, res: Response): Promise<void> => {
  try {
    const { teacher_id, section, grade_level, strand, search, enrollment_status } =
      req.query as Record<string, string>;

    let sql = `
      SELECT s.id, s.lrn, s.name, s.gender, s.grade_level,
             s.section, s.strand, s.track, s.school_year,
             s.enrollment_status, s.created_at,
             t.name AS teacher_name, t.section AS teacher_section
      FROM students s
      LEFT JOIN teachers t ON t.id = s.teacher_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (teacher_id)        { sql += ' AND s.teacher_id = ?';          params.push(teacher_id); }
    if (section)           { sql += ' AND s.section LIKE ?';          params.push(`%${section}%`); }
    if (grade_level)       { sql += ' AND s.grade_level = ?';         params.push(grade_level); }
    if (strand)            { sql += ' AND s.strand = ?';              params.push(strand); }
    if (enrollment_status) { sql += ' AND s.enrollment_status = ?';   params.push(enrollment_status); }
    if (search) {
      sql += ' AND (s.name LIKE ? OR s.lrn LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY s.grade_level, s.name';

    const rows = await query<RowDataPacket[]>(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('[principal] getAllStudents:', err);
    res.status(500).json({ message: 'Failed to fetch students.' });
  }
};

// ─── GET /api/principal/schedules ────────────────────────────────────────────
export const getAllSchedules = async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await query<RowDataPacket[]>(`
      SELECT sc.*, t.section AS teacher_section, t.grade_level AS teacher_grade
      FROM student_schedules sc
      LEFT JOIN teachers t ON t.id = sc.teacher_id
      ORDER BY
        CASE sc.day_of_week
          WHEN 'Monday'    THEN 1
          WHEN 'Tuesday'   THEN 2
          WHEN 'Wednesday' THEN 3
          WHEN 'Thursday'  THEN 4
          WHEN 'Friday'    THEN 5
          WHEN 'Saturday'  THEN 6
          ELSE 7
        END,
        sc.start_time
    `);
    res.json(rows);
  } catch (err) {
    console.error('[principal] getAllSchedules:', err);
    res.status(500).json({ message: 'Failed to fetch schedules.' });
  }
};

// ─── GET /api/principal/absences ─────────────────────────────────────────────
export const getAllAbsences = async (req: Request, res: Response): Promise<void> => {
  try {
    const { status, teacher_id, grade_level, search } =
      req.query as Record<string, string>;

    let sql = `
      SELECT ar.*, t.name AS teacher_name, t.section AS teacher_section,
             t.grade_level AS teacher_grade
      FROM absence_reasons ar
      LEFT JOIN teachers t ON t.id = ar.teacher_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (status)     { sql += ' AND ar.status = ?';     params.push(status); }
    if (teacher_id) { sql += ' AND ar.teacher_id = ?'; params.push(teacher_id); }
    if (grade_level){ sql += ' AND t.grade_level = ?'; params.push(grade_level); }
    if (search) {
      sql += ' AND (ar.student_name LIKE ? OR ar.lrn LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY ar.date DESC, ar.created_at DESC';

    const rows = await query<RowDataPacket[]>(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('[principal] getAllAbsences:', err);
    res.status(500).json({ message: 'Failed to fetch absences.' });
  }
};

// ─── GET /api/principal/events ────────────────────────────────────────────────
export const getAllEvents = async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await query<RowDataPacket[]>(`
      SELECT e.*, t.section AS teacher_section
      FROM events e
      LEFT JOIN teachers t ON t.id = e.teacher_id
      ORDER BY e.scheduled_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[principal] getAllEvents:', err);
    res.status(500).json({ message: 'Failed to fetch events.' });
  }
};

// ─── POST /api/principal/events ──────────────────────────────────────────────
export const createEvent = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      title,
      description  = '',
      event_type   = 'School Event',
      scheduled_at,
      location     = '',
    } = req.body as {
      title: string;
      description?: string;
      event_type?: string;
      scheduled_at: string;
      location?: string;
    };

    if (!title || !scheduled_at) {
      res.status(400).json({ message: 'title and scheduled_at are required.' });
      return;
    }

    const result = await query<ResultSetHeader>(
      `INSERT INTO events
         (teacher_id, title, description, event_type, scheduled_at, location, teacher_name, created_at)
       VALUES (NULL,?,?,?,?,?,'Principal Admin',NOW())`,
      [title, description, event_type, scheduled_at, location],
    );

    // Notify all teachers
    const teachers = await query<RowDataPacket[]>('SELECT id FROM teachers');
    if (teachers.length) {
      const vals = teachers
        .map((t: any) =>
          `(${t.id}, 'new_event', 'New event: "${title}" posted by Principal.', 0, NOW())`,
        )
        .join(', ');
      await query(
        `INSERT INTO notifications (teacher_id, type, body, is_read, created_at) VALUES ${vals}`,
      );
    }

    res.status(201).json({ id: result.insertId, message: 'Event created.' });
  } catch (err) {
    console.error('[principal] createEvent:', err);
    res.status(500).json({ message: 'Failed to create event.' });
  }
};

// ─── PUT /api/principal/events/:id ───────────────────────────────────────────
export const updateEvent = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { title, description, event_type, scheduled_at, location } = req.body;

    if (!title || !scheduled_at) {
      res.status(400).json({ message: 'title and scheduled_at are required.' });
      return;
    }

    const result = await query<ResultSetHeader>(
      `UPDATE events
       SET title=?, description=?, event_type=?, scheduled_at=?, location=?
       WHERE id=?`,
      [title, description, event_type, scheduled_at, location, id],
    );

    if (result.affectedRows === 0) {
      res.status(404).json({ message: 'Event not found.' });
      return;
    }

    res.json({ message: 'Event updated.', id: Number(id) });
  } catch (err) {
    console.error('[principal] updateEvent:', err);
    res.status(500).json({ message: 'Failed to update event.' });
  }
};

// ─── DELETE /api/principal/events/:id ────────────────────────────────────────
export const deleteEvent = async (req: Request, res: Response): Promise<void> => {
  try {
    await query('DELETE FROM events WHERE id = ?', [req.params.id]);
    res.json({ message: 'Event deleted.', id: Number(req.params.id) });
  } catch (err) {
    console.error('[principal] deleteEvent:', err);
    res.status(500).json({ message: 'Failed to delete event.' });
  }
};