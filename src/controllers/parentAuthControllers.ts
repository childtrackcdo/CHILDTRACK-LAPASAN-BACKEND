import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../../lib/db';
import jwt from 'jsonwebtoken';

const JWT_SECRET    = process.env.JWT_SECRET    || 'fallback_hs_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

// ─── POST /api/parent-auth/login ─────────────────────────────────────────────
export async function parentLogin(req: Request, res: Response): Promise<void> {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const [rows] = await pool.execute(
      `SELECT id, name, username, password, student_name, lrn,
              profile_photo, theme, font_size, teacher_id, is_active
       FROM parent_accounts
       WHERE username = ?`,
      [username],
    ) as any[];

    const parent = (rows as any[])[0];

    if (!parent) {
      res.status(401).json({ error: 'Invalid credentials or account not found' });
      return;
    }

    if (!parent.is_active) {
      res.status(403).json({ error: 'Account not activated. Please contact your teacher.' });
      return;
    }

    const match = await bcrypt.compare(password, parent.password);
    if (!match) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = jwt.sign(
      { id: parent.id, username: parent.username, lrn: parent.lrn },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions,
    );

    res.json({
      token,
      parent: {
        id:            parent.id,
        name:          parent.name,
        username:      parent.username,
        student_name:  parent.student_name,
        lrn:           parent.lrn,
        profile_photo: parent.profile_photo,
        theme:         parent.theme,
        font_size:     parent.font_size,
        teacher_id:    parent.teacher_id,
      },
    });
  } catch (err: any) {
    console.error('parentLogin error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/parent-auth/:id/profile ────────────────────────────────────────
export async function getParentProfile(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT id, name, username, student_name, lrn,
              profile_photo, theme, font_size, teacher_id
       FROM parent_accounts WHERE id = ?`,
      [id],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Parent account not found' });
      return;
    }

    res.json((rows as any[])[0]);
  } catch (err: any) {
    console.error('getParentProfile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/parent-auth/:id/profile ──────────────────────────────────────
export async function updateParentProfile(req: Request, res: Response): Promise<void> {
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
      `UPDATE parent_accounts SET ${fields.join(', ')} WHERE id = ?`,
      values,
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Parent account not found' });
      return;
    }

    const [updated] = await pool.execute(
      `SELECT id, name, username, student_name, lrn,
              profile_photo, theme, font_size, teacher_id
       FROM parent_accounts WHERE id = ?`,
      [id],
    ) as any[];

    res.json({ message: 'Profile updated', parent: (updated as any[])[0] });
  } catch (err: any) {
    console.error('updateParentProfile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/parent-auth/:id/password ─────────────────────────────────────
export async function changeParentPassword(req: Request, res: Response): Promise<void> {
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
      'SELECT id, password FROM parent_accounts WHERE id = ?',
      [id],
    ) as any[];

    const parent = (rows as any[])[0];
    if (!parent) {
      res.status(404).json({ error: 'Parent account not found' });
      return;
    }

    const match = await bcrypt.compare(old_password, parent.password);
    if (!match) {
      res.status(401).json({ error: 'Old password is incorrect' });
      return;
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.execute('UPDATE parent_accounts SET password = ? WHERE id = ?', [hashed, id]);

    res.json({ message: 'Password changed successfully' });
  } catch (err: any) {
    console.error('changeParentPassword error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}