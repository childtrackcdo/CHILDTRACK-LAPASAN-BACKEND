import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../../lib/db';
import jwt from 'jsonwebtoken';
import { verifyToken } from '../../lib/auth';

const JWT_SECRET     = process.env.JWT_SECRET     || 'fallback_hs_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

// ─── POST /api/student-auth/login ────────────────────────────────────────────
export async function studentLogin(req: Request, res: Response): Promise<void> {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const [rows] = await pool.execute(
      `SELECT id, name, username, password, lrn,
              profile_photo, theme, font_size, teacher_id, is_active
       FROM student_accounts
       WHERE username = ?`,
      [username],
    ) as any[];

    const student = (rows as any[])[0];

    if (!student) {
      res.status(401).json({ error: 'Invalid credentials or account not found' });
      return;
    }

    if (!student.is_active) {
      res.status(403).json({ error: 'Account not activated. Please contact your teacher.' });
      return;
    }

    const match = await bcrypt.compare(password, student.password);
    if (!match) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = jwt.sign(
      { id: student.id, username: student.username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions,
    );

    res.json({
      token,
      student: {
        id:            student.id,
        name:          student.name,
        username:      student.username,
        lrn:           student.lrn,
        profile_photo: student.profile_photo,
        theme:         student.theme,
        font_size:     student.font_size,
        teacher_id:    student.teacher_id,
      },
    });
  } catch (err: any) {
    console.error('studentLogin error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/student-auth/:id/profile ───────────────────────────────────────
export async function getStudentProfile(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT id, name, username, lrn,
              profile_photo, theme, font_size, teacher_id
       FROM student_accounts WHERE id = ?`,
      [id],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Student account not found' });
      return;
    }

    res.json((rows as any[])[0]);
  } catch (err: any) {
    console.error('getStudentProfile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/student-auth/:id/profile ─────────────────────────────────────
export async function updateStudentProfile(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, profile_photo, theme, font_size } = req.body;

    const fields: string[] = [];
    const values: any[]    = [];

    if (name          !== undefined) { fields.push('name = ?');          values.push(name); }
    if (profile_photo !== undefined) { fields.push('profile_photo = ?'); values.push(profile_photo || null); }
    if (theme         !== undefined) { fields.push('theme = ?');         values.push(theme || 'light'); }
    if (font_size     !== undefined) { fields.push('font_size = ?');     values.push(font_size || 'medium'); }

    if (!fields.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(id);

    const [result] = await pool.execute(
      `UPDATE student_accounts SET ${fields.join(', ')} WHERE id = ?`,
      values,
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Student account not found' });
      return;
    }

    const [updated] = await pool.execute(
      `SELECT id, name, username, lrn,
              profile_photo, theme, font_size, teacher_id
       FROM student_accounts WHERE id = ?`,
      [id],
    ) as any[];

    res.json({ message: 'Profile updated', student: (updated as any[])[0] });
  } catch (err: any) {
    console.error('updateStudentProfile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/student-auth/:id/password ────────────────────────────────────
export async function changeStudentPassword(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { old_password, new_password } = req.body;

    if (!old_password || !new_password) {
      res.status(400).json({ error: 'old_password and new_password are required' });
      return;
    }

    if (String(new_password).length < 6) {
      res.status(400).json({ error: 'New password must be at least 6 characters' });
      return;
    }

    const [rows] = await pool.execute(
      'SELECT id, password FROM student_accounts WHERE id = ?',
      [id],
    ) as any[];

    const student = (rows as any[])[0];
    if (!student) {
      res.status(404).json({ error: 'Student account not found' });
      return;
    }

    const match = await bcrypt.compare(old_password, student.password);
    if (!match) {
      res.status(401).json({ error: 'Old password is incorrect' });
      return;
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.execute('UPDATE student_accounts SET password = ? WHERE id = ?', [hashed, id]);

    res.json({ message: 'Password changed successfully' });
  } catch (err: any) {
    console.error('changeStudentPassword error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/attendance/for-parent ──────────────────────────────────────────
// parentAuthMiddleware sets req.parent = { id, username, lrn }
export async function getAttendanceForParent(req: any, res: Response): Promise<void> {
  try {
    const parent = req.parent;
    if (!parent?.lrn) {
      res.status(403).json({ error: 'No linked student for this parent account' });
      return;
    }

    const { date_from, date_to, subject, session } = req.query;

    const conditions: string[] = ['lrn = ?'];
    const params: any[]        = [parent.lrn];

    if (date_from) { conditions.push('date >= ?');   params.push(date_from); }
    if (date_to)   { conditions.push('date <= ?');   params.push(date_to); }
    if (subject)   { conditions.push('subject = ?'); params.push(subject); }
    if (session)   { conditions.push('session = ?'); params.push(session); }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [rows]: any = await pool.query(
      `SELECT * FROM attendance ${where} ORDER BY date DESC`,
      params,
    );

    const total   = rows.length;
    const present = rows.filter((r: any) => r.status === 'Present').length;
    const absent  = rows.filter((r: any) => r.status === 'Absent').length;
    const late    = rows.filter((r: any) => r.status === 'Late').length;
    const excused = rows.filter((r: any) => r.status === 'Excused').length;

    res.json({
      summary: { total, present, absent, late, excused },
      records: rows,
    });
  } catch (err: any) {
    console.error('getAttendanceForParent error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to fetch attendance for parent' });
  }
}

// ─── Middleware: verify student JWT ──────────────────────────────────────────
export function studentSelfMiddleware(req: any, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' }); return;
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyToken(token) as any;
    req.studentAccount = decoded; // { id, username }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── GET /api/student-auth/self/me ───────────────────────────────────────────
export async function getStudentSelf(req: any, res: Response): Promise<void> {
  try {
    const { id } = req.studentAccount;
    const [rows]: any = await pool.execute(
      `SELECT
         sa.id, sa.name, sa.username, sa.lrn,
         sa.profile_photo, sa.theme, sa.font_size, sa.teacher_id,
         s.grade_level, s.section, s.gender, s.school_year,
         s.contact AS contact,
         p1.name        AS parent1,
         p1.contact_number AS parent1_contact
       FROM student_accounts sa
       LEFT JOIN students s
         ON s.lrn = sa.lrn
       LEFT JOIN parents_guardians p1
         ON p1.student_id = s.id AND p1.role = 'Parent 1'
       WHERE sa.id = ?`,
      [id],
    );
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Server error' });
  }
}

// ─── GET /api/student-auth/self/attendance ────────────────────────────────────
export async function getStudentSelfAttendance(req: any, res: Response): Promise<void> {
  try {
    const { id } = req.studentAccount;

    const [acctRows]: any = await pool.execute(
      'SELECT lrn FROM student_accounts WHERE id = ?', [id],
    );
    const lrn = acctRows[0]?.lrn;
    if (!lrn) { res.status(404).json({ error: 'LRN not linked to account' }); return; }

    const { date_from, date_to, subject, session } = req.query;
    const conditions: string[] = ['lrn = ?'];
    const params: any[]        = [lrn];

    if (date_from) { conditions.push('date >= ?');   params.push(date_from); }
    if (date_to)   { conditions.push('date <= ?');   params.push(date_to); }
    if (subject)   { conditions.push('subject = ?'); params.push(subject); }
    if (session)   { conditions.push('session = ?'); params.push(session); }

    const [rows]: any = await pool.query(
      `SELECT * FROM attendance WHERE ${conditions.join(' AND ')} ORDER BY date DESC`,
      params,
    );

    res.json({
      summary: {
        total:   rows.length,
        present: rows.filter((r: any) => r.status === 'Present').length,
        absent:  rows.filter((r: any) => r.status === 'Absent').length,
        late:    rows.filter((r: any) => r.status === 'Late').length,
        excused: rows.filter((r: any) => r.status === 'Excused').length,
      },
      records: rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Server error' });
  }
}

// ─── GET /api/student-auth/self/schedule ─────────────────────────────────────
export async function getStudentSelfSchedule(req: any, res: Response): Promise<void> {
  try {
    const { id } = req.studentAccount;

    const [acctRows]: any = await pool.execute(
      `SELECT sa.lrn, s.grade_level, s.section
       FROM student_accounts sa
       LEFT JOIN students s ON s.lrn = sa.lrn
       WHERE sa.id = ?`,
      [id],
    );
    const acct = acctRows[0];
    if (!acct) { res.status(404).json({ error: 'Account not found' }); return; }

    const [rows]: any = await pool.query(
      `SELECT ss.*, t.name AS teacher_name,
              ss.day_of_week AS day
       FROM student_schedules ss
       LEFT JOIN teachers t ON t.id = ss.teacher_id
       WHERE ss.grade_level = ?
         AND TRIM(SUBSTRING_INDEX(ss.section, ' - ', -1)) =
             TRIM(SUBSTRING_INDEX(?, ' - ', -1))
       ORDER BY FIELD(ss.day_of_week, 'Monday','Tuesday','Wednesday','Thursday','Friday'), ss.start_time`,
      [acct.grade_level, acct.section ?? ''],
    );

    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Server error' });
  }
}

// ─── GET /api/student-auth/self/grades ───────────────────────────────────────
export async function getStudentSelfGrades(req: any, res: Response): Promise<void> {
  try {
    const { id } = req.studentAccount;

    const [acctRows]: any = await pool.execute(
      `SELECT sa.lrn, s.id AS student_id
       FROM student_accounts sa
       LEFT JOIN students s ON s.lrn = sa.lrn
       WHERE sa.id = ?`,
      [id],
    );
    const acct = acctRows[0];
    if (!acct?.student_id) { res.json([]); return; }

    const [rows]: any = await pool.query(
      `SELECT g.*, g.subject_name AS subject
       FROM grades g
       WHERE g.student_id = ?
       ORDER BY g.subject_name, g.quarter`,
      [acct.student_id],
    );

    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Server error' });
  }
}

// ─── GET /api/student-auth/self/events ───────────────────────────────────────
export async function getStudentSelfEvents(req: any, res: Response): Promise<void> {
  try {
    const [rows]: any = await pool.query(
      `SELECT * FROM events ORDER BY scheduled_at DESC`,
    );
    const mapped = rows.map((e: any) => ({
      ...e,
      date: e.scheduled_at,
      time: e.scheduled_at
        ? new Date(e.scheduled_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
        : null,
    }));
    res.json(mapped);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Server error' });
  }
}

// ─── GET /api/student-auth/self/notifications ────────────────────────────────
export async function getStudentSelfNotifications(req: any, res: Response): Promise<void> {
  try {
    const { id } = req.studentAccount;

    const [acctRows]: any = await pool.execute(
      'SELECT lrn FROM student_accounts WHERE id = ?', [id],
    );
    const lrn = acctRows[0]?.lrn;
    if (!lrn) { res.json([]); return; }

    const [rows]: any = await pool.query(
      `SELECT * FROM parent_notifications
       WHERE lrn = ?
       ORDER BY created_at DESC
       LIMIT 100`,
      [lrn],
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Server error' });
  }
}

// ─── PATCH /api/student-auth/notifications/:id/read ─────────────────────────
export async function markStudentNotificationRead(req: any, res: Response): Promise<void> {
  try {
    await pool.execute(
      'UPDATE parent_notifications SET is_read = 1 WHERE id = ?',
      [req.params.id],
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Server error' });
  }
}