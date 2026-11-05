import { Request, Response } from 'express';
import pool from '../../lib/db';

function normalizeGradeLevel(raw?: string | number | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const match = String(raw).match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

export async function adminGetSubjects(req: Request, res: Response): Promise<void> {
  const { teacher_id, grade_level, strand, search } = req.query as Record<string, string>;
  try {
    let sql = `
      SELECT s.*, t.name AS teacher_name, t.section AS teacher_section
      FROM subjects s
      LEFT JOIN teachers t ON t.id = s.teacher_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (teacher_id === 'unassigned') { sql += ' AND s.teacher_id IS NULL'; }
    else if (teacher_id)             { sql += ' AND s.teacher_id = ?'; params.push(teacher_id); }
    if (grade_level) { sql += ' AND s.grade_level = ?'; params.push(normalizeGradeLevel(grade_level)); }
    if (strand)      { sql += ' AND s.strand = ?';      params.push(strand); }
    if (search)      { sql += ' AND (s.name LIKE ? OR s.description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY s.grade_level ASC, s.name ASC';
    const [rows]: any = await pool.query(sql, params);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.sqlMessage ?? err.message });
  }
}

export async function adminGetSubjectById(req: Request, res: Response): Promise<void> {
  try {
    const [rows]: any = await pool.query(
      `SELECT s.*, t.name AS teacher_name FROM subjects s
       LEFT JOIN teachers t ON t.id = s.teacher_id WHERE s.id = ?`,
      [req.params.id],
    );
    if (!rows.length) { res.status(404).json({ error: 'Subject not found' }); return; }
    res.json(rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function adminCreateSubject(req: Request, res: Response): Promise<void> {
  const { name, description, grade_level, strand, units, school_year, teacher_id } = req.body;
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  try {
    const normalizedGrade = normalizeGradeLevel(grade_level);
    if (teacher_id) {
      const [existing]: any = await pool.query(
        `SELECT id FROM subjects WHERE teacher_id = ? AND name = ?
         AND (grade_level = ? OR (grade_level IS NULL AND ? IS NULL))
         AND (school_year = ? OR (school_year IS NULL AND ? IS NULL))`,
        [teacher_id, name, normalizedGrade, normalizedGrade, school_year || null, school_year || null],
      );
      if (existing.length) {
        res.status(409).json({ error: 'This teacher already has this subject for the same grade/year' });
        return;
      }
    }
    const [result]: any = await pool.query(
      `INSERT INTO subjects (teacher_id, name, description, grade_level, strand, units, school_year)
       VALUES (?,?,?,?,?,?,?)`,
      [teacher_id || null, name, description || null, normalizedGrade,
       strand || null, units != null && units !== '' ? Number(units) : null, school_year || null],
    );
    res.status(201).json({ id: result.insertId, message: 'Subject created successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.sqlMessage ?? err.message });
  }
}

export async function adminUpdateSubject(req: Request, res: Response): Promise<void> {
  const { name, description, grade_level, strand, units, school_year, teacher_id } = req.body;
  try {
    const fields: string[] = [];
    const values: any[]    = [];
    if (name        !== undefined) { fields.push('name = ?');        values.push(name); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description || null); }
    if (grade_level !== undefined) { fields.push('grade_level = ?'); values.push(normalizeGradeLevel(grade_level)); }
    if (strand      !== undefined) { fields.push('strand = ?');      values.push(strand || null); }
    if (units       !== undefined) { fields.push('units = ?');       values.push(units != null && units !== '' ? Number(units) : null); }
    if (school_year !== undefined) { fields.push('school_year = ?'); values.push(school_year || null); }
    if (teacher_id  !== undefined) { fields.push('teacher_id = ?');  values.push(teacher_id || null); }
    if (!fields.length) { res.status(400).json({ error: 'No fields to update' }); return; }
    values.push(req.params.id);
    const [result]: any = await pool.query(`UPDATE subjects SET ${fields.join(', ')} WHERE id = ?`, values);
    if (!result.affectedRows) { res.status(404).json({ error: 'Subject not found' }); return; }
    res.json({ message: 'Subject updated successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.sqlMessage ?? err.message });
  }
}

export async function adminDeleteSubject(req: Request, res: Response): Promise<void> {
  try {
    const [result]: any = await pool.query('DELETE FROM subjects WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) { res.status(404).json({ error: 'Subject not found' }); return; }
    res.json({ message: 'Subject deleted successfully' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}