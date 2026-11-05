import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../../lib/db';
import { signToken } from '../../lib/auth';

// POST /api/enrollment/auth/login
export async function enrollmentLogin(req: Request, res: Response): Promise<void> {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const [rows] = await pool.execute(
      `SELECT id, name, username, password, role
       FROM enrollment_admins
       WHERE username = ? AND is_active = 1`,
      [username],
    ) as any[];

    const admin = (rows as any[])[0];
    if (!admin) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const match = await bcrypt.compare(password, admin.password);
    if (!match) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const token = signToken({ id: admin.id, username: admin.username, role: admin.role });

    res.json({
      token,
      admin: {
        id:       admin.id,
        name:     admin.name,
        username: admin.username,
        role:     admin.role,
      },
    });
  } catch (err: any) {
    console.error('enrollmentLogin error:', err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/enrollment/auth/register  (first-time setup or super-admin only)
export async function enrollmentRegister(req: Request, res: Response): Promise<void> {
  try {
    const { name, username, password, role = 'registrar' } = req.body;
    if (!name || !username || !password) {
      res.status(400).json({ error: 'Name, username, and password are required' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    const [existing] = await pool.execute(
      'SELECT id FROM enrollment_admins WHERE username = ?',
      [username],
    ) as any[];

    if ((existing as any[]).length > 0) {
      res.status(409).json({ error: 'Username already taken' });
      return;
    }

    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      `INSERT INTO enrollment_admins (name, username, password, role, is_active)
       VALUES (?,?,?,?,1)`,
      [name, username, hashed, role],
    ) as any[];

    res.status(201).json({
      message: 'Admin account created',
      id: (result as any).insertId,
    });
  } catch (err: any) {
    console.error('enrollmentRegister error:', err);
    res.status(500).json({ error: err.message });
  }
}