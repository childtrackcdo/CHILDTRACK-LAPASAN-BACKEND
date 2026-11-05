import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../../lib/db';
import { AuthRequest } from '../../middleware/authMiddleware';

// ─── Normalize gender from 'Male'/'Female' to 'M'/'F' for DB ENUM ────────────
function normalizeGender(raw: any): 'M' | 'F' | null {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'm' || v === 'male')   return 'M';
  if (v === 'f' || v === 'female') return 'F';
  return null;
}

// ─── GET /api/students ────────────────────────────────────────────────────────
export async function getStudents(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { section, grade_level, strand, search, enrollment_status, all } =
      req.query as Record<string, string>;

    const fetchAll = all === 'true';

    let sql = `
      SELECT
        s.id, s.lrn, s.name, s.gender, s.birthdate, s.age,
        s.contact, s.address,
        s.grade_level, s.section, s.strand, s.track,
        s.school_year, s.enrollment_status,
        s.birth_place, s.mother_tongue, s.ip_ethnic,
        s.religion, s.barangay, s.municipality, s.province, s.remarks,
        s.photo,
        s.parent_is_active, s.student_is_active, s.created_at,
        t.name AS teacher_name
      FROM students s
      LEFT JOIN teachers t ON t.id = s.teacher_id
      WHERE 1=1
    `;
    const params: any[] = [];

        if (section) {
      // A subject teacher viewing a class they teach but may not advise.
      // Section values arrive in two formats across the app: full
      // ("Grade 11 - Rizal", used by GradesPage/student_schedules) and
      // short ("mabini", used by DashboardPage). Tolerate both.
      if (!fetchAll) {
        const [teacherRow] = await pool.execute(
          `SELECT section FROM teachers WHERE id = ?`,
          [teacherId],
        ) as any[];
        const advisorySection = ((teacherRow as any[])[0]?.section ?? '').toLowerCase();
        const sectionLower = section.toLowerCase();
        const isOwnAdvisory = advisorySection && (
          advisorySection.includes(sectionLower) || sectionLower.includes(advisorySection)
        );

        if (!isOwnAdvisory) {
          const [scheduleCheck] = await pool.execute(
            `SELECT 1 FROM student_schedules WHERE teacher_id = ? AND section LIKE ? LIMIT 1`,
            [teacherId, `%${section}%`],
          ) as any[];
          if (!(scheduleCheck as any[]).length) {
            res.status(403).json({ error: 'You do not have a schedule for this section' });
            return;
          }
        }
      }
      sql += ' AND s.section LIKE ?';
      params.push(`%${section}%`);
    } else if (!fetchAll) {
      // No section given — fall back to advisory ownership (Students page).
      sql += ' AND s.teacher_id = ?';
      params.push(teacherId);
    }

    if (grade_level && grade_level !== '0') {
      sql += ' AND s.grade_level = ?';
      params.push(grade_level);
    }
    if (strand) {
      sql += ' AND s.strand = ?';
      params.push(strand);
    }
    if (enrollment_status) {
      sql += ' AND s.enrollment_status = ?';
      params.push(enrollment_status);
    }
    if (search) {
      sql += ' AND (s.name LIKE ? OR s.lrn LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY s.name';

    const [rows] = await pool.execute(sql, params) as any[];
    const studentIds = (rows as any[]).map((r: any) => r.id);

    let pgMap: Record<number, any[]> = {};
    if (studentIds.length > 0) {
      const placeholders = studentIds.map(() => '?').join(',');
      const [pgs] = await pool.execute(
        `SELECT student_id, role, name, contact_number, occupation, highest_educ
         FROM parents_guardians
         WHERE student_id IN (${placeholders})`,
        studentIds,
      ) as any[];
      for (const pg of pgs as any[]) {
        if (!pgMap[pg.student_id]) pgMap[pg.student_id] = [];
        pgMap[pg.student_id].push(pg);
      }
    }

    const enriched = (rows as any[]).map((r: any) => ({
      ...r,
      parents_guardians: JSON.stringify(pgMap[r.id] ?? []),
    }));

    res.json(enriched);
  } catch (err: any) {
    console.error('getStudents error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/students/:id ────────────────────────────────────────────────────
export async function getStudentById(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { id }    = req.params;

    const [rows] = await pool.execute(
      `SELECT
         s.*,
         t.name AS teacher_name, t.section AS teacher_section
       FROM students s
       LEFT JOIN teachers t ON t.id = s.teacher_id
       WHERE s.id = ? AND s.teacher_id = ?`,
      [id, teacherId],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Student not found' });
      return;
    }

    const student = (rows as any[])[0];

    const [guardians] = await pool.execute(
      'SELECT * FROM parents_guardians WHERE student_id = ?',
      [id],
    ) as any[];

    res.json({ ...student, parents_guardians: guardians });
  } catch (err: any) {
    console.error('getStudentById error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/students/lrn/:lrn ──────────────────────────────────────────────
export async function getStudentByLRN(req: Request, res: Response): Promise<void> {
  try {
    const { lrn } = req.params;

    const [rows] = await pool.execute(
      `SELECT s.*, t.name AS teacher_name, t.section AS teacher_section
       FROM students s
       LEFT JOIN teachers t ON t.id = s.teacher_id
       WHERE s.lrn = ?
       LIMIT 1`,
      [lrn],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Student not found' });
      return;
    }

    res.json((rows as any[])[0]);
  } catch (err: any) {
    console.error('getStudentByLRN error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/students/qr-by-lrn/:lrn ───────────────────────────────────────
// Used by the parent mobile app to fetch the child's stored QR code image.
// Requires a valid parent JWT (authMiddleware applied in the router).
export async function getStudentQrByLrn(req: Request, res: Response): Promise<void> {
  try {
    const { lrn } = req.params;

    const [rows] = await pool.execute(
      'SELECT qr_code FROM students WHERE lrn = ? LIMIT 1',
      [lrn],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Student not found' });
      return;
    }

    const qr_code = (rows as any[])[0].qr_code;

    if (!qr_code) {
      res.status(404).json({ error: 'No QR code on file for this student' });
      return;
    }

    res.json({ qr_code });
  } catch (err: any) {
    console.error('getStudentQrByLrn error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── POST /api/students ───────────────────────────────────────────────────────
export async function createStudent(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const {
      lrn, name, gender, birthdate, age,
      contact, address,
      grade_level, section, strand, track,
      school_year, enrollment_status,
      birth_place, mother_tongue, ip_ethnic,
      religion, barangay, municipality, province, remarks,
      photo,
      parents_guardians,
    } = req.body;

    if (!lrn || !name || !grade_level) {
      res.status(400).json({ error: 'lrn, name, and grade_level are required' });
      return;
    }

    if (!String(lrn).match(/^\d{12}$/)) {
      res.status(400).json({ error: 'LRN must be exactly 12 digits' });
      return;
    }

    const [existing] = await pool.execute(
      'SELECT id FROM students WHERE lrn = ?',
      [lrn],
    ) as any[];

    if ((existing as any[]).length > 0) {
      res.status(409).json({ error: 'A student with this LRN already exists' });
      return;
    }

    const [result] = await pool.execute(
      `INSERT INTO students
         (lrn, name, gender, birthdate, age, contact, address,
          grade_level, section, strand, track,
          school_year, teacher_id, enrollment_status,
          birth_place, mother_tongue, ip_ethnic,
          religion, barangay, municipality, province, remarks, photo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        lrn,
        name,
        normalizeGender(gender),
        birthdate     || null,
        age           || null,
        contact       || null,
        address       || null,
        grade_level,
        section       || null,
        strand        || null,
        track         || null,
        school_year   || null,
        teacherId,
        enrollment_status || 'pending',
        birth_place   || null,
        mother_tongue || null,
        ip_ethnic     || null,
        religion      || null,
        barangay      || null,
        municipality  || null,
        province      || null,
        remarks       || null,
        photo         || null,
      ],
    ) as any[];

    const studentId = (result as any).insertId;

    // ── Save parents_guardians with occupation + highest_educ ──
    if (Array.isArray(parents_guardians) && parents_guardians.length > 0) {
      for (const pg of parents_guardians) {
        if (!pg.name?.trim()) continue;
        await pool.execute(
          `INSERT INTO parents_guardians
             (student_id, role, name, contact_number, occupation, highest_educ)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            studentId,
            pg.role          || 'Guardian',
            pg.name.trim(),
            pg.contact_number?.trim() || null,
            pg.occupation?.trim()     || null,
            pg.highest_educ?.trim()   || null,
          ],
        );
      }
    }

    res.status(201).json({
      id:      studentId,
      message: 'Student created successfully',
    });
  } catch (err: any) {
    console.error('createStudent error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'A student with this LRN already exists' });
      return;
    }
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/students/:id ──────────────────────────────────────────────────
export async function updateStudent(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { id }    = req.params;
    const {
      lrn, name, gender, birthdate, age,
      contact, address,
      grade_level, section, strand, track,
      school_year, enrollment_status,
      birth_place, mother_tongue, ip_ethnic,
      religion, barangay, municipality, province, remarks,
      photo,
      parents_guardians,
    } = req.body;

    if (lrn) {
      const [dup] = await pool.execute(
        'SELECT id FROM students WHERE lrn = ? AND id != ?',
        [lrn, id],
      ) as any[];

      if ((dup as any[]).length > 0) {
        res.status(409).json({ error: 'Another student already has this LRN' });
        return;
      }
    }

    const fields: string[] = [];
    const values: any[]    = [];

    if (lrn               !== undefined) { fields.push('lrn = ?');               values.push(lrn); }
    if (name              !== undefined) { fields.push('name = ?');              values.push(name); }
    if (gender            !== undefined) { fields.push('gender = ?');            values.push(normalizeGender(gender)); }
    if (birthdate         !== undefined) { fields.push('birthdate = ?');         values.push(birthdate || null); }
    if (age               !== undefined) { fields.push('age = ?');               values.push(age || null); }
    if (contact           !== undefined) { fields.push('contact = ?');           values.push(contact || null); }
    if (address           !== undefined) { fields.push('address = ?');           values.push(address || null); }
    if (grade_level       !== undefined) { fields.push('grade_level = ?');       values.push(grade_level || null); }
    if (section           !== undefined) { fields.push('section = ?');           values.push(section || null); }
    if (strand            !== undefined) { fields.push('strand = ?');            values.push(strand || null); }
    if (track             !== undefined) { fields.push('track = ?');             values.push(track || null); }
    if (school_year       !== undefined) { fields.push('school_year = ?');       values.push(school_year || null); }
    if (enrollment_status !== undefined) { fields.push('enrollment_status = ?'); values.push(enrollment_status); }
    if (birth_place       !== undefined) { fields.push('birth_place = ?');       values.push(birth_place || null); }
    if (mother_tongue     !== undefined) { fields.push('mother_tongue = ?');     values.push(mother_tongue || null); }
    if (ip_ethnic         !== undefined) { fields.push('ip_ethnic = ?');         values.push(ip_ethnic || null); }
    if (religion          !== undefined) { fields.push('religion = ?');          values.push(religion || null); }
    if (barangay          !== undefined) { fields.push('barangay = ?');          values.push(barangay || null); }
    if (municipality      !== undefined) { fields.push('municipality = ?');      values.push(municipality || null); }
    if (province          !== undefined) { fields.push('province = ?');          values.push(province || null); }
    if (remarks           !== undefined) { fields.push('remarks = ?');           values.push(remarks || null); }
    if (photo             !== undefined) { fields.push('photo = ?');             values.push(photo || null); }

    if (!fields.length && !Array.isArray(parents_guardians)) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    if (fields.length) {
      values.push(id, teacherId);
      const [result] = await pool.execute(
        `UPDATE students SET ${fields.join(', ')} WHERE id = ? AND teacher_id = ?`,
        values,
      ) as any[];

      if ((result as any).affectedRows === 0) {
        res.status(404).json({ error: 'Student not found or not yours' });
        return;
      }
    }

    // ── Replace parents_guardians with occupation + highest_educ ──
    if (Array.isArray(parents_guardians)) {
      await pool.execute('DELETE FROM parents_guardians WHERE student_id = ?', [id]);
      for (const pg of parents_guardians) {
        if (!pg.name?.trim()) continue;
        await pool.execute(
          `INSERT INTO parents_guardians
             (student_id, role, name, contact_number, occupation, highest_educ)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            id,
            pg.role          || 'Guardian',
            pg.name.trim(),
            pg.contact_number?.trim() || null,
            pg.occupation?.trim()     || null,
            pg.highest_educ?.trim()   || null,
          ],
        );
      }
    }

    res.json({ message: 'Student updated successfully' });
  } catch (err: any) {
    console.error('updateStudent error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── DELETE /api/students/:id ─────────────────────────────────────────────────
export async function deleteStudent(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { id }    = req.params;

    const [result] = await pool.execute(
      'DELETE FROM students WHERE id = ? AND teacher_id = ?',
      [id, teacherId],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Student not found or not yours' });
      return;
    }

    res.json({ message: 'Student deleted successfully' });
  } catch (err: any) {
    console.error('deleteStudent error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/students/:id/status ──────────────────────────────────────────
export async function updateStudentEnrollmentStatus(
  req: AuthRequest,
  res: Response,
): Promise<void> {
  try {
    const teacherId         = req.teacher!.id;
    const { id }            = req.params;
    const { enrollment_status } = req.body;

    const allowed = ['pending', 'enrolled', 'dropped', 'transferred'];
    if (!allowed.includes(enrollment_status)) {
      res.status(400).json({ error: `enrollment_status must be one of: ${allowed.join(', ')}` });
      return;
    }

    const [result] = await pool.execute(
      'UPDATE students SET enrollment_status = ? WHERE id = ? AND teacher_id = ?',
      [enrollment_status, id, teacherId],
    ) as any[];

    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Student not found or not yours' });
      return;
    }

    res.json({ message: 'Enrollment status updated', enrollment_status });
  } catch (err: any) {
    console.error('updateStudentEnrollmentStatus error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/students/stats ──────────────────────────────────────────────────
export async function getStudentStats(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { section } = req.query as Record<string, string>;

    const sectionClause = section ? ' AND section LIKE ?' : '';
    const baseParams    = section ? [teacherId, `%${section}%`] : [teacherId];

    const [byGrade] = await pool.execute(
      `SELECT grade_level, strand, enrollment_status, COUNT(*) AS count
       FROM students
       WHERE teacher_id = ?${sectionClause}
       GROUP BY grade_level, strand, enrollment_status
       ORDER BY grade_level, strand`,
      baseParams,
    ) as any[];

    const [totals] = await pool.execute(
      `SELECT
         COUNT(*) AS total,
         SUM(enrollment_status = 'enrolled')    AS enrolled,
         SUM(enrollment_status = 'pending')     AS pending,
         SUM(enrollment_status = 'dropped')     AS dropped,
         SUM(enrollment_status = 'transferred') AS transferred,
         SUM(gender = 'M') AS male,
         SUM(gender = 'F') AS female
       FROM students
       WHERE teacher_id = ?${sectionClause}`,
      baseParams,
    ) as any[];

    res.json({
      totals:   (totals as any[])[0],
      by_grade: byGrade,
    });
  } catch (err: any) {
    console.error('getStudentStats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/students/:id/dropout ─────────────────────────────────────────
export async function dropoutStudent(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { id }    = req.params;

    const [rows] = await pool.execute(
      'SELECT * FROM students WHERE id = ? AND teacher_id = ?',
      [id, teacherId],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Student not found or not yours' });
      return;
    }

    const student = (rows as any[])[0];

    await pool.execute(
      `UPDATE students SET enrollment_status = 'dropped' WHERE id = ? AND teacher_id = ?`,
      [id, teacherId],
    );

    const today = new Date().toISOString().slice(0, 10);

    const [existing] = await pool.execute(
      `SELECT id FROM attendance
       WHERE teacher_id = ? AND student_name = ? AND DATE(date) = ?
         AND status = 'Dropped Out'`,
      [teacherId, student.name, today],
    ) as any[];

    if (!(existing as any[]).length) {
      await pool.execute(
        `INSERT INTO attendance
           (teacher_id, student_name, lrn, gender, status, session, date, section)
         VALUES (?, ?, ?, ?, 'Dropped Out', 'AM', ?, ?)`,
        [
          teacherId,
          student.name,
          student.lrn    || null,
          student.gender || null,
          today,
          student.section || null,
        ],
      );
    }

    res.json({ message: 'Student marked as dropped out' });
  } catch (err: any) {
    console.error('dropoutStudent error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/students/:id/activate-parent ─────────────────────────────────
// First activation: creates a real row in parent_accounts (username/password
// default to the student's LRN, bcrypt-hashed). Subsequent toggles just flip
// is_active on the existing row — the password is never touched again here,
// in case the parent already changed it.
export async function activateParentAccount(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { id } = req.params;

    const [studentRows] = await pool.execute(
      'SELECT id, name, lrn, parent_is_active FROM students WHERE id = ? AND teacher_id = ?',
      [id, teacherId],
    ) as any[];

    if (!(studentRows as any[]).length) {
      res.status(404).json({ error: 'Student not found or not yours' });
      return;
    }

    const student = (studentRows as any[])[0];

    const [existingAccount] = await pool.execute(
      'SELECT id, is_active FROM parent_accounts WHERE lrn = ?',
      [student.lrn],
    ) as any[];

    let newState: boolean;

    if ((existingAccount as any[]).length) {
      // Account already exists — just toggle is_active, leave password alone.
      newState = !(existingAccount as any[])[0].is_active;
      await pool.execute(
        'UPDATE parent_accounts SET is_active = ? WHERE lrn = ?',
        [newState, student.lrn],
      );
    } else {
      // First-time activation — create the account.
      // Pull Parent 1's name if on file, otherwise fall back to a placeholder.
      const [guardianRows] = await pool.execute(
        `SELECT name FROM parents_guardians
         WHERE student_id = ? AND role = 'Parent 1' AND name IS NOT NULL AND name != ''
         LIMIT 1`,
        [id],
      ) as any[];

      const parentName = (guardianRows as any[])[0]?.name?.trim() || `Parent of ${student.name}`;
      const hashedPassword = await bcrypt.hash(student.lrn, 10);

      await pool.execute(
        `INSERT INTO parent_accounts
           (name, username, password, student_name, lrn, teacher_id, theme, font_size, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 'light', 'medium', 1)`,
        [parentName, student.lrn, hashedPassword, student.name, student.lrn, teacherId],
      );

      newState = true;
    }

    // Keep the students.parent_is_active flag in sync for the table UI.
    await pool.execute(
      'UPDATE students SET parent_is_active = ? WHERE id = ? AND teacher_id = ?',
      [newState, id, teacherId],
    );

    res.json({ is_active: newState });
  } catch (err: any) {
    console.error('activateParentAccount error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── PATCH /api/students/:id/activate-student ────────────────────────────────
// Same pattern as activateParentAccount, against student_accounts instead.
export async function activateStudentAccount(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId = req.teacher!.id;
    const { id } = req.params;

    const [studentRows] = await pool.execute(
      'SELECT id, name, lrn, student_is_active FROM students WHERE id = ? AND teacher_id = ?',
      [id, teacherId],
    ) as any[];

    if (!(studentRows as any[]).length) {
      res.status(404).json({ error: 'Student not found or not yours' });
      return;
    }

    const student = (studentRows as any[])[0];

    const [existingAccount] = await pool.execute(
      'SELECT id, is_active FROM student_accounts WHERE lrn = ?',
      [student.lrn],
    ) as any[];

    let newState: boolean;

    if ((existingAccount as any[]).length) {
      newState = !(existingAccount as any[])[0].is_active;
      await pool.execute(
        'UPDATE student_accounts SET is_active = ? WHERE lrn = ?',
        [newState, student.lrn],
      );
    } else {
      const hashedPassword = await bcrypt.hash(student.lrn, 10);

      await pool.execute(
        `INSERT INTO student_accounts
           (name, username, password, lrn, teacher_id, theme, font_size, is_active)
         VALUES (?, ?, ?, ?, ?, 'light', 'medium', 1)`,
        [student.name, student.lrn, hashedPassword, student.lrn, teacherId],
      );

      newState = true;
    }

    await pool.execute(
      'UPDATE students SET student_is_active = ? WHERE id = ? AND teacher_id = ?',
      [newState, id, teacherId],
    );

    res.json({ is_active: newState });
  } catch (err: any) {
    console.error('activateStudentAccount error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/students/sections ──────────────────────────────────────────────
export async function getDistinctSections(req: Request, res: Response): Promise<void> {
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT section
       FROM students
       WHERE section IS NOT NULL
         AND TRIM(section) != ''
       ORDER BY section ASC`
    ) as any[];

    res.json((rows as any[]).map((r: any) => r.section as string));
  } catch (err: any) {
    console.error('getDistinctSections error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}