import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../../lib/db';
import { signToken, verifyToken } from '../../lib/auth';

// POST /api/admin/auth/login
export async function adminLogin(req: Request, res: Response): Promise<void> {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const [rows] = await pool.execute(
      `SELECT id, name, username, password
       FROM admins
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

    // Every account in this table is a super_admin — the role is hardcoded
    // at signing time rather than read from a column.
    const token = signToken({ id: admin.id, username: admin.username, role: 'super_admin' });

    res.json({
      token,
      admin: {
        id:       admin.id,
        name:     admin.name,
        username: admin.username,
        role:     'super_admin',
      },
    });
  } catch (err: any) {
    console.error('adminLogin error:', err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/admin/auth/register
// First admin can self-register (bootstrap). Once at least one admin exists,
// creating another requires a valid super_admin token — otherwise this
// endpoint would be a permanently open door to mint super admins.
export async function adminRegister(req: Request, res: Response): Promise<void> {
  try {
    const [[{ count }]]: any = await pool.query('SELECT COUNT(*) AS count FROM admins');

    if (count > 0) {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Admin registration is locked. An existing admin must create new accounts.' });
        return;
      }
      try {
        const decoded = verifyToken(authHeader.split(' ')[1]) as any;
        if (decoded.role !== 'super_admin') {
          res.status(403).json({ error: 'Only an existing admin can create new admin accounts' });
          return;
        }
      } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }
    }

    const { name, username, password } = req.body;
    if (!name || !username || !password) {
      res.status(400).json({ error: 'Name, username, and password are required' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    const [existing] = await pool.execute(
      'SELECT id FROM admins WHERE username = ?',
      [username],
    ) as any[];

    if ((existing as any[]).length > 0) {
      res.status(409).json({ error: 'Username already taken' });
      return;
    }

    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      `INSERT INTO admins (name, username, password, is_active)
       VALUES (?,?,?,1)`,
      [name, username, hashed],
    ) as any[];

    res.status(201).json({
      message: 'Admin account created',
      id: (result as any).insertId,
    });
  } catch (err: any) {
    console.error('adminRegister error:', err);
    res.status(500).json({ error: err.message });
  }
}