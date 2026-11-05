import { Request, Response } from 'express';
import pool from '../../lib/db';
import { AuthRequest } from '../../middleware/authMiddleware';

// ─── POST /api/guardians ──────────────────────────────────────────────────────
export async function createGuardian(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { student_id, role, name, contact_number, occupation, highest_educ } = req.body;

    if (!name || !student_id) {
      res.status(400).json({ error: 'name and student_id are required' });
      return;
    }

    const validRoles = ['Parent 1', 'Parent 2', 'Guardian'];
    if (role && !validRoles.includes(role)) {
      res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
      return;
    }

    const [result] = await pool.execute(
      `INSERT INTO parents_guardians
         (student_id, role, name, contact_number, occupation, highest_educ)
       VALUES (?,?,?,?,?,?)`,
      [
        Number(student_id),
        role           || 'Guardian',
        name,
        contact_number || null,
        occupation     || null,
        highest_educ   || null,
      ],
    ) as any[];

    res.status(201).json({
      id:      (result as any).insertId,
      message: 'Guardian registered successfully',
    });
  } catch (err: any) {
    console.error('createGuardian error:', err);
    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
      res.status(400).json({ error: 'Student ID does not exist' });
      return;
    }
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/guardians ───────────────────────────────────────────────────────
export async function getGuardians(req: Request, res: Response): Promise<void> {
  try {
    const { student_id, role, search } = req.query as Record<string, string>;

    let sql = `
      SELECT
        pg.id,
        pg.student_id,
        pg.role,
        pg.name,
        pg.contact_number,
        pg.occupation,
        pg.highest_educ,
        pg.created_at,
        s.name    AS student_name,
        s.lrn     AS student_lrn,
        s.section AS student_section
      FROM parents_guardians pg
      LEFT JOIN students s ON s.id = pg.student_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (student_id) {
      sql += ' AND pg.student_id = ?';
      params.push(Number(student_id));
    }
    if (role) {
      sql += ' AND pg.role = ?';
      params.push(role);
    }
    if (search) {
      sql += ' AND (pg.name LIKE ? OR pg.contact_number LIKE ? OR pg.role LIKE ? OR s.name LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    sql += ' ORDER BY s.name, pg.student_id, pg.role';

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('getGuardians error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/guardians/:id ───────────────────────────────────────────────────
export async function getGuardianById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT pg.*,
        s.name    AS student_name,
        s.lrn     AS student_lrn,
        s.section AS student_section
       FROM parents_guardians pg
       LEFT JOIN students s ON s.id = pg.student_id
       WHERE pg.id = ?`,
      [id],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Guardian not found' });
      return;
    }

    res.json((rows as any[])[0]);
  } catch (err: any) {
    console.error('getGuardianById error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/guardians/:id ─────────────────────────────────────────────────
export async function updateGuardian(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { role, name, contact_number, occupation, highest_educ } = req.body;

    const fields: string[] = [];
    const values: any[]    = [];

    if (role           !== undefined) { fields.push('role = ?');           values.push(role); }
    if (name           !== undefined) { fields.push('name = ?');           values.push(name); }
    if (contact_number !== undefined) { fields.push('contact_number = ?'); values.push(contact_number || null); }
    if (occupation     !== undefined) { fields.push('occupation = ?');     values.push(occupation || null); }
    if (highest_educ   !== undefined) { fields.push('highest_educ = ?');   values.push(highest_educ || null); }

    if (!fields.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(id);

    const [result] = await pool.execute(
      `UPDATE parents_guardians SET ${fields.join(', ')} WHERE id = ?`,
      values,
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Guardian not found' });
      return;
    }

    res.json({ message: 'Guardian updated successfully' });
  } catch (err: any) {
    console.error('updateGuardian error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── DELETE /api/guardians/:id ────────────────────────────────────────────────
export async function deleteGuardian(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const [result] = await pool.execute(
      'DELETE FROM parents_guardians WHERE id = ?',
      [id],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Guardian not found' });
      return;
    }

    res.json({ message: 'Guardian deleted successfully' });
  } catch (err: any) {
    console.error('deleteGuardian error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}