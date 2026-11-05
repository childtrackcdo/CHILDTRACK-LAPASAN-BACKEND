import { Request, Response } from 'express';
import pool from '../../lib/db';

// ─── POST /api/absence-reasons ────────────────────────────────────────────────
export async function submitAbsenceReason(req: Request, res: Response): Promise<void> {
  try {
    const { student_name, lrn, reason, date, submitted_by, parent_contact, teacher_id } = req.body;

    if (!student_name || !reason || !date) {
      res.status(400).json({ error: 'student_name, reason, and date are required' });
      return;
    }

    const [result] = await pool.execute(
      `INSERT INTO absence_reasons
         (student_name, lrn, reason, date, submitted_by, parent_contact, teacher_id)
       VALUES (?,?,?,?,?,?,?)`,
      [
        student_name,
        lrn            || null,
        reason,
        date,
        submitted_by   || null,
        parent_contact || null,
        teacher_id     || null,
      ],
    ) as any[];

    res.status(201).json({ id: (result as any).insertId, message: 'Absence reason submitted' });
  } catch (err: any) {
    console.error('submitAbsenceReason error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/absence-reasons ─────────────────────────────────────────────────
export async function getAbsenceReasons(req: Request, res: Response): Promise<void> {
  try {
    const { student_name, status, date, grade_level, section, teacher_id } =
      req.query as Record<string, string>;

    let sql = `
      SELECT ar.*,
             t.section     AS teacher_section,
             t.grade_level AS teacher_grade
      FROM absence_reasons ar
      LEFT JOIN teachers t ON t.id = ar.teacher_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (student_name) { sql += ' AND ar.student_name LIKE ?'; params.push(`%${student_name}%`); }
    if (status)       { sql += ' AND ar.status = ?';          params.push(status); }
    if (date)         { sql += ' AND ar.date = ?';            params.push(date); }
    if (teacher_id)   { sql += ' AND ar.teacher_id = ?';      params.push(teacher_id); }
    if (grade_level)  { sql += ' AND t.grade_level = ?';      params.push(grade_level); }
    if (section)      { sql += ' AND t.section LIKE ?';       params.push(`%${section}%`); }

    sql += ' ORDER BY ar.created_at DESC';

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('getAbsenceReasons error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/absence-reasons/:id/status ───────────────────────────────────
export async function updateAbsenceReasonStatus(req: Request, res: Response): Promise<void> {
  try {
    const { id }     = req.params;
    const { status } = req.body;

    const allowed = ['pending', 'approved', 'rejected'];
    if (!allowed.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
      return;
    }

    const [result] = await pool.execute(
      'UPDATE absence_reasons SET status = ? WHERE id = ?',
      [status, id],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Absence reason not found' });
      return;
    }

    res.json({ message: 'Updated', status });
  } catch (err: any) {
    console.error('updateAbsenceReasonStatus error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── DELETE /api/absence-reasons/:id ─────────────────────────────────────────
export async function deleteAbsenceReason(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const [result] = await pool.execute(
      'DELETE FROM absence_reasons WHERE id = ?',
      [id],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Absence reason not found' });
      return;
    }

    res.json({ message: 'Deleted successfully' });
  } catch (err: any) {
    console.error('deleteAbsenceReason error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}