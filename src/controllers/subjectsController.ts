import { Request, Response } from 'express';
import pool from '../../lib/db';
import { AuthRequest } from '../../middleware/authMiddleware';

// ─── GET /api/subjects ────────────────────────────────────────────────────────
// Query params: grade_level, strand, search
// Returns subjects belonging to the authenticated teacher.
export async function getSubjects(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { grade_level, strand, search } = req.query as Record<string, string>;

    let sql = `
      SELECT *
      FROM subjects
      WHERE teacher_id = ?
    `;
    const params: any[] = [teacherId];

    if (grade_level) { sql += ' AND grade_level = ?';     params.push(grade_level); }
    if (strand)      { sql += ' AND strand = ?';          params.push(strand); }
    if (search) {
      sql += ' AND (name LIKE ? OR description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY name';

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('getSubjects error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/subjects/:id ────────────────────────────────────────────────────
export async function getSubjectById(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { id }    = req.params;

    const [rows] = await pool.execute(
      'SELECT * FROM subjects WHERE id = ? AND teacher_id = ?',
      [id, teacherId],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Subject not found' });
      return;
    }

    res.json((rows as any[])[0]);
  } catch (err: any) {
    console.error('getSubjectById error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── POST /api/subjects ───────────────────────────────────────────────────────
export async function createSubject(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const {
      name,
      description,
      grade_level,
      strand,
      units,
      school_year,
    } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    // Prevent duplicate subject names for the same teacher/grade_level/school_year
    const [existing] = await pool.execute(
      `SELECT id FROM subjects
       WHERE teacher_id = ? AND name = ?
         AND (grade_level = ? OR (grade_level IS NULL AND ? IS NULL))
         AND (school_year = ? OR (school_year IS NULL AND ? IS NULL))`,
      [
        teacherId,
        name,
        grade_level || null, grade_level || null,
        school_year || null, school_year || null,
      ],
    ) as any[];

    if ((existing as any[]).length > 0) {
      res.status(409).json({
        error: 'A subject with this name already exists for the same grade level and school year',
      });
      return;
    }

    const [result] = await pool.execute(
      `INSERT INTO subjects
         (teacher_id, name, description, grade_level, strand, units, school_year)
       VALUES (?,?,?,?,?,?,?)`,
      [
        teacherId,
        name,
        description || null,
        grade_level || null,
        strand      || null,
        units       != null ? Number(units) : null,
        school_year || null,
      ],
    ) as any[];

    res.status(201).json({
      id:      (result as any).insertId,
      message: 'Subject created successfully',
    });
  } catch (err: any) {
    console.error('createSubject error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/subjects/:id ──────────────────────────────────────────────────
export async function updateSubject(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { id }    = req.params;
    const { name, description, grade_level, strand, units, school_year } = req.body;

    const fields: string[] = [];
    const values: any[]    = [];

    if (name        !== undefined) { fields.push('name = ?');        values.push(name); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description || null); }
    if (grade_level !== undefined) { fields.push('grade_level = ?'); values.push(grade_level || null); }
    if (strand      !== undefined) { fields.push('strand = ?');      values.push(strand || null); }
    if (units       !== undefined) { fields.push('units = ?');       values.push(units != null ? Number(units) : null); }
    if (school_year !== undefined) { fields.push('school_year = ?'); values.push(school_year || null); }

    if (!fields.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(id, teacherId);

    const [result] = await pool.execute(
      `UPDATE subjects SET ${fields.join(', ')} WHERE id = ? AND teacher_id = ?`,
      values,
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Subject not found or not yours' });
      return;
    }

    res.json({ message: 'Subject updated successfully' });
  } catch (err: any) {
    console.error('updateSubject error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── DELETE /api/subjects/:id ─────────────────────────────────────────────────
export async function deleteSubject(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { id }    = req.params;

    const [result] = await pool.execute(
      'DELETE FROM subjects WHERE id = ? AND teacher_id = ?',
      [id, teacherId],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Subject not found or not yours' });
      return;
    }

    res.json({ message: 'Subject deleted successfully' });
  } catch (err: any) {
    console.error('deleteSubject error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/subjects/public ─────────────────────────────────────────────────
// Publicly accessible endpoint — returns distinct subject names by grade level.
// Useful for dropdowns in the attendance / grade entry forms.
export async function getPublicSubjectList(req: Request, res: Response): Promise<void> {
  try {
    const { grade_level, strand } = req.query as Record<string, string>;

    let sql = `
      SELECT DISTINCT name, grade_level, strand
      FROM subjects
      WHERE 1=1
    `;
    const params: any[] = [];

    if (grade_level) { sql += ' AND grade_level = ?'; params.push(grade_level); }
    if (strand)      { sql += ' AND strand = ?';      params.push(strand); }

    sql += ' ORDER BY grade_level, name';

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('getPublicSubjectList error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/subjects/stats ──────────────────────────────────────────────────
// How many subjects the teacher has per grade level / strand.
export async function getSubjectStats(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;

    const [rows] = await pool.execute(
      `SELECT grade_level, strand, COUNT(*) AS count
       FROM subjects
       WHERE teacher_id = ?
       GROUP BY grade_level, strand
       ORDER BY grade_level, strand`,
      [teacherId],
    ) as any[];

    const [total] = await pool.execute(
      'SELECT COUNT(*) AS total FROM subjects WHERE teacher_id = ?',
      [teacherId],
    ) as any[];

    res.json({
      total:    (total as any[])[0].total,
      by_grade: rows,
    });
  } catch (err: any) {
    console.error('getSubjectStats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/students/sections ───────────────────────────────────────────────
// Returns all distinct section names school-wide (no teacher filter).
export async function getAllSections(req: AuthRequest, res: Response): Promise<void> {
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT section 
       FROM students 
       WHERE section IS NOT NULL AND section != '' 
       ORDER BY section`
    ) as any[];
    res.json((rows as any[]).map((r: any) => r.section));
  } catch (err: any) {
    console.error('getAllSections error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}