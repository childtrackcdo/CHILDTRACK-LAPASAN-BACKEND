import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import pool from '../../lib/db';

// ─────────────────────────────────────────────────────────────────────────────
// Grade level normalization
// Both teachers.grade_level and students.grade_level are INT columns, but
// several admin forms (Edit Teacher, Enroll/Edit Student) send the full
// label ("Grade 7" .. "Grade 12") from a dropdown. MySQL can't cast that to
// an integer and throws "Incorrect integer value for column 'grade_level'"
// on insert/update. Extract the numeric part before writing to the DB.
// Accepts a number, a "Grade N" string, or a bare numeric string; returns
// null (not NaN) for anything that can't be parsed, so callers can decide
// whether to null it out or reject the request.
// ─────────────────────────────────────────────────────────────────────────────
function normalizeGradeLevel(raw?: string | number | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const match = String(raw).match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

// ─── DASHBOARD STATS ──────────────────────────────────────────────────────────
export async function getAdminStats(req: Request, res: Response): Promise<void> {
  try {
    const [[teacherRow]]: any  = await pool.query('SELECT COUNT(*) AS total FROM teachers');
    const [[studentRow]]: any  = await pool.query("SELECT COUNT(*) AS total FROM students WHERE enrollment_status = 'enrolled'");
    const [[eventRow]]: any    = await pool.query('SELECT COUNT(*) AS total FROM events');
    const [[attendRow]]: any   = await pool.query(
      'SELECT COUNT(*) AS total FROM attendance WHERE date = CURDATE()',
    );
    const [[absentRow]]: any   = await pool.query(
      `SELECT COUNT(*) AS total FROM attendance WHERE date = CURDATE() AND status = 'Absent'`,
    );
    const [[dropoutRow]]: any  = await pool.query(
      `SELECT COUNT(*) AS total FROM students WHERE enrollment_status = 'dropped'`
    );

    const [weeklyAttendance]: any = await pool.query(`
      SELECT DATE(date) AS \`day\`, COUNT(*) AS present
      FROM attendance
      WHERE date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        AND status = 'Present'
      GROUP BY DATE(date)
      ORDER BY \`day\` ASC
    `);

    const [gradeBreakdown]: any = await pool.query(`
      SELECT grade_level, COUNT(*) AS total
      FROM students
      WHERE enrollment_status = 'enrolled'
      GROUP BY grade_level
    `);

    res.json({
      teachers:        teacherRow.total,
      students:        studentRow.total,
      events:          eventRow.total,
      todayAttendance: attendRow.total,
      todayAbsences:   absentRow.total,
      dropouts:        dropoutRow.total,
      weeklyAttendance,
      gradeBreakdown,
    });
  } catch (err: any) {
    console.error('getAdminStats error:', err.sqlMessage ?? err.message);
    res.status(500).json({ error: err.sqlMessage ?? err.message ?? 'Failed to fetch stats' });
  }
}

// ─── TEACHERS ─────────────────────────────────────────────────────────────────
export async function getTeachers(req: Request, res: Response): Promise<void> {
  try {
    const [rows]: any = await pool.query(
      `SELECT id, name, username, employee_id, age, gender, section, grade_level, strand,
              advisory_subject, specialization, contact, address, photo_base64, created_at
       FROM teachers
       ORDER BY created_at DESC`,
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function getTeacherById(req: Request, res: Response): Promise<void> {
  try {
    const [rows]: any = await pool.query(
      `SELECT id, name, username, employee_id, age, gender, section, grade_level, strand,
              advisory_subject, specialization, contact, address, photo_base64, created_at
       FROM teachers WHERE id = ?`,
      [req.params.id],
    );
    if (!rows.length) { res.status(404).json({ error: 'Teacher not found' }); return; }
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function createTeacher(req: Request, res: Response): Promise<void> {
  const {
    name, username, password, employee_id, age, gender, section, grade_level, strand,
    advisory_subject, specialization, contact, address, photo_base64,
  } = req.body;
  if (!name || !username || !password) {
    res.status(400).json({ error: 'name, username, and password are required' });
    return;
  }
  try {
    const [existing]: any = await pool.query('SELECT id FROM teachers WHERE username = ?', [username]);
    if (existing.length) { res.status(409).json({ error: 'Username already taken' }); return; }

    if (employee_id) {
      const [existingEmpId]: any = await pool.query(
        'SELECT id FROM teachers WHERE employee_id = ?',
        [employee_id],
      );
      if (existingEmpId.length) { res.status(409).json({ error: 'Employee ID already in use' }); return; }
    }

    const hashed = await bcrypt.hash(password, 10);
    const [result]: any = await pool.query(
      `INSERT INTO teachers
        (name, username, password, employee_id, age, gender, section, grade_level, strand,
         advisory_subject, specialization, contact, address, photo_base64)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, username, hashed, employee_id ?? null, age ?? null, gender ?? null, section ?? null,
       normalizeGradeLevel(grade_level), strand ?? null, advisory_subject ?? null, specialization ?? null,
       contact ?? null, address ?? null, photo_base64 ?? null],
    );
    res.status(201).json({ id: result.insertId, message: 'Teacher account created' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateTeacher(req: Request, res: Response): Promise<void> {
  const {
    name, username, employee_id, age, gender, section, grade_level, strand,
    advisory_subject, specialization, contact, address, photo_base64,
  } = req.body;
  try {
    if (employee_id) {
      const [existingEmpId]: any = await pool.query(
        'SELECT id FROM teachers WHERE employee_id = ? AND id != ?',
        [employee_id, req.params.id],
      );
      if (existingEmpId.length) { res.status(409).json({ error: 'Employee ID already in use' }); return; }
    }

    await pool.query(
      `UPDATE teachers SET name=?, username=?, employee_id=?, age=?, gender=?, section=?,
       grade_level=?, strand=?, advisory_subject=?, specialization=?, contact=?, address=?, photo_base64=?
       WHERE id=?`,
      [name, username, employee_id ?? null, age ?? null, gender ?? null, section ?? null,
       normalizeGradeLevel(grade_level), strand ?? null, advisory_subject ?? null, specialization ?? null,
       contact ?? null, address ?? null, photo_base64 ?? null, req.params.id],
    );
    res.json({ message: 'Teacher updated' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function resetTeacherPassword(req: Request, res: Response): Promise<void> {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  try {
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE teachers SET password=? WHERE id=?', [hashed, req.params.id]);
    res.json({ message: 'Password reset successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function deleteTeacher(req: Request, res: Response): Promise<void> {
  try {
    await pool.query('DELETE FROM teachers WHERE id=?', [req.params.id]);
    res.json({ message: 'Teacher deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// ─── ADMIN STUDENTS ───────────────────────────────────────────────────────────
export async function adminGetStudents(req: Request, res: Response): Promise<void> {
  const { section, grade_level, enrollment_status, search, teacher_id } = req.query as Record<string, string>;
  try {
    let sql = `SELECT s.* FROM students s WHERE 1=1`;
    const params: any[] = [];
    if (section)           { sql += ' AND s.section = ?';           params.push(section); }
    if (grade_level)       { sql += ' AND s.grade_level = ?';       params.push(grade_level); }
    if (enrollment_status) { sql += ' AND s.enrollment_status = ?'; params.push(enrollment_status); }
    if (teacher_id)        { sql += ' AND s.teacher_id = ?';        params.push(teacher_id); }
    if (search)            { sql += ' AND s.name LIKE ?';           params.push(`%${search}%`); }
    sql += ' ORDER BY s.section ASC, s.name ASC';

    const [students]: any = await pool.query(sql, params);

    // Fetch all guardians for these students in one query, then group in JS.
    // (Avoids JSON_ARRAYAGG / JSON_OBJECT, which aren't available on older
    // MySQL/MariaDB versions — that was causing "FUNCTION ... JSON_ARRAYAGG
    // does not exist".)
    const studentIds = students.map((s: any) => s.id);
    let guardiansByStudent: Record<number, any[]> = {};
    if (studentIds.length) {
      const [guardianRows]: any = await pool.query(
        `SELECT id, student_id, role, name, contact_number, relationship
         FROM parents_guardians WHERE student_id IN (?)`,
        [studentIds],
      );
      for (const g of guardianRows) {
        if (!guardiansByStudent[g.student_id]) guardiansByStudent[g.student_id] = [];
        guardiansByStudent[g.student_id].push({
          id: g.id, role: g.role, name: g.name,
          contact_number: g.contact_number, relationship: g.relationship,
        });
      }
    }

    const parsed = students.map((s: any) => ({
      ...s,
      guardians: guardiansByStudent[s.id] ?? [],
      subjects: [], // student_subjects table not present in this DB
    }));
    res.json(parsed);
  } catch (err: any) {
    console.error('adminGetStudents error:', err.sqlMessage ?? err.message);
    res.status(500).json({ error: err.sqlMessage ?? err.message });
  }
}

export async function adminGetStudentById(req: Request, res: Response): Promise<void> {
  try {
    const [rows]: any = await pool.query('SELECT * FROM students WHERE id = ?', [req.params.id]);
    if (!rows.length) { res.status(404).json({ error: 'Student not found' }); return; }
    const s = rows[0];

    const [guardianRows]: any = await pool.query(
      `SELECT id, role, name, contact_number, relationship, occupation
       FROM parents_guardians WHERE student_id = ?`,
      [s.id],
    );
    s.guardians = guardianRows;
    s.subjects = []; // student_subjects table not present in this DB
    res.json(s);
  } catch (err: any) {
    console.error('adminGetStudentById error:', err.sqlMessage ?? err.message);
    res.status(500).json({ error: err.sqlMessage ?? err.message });
  }
}

export async function adminEnrollStudent(req: Request, res: Response): Promise<void> {
  const conn = await (pool as any).getConnection();
  try {
    await conn.beginTransaction();
    const {
      lrn, name, gender, birthdate, age, birth_place, mother_tongue, ip_ethnic,
      religion, contact, address, barangay, municipality, province,
      section, grade_level, strand, track, school_year,
      teacher_id, guardians = [],
    } = req.body;

    if (!lrn || !name || !section || !grade_level || !teacher_id) {
      res.status(400).json({ error: 'lrn, name, section, grade_level, and teacher_id are required' });
      await conn.rollback(); conn.release(); return;
    }

    const normalizedGradeLevel = normalizeGradeLevel(grade_level);
    if (normalizedGradeLevel === null) {
      res.status(400).json({ error: 'Invalid grade level.' });
      await conn.rollback(); conn.release(); return;
    }

    const [existing]: any = await conn.query(
      'SELECT id FROM students WHERE lrn = ?', [lrn],
    );
    if (existing.length) {
      res.status(409).json({ error: 'A student with this LRN already exists' });
      await conn.rollback(); conn.release(); return;
    }

    const [result]: any = await conn.query(
      `INSERT INTO students
        (teacher_id, lrn, name, gender, birthdate, age, birth_place, mother_tongue,
         ip_ethnic, religion, contact, address, barangay, municipality, province,
         section, grade_level, strand, track, school_year, enrollment_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'enrolled')`,
      [teacher_id, lrn, name, gender ?? null, birthdate ?? null, age ?? null,
       birth_place ?? null, mother_tongue ?? null, ip_ethnic ?? null, religion ?? null,
       contact ?? null, address ?? null, barangay ?? null, municipality ?? null,
       province ?? null, section, normalizedGradeLevel, strand ?? null, track ?? null,
       school_year ?? '2024-2025'],
    );
    const studentId = result.insertId;

    for (const g of guardians) {
      await conn.query(
        `INSERT INTO parents_guardians (student_id, role, name, contact_number, occupation, highest_educ, relationship)
         VALUES (?,?,?,?,?,?,?)`,
        [studentId, g.role ?? 'Parent 1', g.name, g.contact_number ?? null,
         g.occupation ?? null, g.highest_educ ?? null, g.relationship ?? null],
      );
    }

    await conn.commit();
    res.status(201).json({ id: studentId, message: 'Student enrolled successfully' });
  } catch (err: any) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
}

export async function adminUpdateStudent(req: Request, res: Response): Promise<void> {
  const {
    lrn, name, gender, birthdate, age, birth_place, mother_tongue, ip_ethnic,
    religion, contact, address, barangay, municipality, province,
    section, grade_level, strand, track, school_year, enrollment_status,
  } = req.body;
  try {
    // The Edit Student form doesn't send enrollment_status — it's only set
    // via the dedicated status endpoint (approve/reject) or the Enroll form.
    // Defaulting a missing value to 'enrolled' here would silently flip a
    // pending self-registration to enrolled the moment an admin edits any
    // other field. Preserve whatever status is already on the row instead.
    let resolvedStatus = enrollment_status;
    if (!resolvedStatus) {
      const [existingRows]: any = await pool.query(
        'SELECT enrollment_status FROM students WHERE id = ?',
        [req.params.id],
      );
      resolvedStatus = existingRows[0]?.enrollment_status ?? 'enrolled';
    }

    await pool.query(
      `UPDATE students SET
        lrn=?, name=?, gender=?, birthdate=?, age=?, birth_place=?, mother_tongue=?,
        ip_ethnic=?, religion=?, contact=?, address=?, barangay=?, municipality=?,
        province=?, section=?, grade_level=?, strand=?, track=?, school_year=?,
        enrollment_status=?
       WHERE id=?`,
      [lrn, name, gender ?? null, birthdate ?? null, age ?? null, birth_place ?? null,
       mother_tongue ?? null, ip_ethnic ?? null, religion ?? null, contact ?? null,
       address ?? null, barangay ?? null, municipality ?? null, province ?? null,
       section, normalizeGradeLevel(grade_level), strand ?? null, track ?? null, school_year ?? '2024-2025',
       resolvedStatus, req.params.id],
    );
    res.json({ message: 'Student updated' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function adminDeleteStudent(req: Request, res: Response): Promise<void> {
  try {
    await pool.query('DELETE FROM students WHERE id=?', [req.params.id]);
    res.json({ message: 'Student removed' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// Lightweight status-only update — used to approve/reject a pending
// self-registration (from the public QR form) without overwriting every
// other field on the student, unlike adminUpdateStudent.
const VALID_ENROLLMENT_STATUSES = ['pending', 'enrolled', 'dropped', 'dropped_out', 'inactive', 'rejected'];

export async function adminUpdateStudentStatus(req: Request, res: Response): Promise<void> {
  const { enrollment_status } = req.body;
  if (!enrollment_status || !VALID_ENROLLMENT_STATUSES.includes(enrollment_status)) {
    res.status(400).json({ error: `enrollment_status must be one of: ${VALID_ENROLLMENT_STATUSES.join(', ')}` });
    return;
  }
  try {
    const [result]: any = await pool.query(
      'UPDATE students SET enrollment_status=? WHERE id=?',
      [enrollment_status, req.params.id],
    );
    if (!result.affectedRows) { res.status(404).json({ error: 'Student not found' }); return; }
    res.json({ message: `Student marked as ${enrollment_status}` });
  } catch (err: any) {
    res.status(500).json({ error: err.sqlMessage ?? err.message });
  }
}

// ─── ADMIN ATTENDANCE ─────────────────────────────────────────────────────────
export async function adminGetAttendance(req: Request, res: Response): Promise<void> {
  const { date, section, status, teacher_id, search } = req.query as Record<string, string>;
  try {
    let sql = `SELECT * FROM attendance WHERE 1=1`;
    const params: any[] = [];
    if (date)       { sql += ' AND date = ?';              params.push(date); }
    if (section)    { sql += ' AND section = ?';           params.push(section); }
    if (status)     { sql += ' AND status = ?';            params.push(status); }
    if (teacher_id) { sql += ' AND teacher_id = ?';        params.push(teacher_id); }
    if (search)     { sql += ' AND student_name LIKE ?';   params.push(`%${search}%`); }
    sql += ' ORDER BY date DESC, timestamp DESC LIMIT 3000';
    const [rows]: any = await pool.query(sql, params);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function adminGetAttendanceSummary(req: Request, res: Response): Promise<void> {
  const { date } = req.query as Record<string, string>;
  const target = date ?? new Date().toISOString().split('T')[0];
  try {
    const [[row]]: any = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(status = 'Present')    AS present,
        SUM(status = 'Absent')     AS absent,
        SUM(status = 'Late')       AS late,
        SUM(status = 'Dropped Out') AS dropped
      FROM attendance WHERE date = ?`, [target]);
    res.json({ date: target, ...row });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// ─── ADMIN EVENTS ─────────────────────────────────────────────────────────────
export async function adminGetEvents(req: Request, res: Response): Promise<void> {
  try {
    const [rows]: any = await pool.query(
      `SELECT e.*, t.name AS teacher_name
       FROM events e
       LEFT JOIN teachers t ON t.id = e.teacher_id
       ORDER BY e.scheduled_at DESC`,
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function adminCreateEvent(req: Request, res: Response): Promise<void> {
  const { title, description, event_type, scheduled_at, location, teacher_id } = req.body;
  if (!title || !scheduled_at) {
    res.status(400).json({ error: 'title and scheduled_at are required' });
    return;
  }
  try {
    const [result]: any = await pool.query(
      `INSERT INTO events (teacher_id, title, description, event_type, scheduled_at, location)
       VALUES (?,?,?,?,?,?)`,
      [teacher_id ?? null, title, description ?? null, event_type ?? 'General',
       scheduled_at, location ?? null],
    );
    res.status(201).json({ id: result.insertId, message: 'Event created' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function adminUpdateEvent(req: Request, res: Response): Promise<void> {
  const { title, description, event_type, scheduled_at, location, teacher_id } = req.body;
  try {
    await pool.query(
      `UPDATE events SET title=?, description=?, event_type=?, scheduled_at=?, location=?, teacher_id=?
       WHERE id=?`,
      [title, description ?? null, event_type ?? 'General', scheduled_at,
       location ?? null, teacher_id ?? null, req.params.id],
    );
    res.json({ message: 'Event updated' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function adminDeleteEvent(req: Request, res: Response): Promise<void> {
  try {
    await pool.query('DELETE FROM events WHERE id=?', [req.params.id]);
    res.json({ message: 'Event deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// ─── ADMIN PROFILE ────────────────────────────────────────────────────────────
export async function updateAdminProfile(req: Request, res: Response): Promise<void> {
  const adminId = (req as any).admin?.id;
  if (!adminId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const { name, username, contact, address, photo_base64 } = req.body;
  try {
    await pool.query(
      `UPDATE admins SET name=?, username=?, contact=?, address=?, photo_base64=? WHERE id=?`,
      [name ?? null, username ?? null, contact ?? null, address ?? null, photo_base64 ?? null, adminId],
    );
    res.json({ message: 'Profile updated' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function changeAdminPassword(req: Request, res: Response): Promise<void> {
  const adminId = (req as any).admin?.id;
  if (!adminId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }
  try {
    const [rows]: any = await pool.query('SELECT password FROM admins WHERE id=?', [adminId]);
    if (!rows.length) { res.status(404).json({ error: 'Admin not found' }); return; }
    const valid = await bcrypt.compare(currentPassword ?? '', rows[0].password);
    if (!valid) { res.status(401).json({ error: 'Current password is incorrect' }); return; }
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE admins SET password=? WHERE id=?', [hashed, adminId]);
    res.json({ message: 'Password changed successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// ─── ADMIN IN & OUT ───────────────────────────────────────────────────────────
export async function adminGetInOut(req: Request, res: Response): Promise<void> {
  const { date, section, status, direction, confirmed, search } = req.query as Record<string, string>;
  try {
    let sql = `SELECT * FROM in_out_campus WHERE 1=1`;
    const params: any[] = [];
    if (date)      { sql += ' AND date = ?';                    params.push(date); }
    if (section)   { sql += ' AND section = ?';                 params.push(section); }
    if (status)    { sql += ' AND status = ?';                  params.push(status); }
    if (direction) { sql += ' AND direction = ?';                params.push(direction); }
    if (confirmed === 'confirmed')   sql += ' AND confirmed = 1';
    if (confirmed === 'unconfirmed') sql += ' AND confirmed = 0';
    if (search)    { sql += ' AND (student_name LIKE ? OR lrn LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY date DESC, timestamp DESC LIMIT 3000';
    const [rows]: any = await pool.query(sql, params);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.sqlMessage ?? err.message });
  }
}