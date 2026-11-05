import { Response } from 'express';
import pool from '../../lib/db';
import { AuthRequest } from '../../middleware/authMiddleware';

// ─── GET /api/grades ──────────────────────────────────────────────────────────
export async function getGrades(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { student_id, school_year, quarter, subject_name, section, grade_level } =
      req.query as Record<string, string>;

    let sql = `
      SELECT
        g.*,
        s.name        AS student_name,
        s.lrn,
        s.grade_level AS student_grade_level,
        s.section     AS student_section,
        s.strand,
        s.photo
      FROM grades g
      JOIN students s ON s.id = g.student_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (student_id)   { sql += ' AND g.student_id = ?';      params.push(student_id); }
    if (school_year)  { sql += ' AND g.school_year = ?';     params.push(school_year); }
    if (quarter)      { sql += ' AND g.quarter = ?';         params.push(quarter); }
    if (subject_name) { sql += ' AND g.subject_name LIKE ?'; params.push(`%${subject_name}%`); }
    if (section)      { sql += ' AND s.section LIKE ?';      params.push(`%${section}%`); }
    if (grade_level)  { sql += ' AND s.grade_level = ?';     params.push(grade_level); }

    sql += ' ORDER BY g.school_year, g.quarter, s.section, s.name';

    const [rows] = await pool.execute(sql, params) as any[];

    // Normalise: surface student info onto the row for the frontend
    const out = (rows as any[]).map(r => ({
      ...r,
      grade_level: r.grade_level || r.student_grade_level,
      section:     r.section     || r.student_section,
    }));
    res.json(out);
  } catch (err: any) {
    console.error('getGrades error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/subjects ────────────────────────────────────────────────────────
// Returns subjects filtered by grade_level and optional strand
export async function getSubjects(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { grade_level, strand } = req.query as Record<string, string>;

    let sql = 'SELECT * FROM subjects WHERE 1=1';
    const params: any[] = [];

    if (grade_level) {
      sql += ' AND grade_level = ?';
      params.push(grade_level);
    }
    if (strand && strand !== 'All') {
      sql += ' AND (strand = ? OR strand = "All" OR strand = "")';
      params.push(strand);
    }

    sql += ' ORDER BY name';

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('getSubjects error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/students/by-section ─────────────────────────────────────────────
// Returns students for a section/grade_level search (used in grade dialog autocomplete)
export async function getStudentsBySection(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { search, section, grade_level } = req.query as Record<string, string>;

    let sql = `
      SELECT id, lrn, name, section, grade_level, strand, photo
      FROM students
      WHERE enrollment_status = 'enrolled'
    `;
    const params: any[] = [];

    if (search) {
      sql += ' AND (name LIKE ? OR lrn LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (section) {
      sql += ' AND section LIKE ?';
      params.push(`%${section}%`);
    }
    if (grade_level) {
      sql += ' AND grade_level = ?';
      params.push(grade_level);
    }

    sql += ' ORDER BY section, name LIMIT 50';

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('getStudentsBySection error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── POST /api/grades ─────────────────────────────────────────────────────────
export async function createGrade(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const {
      student_id, subject_id, subject_name, quarter, grade, school_year, remarks,
      grade_level, section, weight_type,
      ww_weighted, pt_weighted, qa_weighted, initial_grade,
    } = req.body;

    if (!student_id || !subject_name || !quarter || grade === undefined || !school_year) {
      res.status(400).json({
        error: 'student_id, subject_name, quarter, grade, and school_year are required',
      });
      return;
    }

    const gradeVal = Number(grade);
    if (isNaN(gradeVal) || gradeVal < 60 || gradeVal > 100) {
      res.status(400).json({ error: 'grade must be a number between 60 and 100' });
      return;
    }

    // Upsert – update if same student/subject/quarter/sy already exists
    const [existing] = await pool.execute(
      `SELECT id FROM grades
       WHERE student_id = ? AND subject_name = ? AND quarter = ? AND school_year = ?`,
      [student_id, subject_name, quarter, school_year],
    ) as any[];

    let id: number;

    if ((existing as any[]).length > 0) {
      id = (existing as any[])[0].id;
      await pool.execute(
        `UPDATE grades
         SET grade = ?, remarks = ?, teacher_id = ?,
             grade_level = ?, section = ?, weight_type = ?,
             ww_weighted = ?, pt_weighted = ?, qa_weighted = ?, initial_grade = ?
         WHERE id = ?`,
        [
          gradeVal, remarks || '', teacherId,
          grade_level || '', section || '', weight_type || '',
          ww_weighted ?? null, pt_weighted ?? null, qa_weighted ?? null, initial_grade ?? null,
          id,
        ],
      );
    } else {
      const [result] = await pool.execute(
        `INSERT INTO grades
           (student_id, teacher_id, subject_id, subject_name,
            quarter, grade, school_year, remarks,
            grade_level, section, weight_type,
            ww_weighted, pt_weighted, qa_weighted, initial_grade)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          student_id, teacherId, subject_id || null, subject_name,
          quarter, gradeVal, school_year, remarks || '',
          grade_level || '', section || '', weight_type || '',
          ww_weighted ?? null, pt_weighted ?? null, qa_weighted ?? null, initial_grade ?? null,
        ],
      ) as any[];
      id = (result as any).insertId;
    }

    res.status(201).json({ id, message: 'Grade saved.' });
  } catch (err: any) {
    console.error('createGrade error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── PATCH /api/grades/:id ────────────────────────────────────────────────────
export async function updateGrade(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const {
      grade, remarks, subject_name, subject_id, quarter,
      grade_level, section, weight_type,
      ww_weighted, pt_weighted, qa_weighted, initial_grade,
    } = req.body;

    const fields: string[] = [];
    const values: any[]    = [];

    if (grade !== undefined) {
      const gradeVal = Number(grade);
      if (isNaN(gradeVal) || gradeVal < 60 || gradeVal > 100) {
        res.status(400).json({ error: 'grade must be a number between 60 and 100' });
        return;
      }
      fields.push('grade = ?'); values.push(gradeVal);
    }
    if (remarks      !== undefined) { fields.push('remarks = ?');       values.push(remarks); }
    if (subject_name !== undefined) { fields.push('subject_name = ?');  values.push(subject_name); }
    if (subject_id   !== undefined) { fields.push('subject_id = ?');    values.push(subject_id); }
    if (quarter      !== undefined) { fields.push('quarter = ?');       values.push(quarter); }
    if (grade_level  !== undefined) { fields.push('grade_level = ?');   values.push(grade_level); }
    if (section      !== undefined) { fields.push('section = ?');       values.push(section); }
    if (weight_type  !== undefined) { fields.push('weight_type = ?');   values.push(weight_type); }
    if (ww_weighted  !== undefined) { fields.push('ww_weighted = ?');   values.push(ww_weighted ?? null); }
    if (pt_weighted  !== undefined) { fields.push('pt_weighted = ?');   values.push(pt_weighted ?? null); }
    if (qa_weighted  !== undefined) { fields.push('qa_weighted = ?');   values.push(qa_weighted ?? null); }
    if (initial_grade !== undefined){ fields.push('initial_grade = ?'); values.push(initial_grade ?? null); }

    if (!fields.length) {
      res.status(400).json({ error: 'Nothing to update' });
      return;
    }

    values.push(id);
    const [result] = await pool.execute(
      `UPDATE grades SET ${fields.join(', ')} WHERE id = ?`,
      values,
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Grade record not found' });
      return;
    }

    res.json({ message: 'Grade updated.' });
  } catch (err: any) {
    console.error('updateGrade error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── DELETE /api/grades/:id ───────────────────────────────────────────────────
export async function deleteGrade(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const [result] = await pool.execute('DELETE FROM grades WHERE id = ?', [id]) as any[];
    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Grade record not found' }); return;
    }
    res.json({ message: 'Grade deleted.' });
  } catch (err: any) {
    console.error('deleteGrade error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/grades/report/sf9/:student_id ───────────────────────────────────
export async function getSF9Data(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { student_id } = req.params;
    const { school_year } = req.query as Record<string, string>;

    const currentYear = new Date().getFullYear();
    const sy = school_year || `${currentYear}-${currentYear + 1}`;

    const [students] = await pool.execute(
      `SELECT s.*, t.name AS adviser_name
       FROM students s
       LEFT JOIN teachers t ON t.id = s.teacher_id
       WHERE s.id = ?`,
      [student_id],
    ) as any[];

    if (!(students as any[]).length) {
      res.status(404).json({ error: 'Student not found' }); return;
    }
    const student = (students as any[])[0];

    const [gradesRaw] = await pool.execute(
      `SELECT subject_name,
              MAX(CASE WHEN quarter='Q1' THEN grade END) AS q1,
              MAX(CASE WHEN quarter='Q2' THEN grade END) AS q2,
              MAX(CASE WHEN quarter='Q3' THEN grade END) AS q3,
              MAX(CASE WHEN quarter='Q4' THEN grade END) AS q4
       FROM grades
       WHERE student_id = ? AND school_year = ?
       GROUP BY subject_name
       ORDER BY subject_name`,
      [student_id, sy],
    ) as any[];

    const grades = (gradesRaw as any[]).map(g => {
      const vals  = [g.q1, g.q2, g.q3, g.q4].filter(v => v != null);
      const final = vals.length
        ? Math.round(vals.reduce((a: number, b: number) => a + Number(b), 0) / vals.length)
        : null;
      return {
        subject: g.subject_name, q1: g.q1, q2: g.q2, q3: g.q3, q4: g.q4,
        final, remarks: final != null ? (final >= 75 ? 'Passed' : 'Failed') : '',
      };
    });

    const syYears = sy.split('-');
    const [attSummary] = await pool.execute(
      `SELECT COUNT(DISTINCT date) AS school_days,
              SUM(status='Absent')  AS absent_days,
              SUM(status='Late')    AS tardy_days
       FROM attendance
       WHERE student_name = ? AND YEAR(date) IN (?,?)`,
      [student.name, syYears[0], syYears[1]],
    ) as any[];

    res.json({
      school_year: sy,
      student: {
        id: student.id, name: student.name, lrn: student.lrn,
        gender: student.gender, birthdate: student.birthdate,
        grade_level: student.grade_level, section: student.section,
        strand: student.strand, track: student.track,
        school_year: student.school_year, adviser: student.adviser_name,
      },
      grades,
      attendance: {
        school_days: (attSummary as any[])[0]?.school_days ?? 0,
        absent_days: (attSummary as any[])[0]?.absent_days ?? 0,
        tardy_days:  (attSummary as any[])[0]?.tardy_days  ?? 0,
      },
    });
  } catch (err: any) {
    console.error('getSF9Data error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/grades/report/sf10/:student_id ──────────────────────────────────
export async function getSF10Data(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { student_id } = req.params;

    const [students] = await pool.execute(
      'SELECT * FROM students WHERE id = ?', [student_id],
    ) as any[];

    if (!(students as any[]).length) {
      res.status(404).json({ error: 'Student not found' }); return;
    }
    const student = (students as any[])[0];

    const [syList] = await pool.execute(
      `SELECT DISTINCT school_year FROM grades WHERE student_id = ? ORDER BY school_year`,
      [student_id],
    ) as any[];

    const records = await Promise.all(
      (syList as any[]).map(async ({ school_year }) => {
        const [grds] = await pool.execute(
          `SELECT subject_name,
                  MAX(CASE WHEN quarter='Q1' THEN grade END) AS q1,
                  MAX(CASE WHEN quarter='Q2' THEN grade END) AS q2,
                  MAX(CASE WHEN quarter='Q3' THEN grade END) AS q3,
                  MAX(CASE WHEN quarter='Q4' THEN grade END) AS q4
           FROM grades
           WHERE student_id = ? AND school_year = ?
           GROUP BY subject_name`,
          [student_id, school_year],
        ) as any[];
        const rows = grds as any[];
        const gpa  = rows.length
          ? rows.reduce((sum, g) => {
              const vals = [g.q1,g.q2,g.q3,g.q4].filter(v => v!=null);
              return sum + (vals.length ? vals.reduce((a:number,b:number)=>a+Number(b),0)/vals.length : 0);
            }, 0) / rows.length
          : 0;
        return { school_year, grade_level: student.grade_level, section: student.section,
          gpa: Math.round(gpa*100)/100, remarks: gpa>=75?'Promoted':'Failed', subjects: rows };
      }),
    );

    res.json({
      student: { id: student.id, name: student.name, lrn: student.lrn,
        gender: student.gender, birthdate: student.birthdate },
      records,
    });
  } catch (err: any) {
    console.error('getSF10Data error:', err);
    res.status(500).json({ error: err.message });
  }
}