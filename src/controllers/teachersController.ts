import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../../lib/db';

// ─── GET /api/teachers ────────────────────────────────────────────────────────
export async function getAllTeachers(req: Request, res: Response): Promise<void> {
  try {
    const { grade_level, section, strand, search } = req.query as Record<string, string>;

    let sql = `
      SELECT t.id, t.name, t.username, t.age, t.gender,
             t.section, t.grade_level, t.strand,
             t.contact, t.address, t.created_at, t.photo_base64,
             COUNT(s.id) AS student_count
      FROM teachers t
      LEFT JOIN students s ON s.teacher_id = t.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (grade_level) { sql += ' AND t.grade_level = ?';    params.push(grade_level); }
    if (section)     { sql += ' AND t.section LIKE ?';     params.push(`%${section}%`); }
    if (strand)      { sql += ' AND t.strand = ?';         params.push(strand); }
    if (search) {
      sql += ' AND (t.name LIKE ? OR t.username LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ' GROUP BY t.id ORDER BY t.grade_level, t.section';

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('getAllTeachers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/teachers/:id ────────────────────────────────────────────────────
export async function getTeacherById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT id, name, username, age, gender, section,
              grade_level, strand, contact, address, created_at, photo_base64
       FROM teachers WHERE id = ?`,
      [id],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Teacher not found' });
      return;
    }

    res.json((rows as any[])[0]);
  } catch (err: any) {
    console.error('getTeacherById error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PUT /api/teachers/:id ────────────────────────────────────────────────────
export async function updateProfile(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const {
      name, username, age, gender,
      section, grade_level, strand,
      contact, address, photo_base64,
    } = req.body;

    // Check username uniqueness (exclude self)
    if (username) {
      const [existing] = await pool.execute(
        'SELECT id FROM teachers WHERE username = ? AND id != ?',
        [username, id],
      ) as any[];

      if ((existing as any[]).length > 0) {
        res.status(409).json({ error: 'Username already taken by another teacher.' });
        return;
      }
    }

    const [result] = await pool.execute(
      `UPDATE teachers
       SET name = ?, username = ?, age = ?, gender = ?,
           section = ?, grade_level = ?, strand = ?,
           contact = ?, address = ?, photo_base64 = ?
       WHERE id = ?`,
      [
        name         || null,
        username     || null,
        age          || null,
        gender       || null,
        section      || null,
        grade_level  || null,
        strand       || null,
        contact      || null,
        address      || null,
        photo_base64 || null,
        id,
      ],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Teacher not found' });
      return;
    }

    const [rows] = await pool.execute(
      `SELECT id, name, username, age, gender, section,
              grade_level, strand, contact, address, photo_base64
       FROM teachers WHERE id = ?`,
      [id],
    ) as any[];

    res.json({ message: 'Profile updated.', teacher: (rows as any[])[0] });
  } catch (err: any) {
    console.error('updateProfile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PUT /api/teachers/:id/change-password ────────────────────────────────────
export async function changePassword(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'Both currentPassword and newPassword are required.' });
      return;
    }
    if (String(newPassword).length < 6) {
      res.status(400).json({ error: 'New password must be at least 6 characters.' });
      return;
    }

    const [rows] = await pool.execute(
      'SELECT password FROM teachers WHERE id = ?',
      [id],
    ) as any[];

    const teacher = (rows as any[])[0];
    if (!teacher) {
      res.status(404).json({ error: 'Teacher not found.' });
      return;
    }

    const match = await bcrypt.compare(currentPassword, teacher.password);
    if (!match) {
      res.status(401).json({ error: 'Current password is incorrect.' });
      return;
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.execute('UPDATE teachers SET password = ? WHERE id = ?', [hashed, id]);

    res.json({ message: 'Password changed successfully.' });
  } catch (err: any) {
    console.error('changePassword error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── DELETE /api/teachers/:id ─────────────────────────────────────────────────
export async function deleteTeacher(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const [result] = await pool.execute(
      'DELETE FROM teachers WHERE id = ?',
      [id],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Teacher not found' });
      return;
    }

    res.json({ message: 'Teacher deleted successfully' });
  } catch (err: any) {
    console.error('deleteTeacher error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}