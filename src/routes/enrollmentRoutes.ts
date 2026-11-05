import { Response } from 'express';
import pool from '../../lib/db';
import { AuthRequest } from '../../middleware/authMiddleware';

const bool = (v: any): boolean =>
  v === true || v === 1 || v === '1' || v === 'true';

function parseBody(body: any) {
  let parents_guardians = body.parents_guardians;
  if (typeof parents_guardians === 'string') {
    try { parents_guardians = JSON.parse(parents_guardians); } catch { parents_guardians = []; }
  }

  // Build full name from parts if individual name fields provided
  const name: string =
    body.name?.trim() ||
    (() => {
      const last  = body.last_name?.trim()  || '';
      const first = body.first_name?.trim() || '';
      const mid   = body.middle_name?.trim() || '';
      const suf   = body.suffix?.trim() || '';
      if (!last && !first) return '';
      return `${last}, ${first}${mid ? ' ' + mid : ''}${suf ? ' ' + suf : ''}`;
    })();

  return { ...body, name, parents_guardians };
}

// ─── GET /api/enrollments ─────────────────────────────────────────────────────
export async function getEnrollments(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { sy, grade_level, strand, status, search, section } =
      req.query as Record<string, string>;

    let sql = `
      SELECT
        e.id, e.lrn, e.school_year, e.grade_level, e.section,
        e.strand, e.track, e.status, e.enrolled_at, e.approved_at,
        e.last_school_attended, e.last_school_id, e.last_grade_completed,
        e.last_sy_completed, e.transfer_credential,
        e.returning_learner, e.indigenous_people, e.ip_group,
        e.pwd, e.pwd_type, e.working_student, e.solo_parent,
        e.\`4Ps_beneficiary\`, e.remarks,
        s.name   AS student_name,
        s.gender, s.birthdate, s.age,
        s.address, s.barangay, s.municipality, s.province,
        s.contact, s.religion, s.birth_place,
        s.enrollment_status,
        t.name   AS encoded_by_name
      FROM enrollments e
      JOIN students s ON s.id = e.student_id
      LEFT JOIN teachers t ON t.id = e.encoded_by
      WHERE 1=1
    `;
    const params: any[] = [];

    if (sy)          { sql += ' AND e.school_year = ?'; params.push(sy); }
    if (grade_level) { sql += ' AND e.grade_level = ?'; params.push(grade_level); }
    if (strand)      { sql += ' AND e.strand = ?';      params.push(strand); }
    if (status)      { sql += ' AND e.status = ?';      params.push(status); }
    if (section)     { sql += ' AND e.section = ?';     params.push(section); }
    if (search) {
      sql += ' AND (s.name LIKE ? OR e.lrn LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY e.enrolled_at DESC';

    const [rows] = await pool.execute(sql, params) as any[];
    res.json(rows);
  } catch (err: any) {
    console.error('getEnrollments error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/enrollments/stats ───────────────────────────────────────────────
export async function getEnrollmentStats(req: AuthRequest, res: Response): Promise<void> {
  try {
    const currentYear = new Date().getFullYear();
    const sy = (req.query.sy as string) || `${currentYear}-${currentYear + 1}`;

    const [byGrade] = await pool.execute(
      `SELECT grade_level, strand, status, COUNT(*) AS count
       FROM enrollments WHERE school_year = ?
       GROUP BY grade_level, strand, status ORDER BY grade_level, strand`,
      [sy],
    ) as any[];

    const [totals] = await pool.execute(
      `SELECT COUNT(*) AS total,
         SUM(status = 'enrolled')  AS approved,
         SUM(status = 'pending')   AS pending,
         SUM(status = 'rejected')  AS rejected
       FROM enrollments WHERE school_year = ?`,
      [sy],
    ) as any[];

    const [byStrand] = await pool.execute(
      `SELECT strand, COUNT(*) AS count
       FROM enrollments
       WHERE school_year = ? AND status = 'enrolled'
         AND strand IS NOT NULL AND strand != ''
       GROUP BY strand ORDER BY count DESC`,
      [sy],
    ) as any[];

    res.json({ school_year: sy, totals: (totals as any[])[0], by_grade: byGrade, by_strand: byStrand });
  } catch (err: any) {
    console.error('getEnrollmentStats error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/enrollments/:id ─────────────────────────────────────────────────
export async function getEnrollmentById(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT e.*,
              s.name AS student_name,
              s.gender, s.birthdate, s.age,
              s.address, s.barangay, s.municipality, s.province,
              s.contact, s.religion, s.birth_place,
              s.enrollment_status
       FROM enrollments e
       JOIN students s ON s.id = e.student_id
       WHERE e.id = ?`,
      [id],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Enrollment not found' });
      return;
    }

    const enrollment = (rows as any[])[0];

    const [guardians] = await pool.execute(
      'SELECT * FROM parents_guardians WHERE student_id = ?',
      [enrollment.student_id],
    ) as any[];

    res.json({ ...enrollment, parents_guardians: guardians });
  } catch (err: any) {
    console.error('getEnrollmentById error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── Helper: build guardian list from body ────────────────────────────────────
function buildGuardianList(b: any) {
  const list: Array<{ role: string; name: string; contact?: string; occ?: string; rel?: string }> = [];

  if (Array.isArray(b.parents_guardians) && b.parents_guardians.length > 0) {
    b.parents_guardians.forEach((pg: any) => {
      if (pg.name?.trim()) {
        list.push({ role: pg.role, name: pg.name.trim(), contact: pg.contact_number, occ: pg.occupation });
      }
    });
  }

  // Flat fields (from wizard form)
  if (b.guardian_name?.trim() && !list.find(p => p.role === 'guardian')) {
    list.push({ role: 'guardian', name: b.guardian_name.trim(), contact: b.guardian_contact, occ: b.guardian_occupation, rel: b.guardian_relationship });
  }
  if (b.father_name?.trim() && !list.find(p => p.role === 'father')) {
    list.push({ role: 'father', name: b.father_name.trim(), contact: b.father_contact, occ: b.father_occupation });
  }
  if (b.mother_name?.trim() && !list.find(p => p.role === 'mother')) {
    list.push({ role: 'mother', name: b.mother_name.trim(), contact: b.mother_contact, occ: b.mother_occupation });
  }

  return list;
}

// ─── POST /api/enrollments ────────────────────────────────────────────────────
export async function createEnrollment(req: AuthRequest, res: Response): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const b = parseBody(req.body);
    const {
      lrn, name, gender, birthdate, age, contact,
      address, barangay, municipality, province,
      birth_place, religion,
      grade_level, section, strand, track, school_year,
      learner_type,
      last_school_attended, last_school_id, last_grade_completed, last_sy_completed,
      transfer_credential, returning_learner, indigenous_people, ip_group,
      pwd, pwd_type, working_student, solo_parent, fourPs, fourPs_household_id,
      remarks,
    } = b;

    if (!lrn || !name || !gender || !grade_level || !school_year) {
      res.status(400).json({ error: 'LRN, name, gender, grade_level, and school_year are required' });
      conn.release();
      return;
    }
    if (!String(lrn).match(/^\d{12}$/)) {
      res.status(400).json({ error: 'LRN must be exactly 12 digits' });
      conn.release();
      return;
    }

    // ── 1. Upsert student (matches actual table schema) ───────────────────────
    const [existing] = await conn.execute(
      'SELECT id FROM students WHERE lrn = ?', [lrn],
    ) as any[];

    let studentId: number;

    if ((existing as any[]).length > 0) {
      studentId = (existing as any[])[0].id;
      await conn.execute(
        `UPDATE students
         SET name = ?, gender = ?, birthdate = ?, age = ?,
             contact = ?, address = ?, barangay = ?, municipality = ?, province = ?,
             birth_place = ?, religion = ?,
             grade_level = ?, section = ?, strand = ?, track = ?,
             school_year = ?, teacher_id = ?,
             enrollment_status = 'pending'
         WHERE id = ?`,
        [
          name, gender,
          birthdate    || null, age          || null,
          contact      || null, address      || null,
          barangay     || null, municipality || null, province || null,
          birth_place  || null, religion     || null,
          grade_level,
          section      || null, strand       || null, track    || null,
          school_year, req.teacher!.id,
          studentId,
        ],
      );
    } else {
      const [insertRes] = await conn.execute(
        `INSERT INTO students
           (lrn, name, gender, birthdate, age, contact,
            address, barangay, municipality, province,
            birth_place, religion,
            grade_level, section, strand, track,
            school_year, teacher_id, enrollment_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
        [
          lrn, name, gender,
          birthdate    || null, age          || null,
          contact      || null, address      || null,
          barangay     || null, municipality || null, province || null,
          birth_place  || null, religion     || null,
          grade_level,
          section      || null, strand       || null, track    || null,
          school_year, req.teacher!.id,
        ],
      ) as any[];
      studentId = (insertRes as any).insertId;
    }

    // ── 2. Parents/guardians ──────────────────────────────────────────────────
    const pgList = buildGuardianList(b);
    if (pgList.length > 0) {
      await conn.execute('DELETE FROM parents_guardians WHERE student_id = ?', [studentId]);
      for (const pg of pgList) {
        await conn.execute(
          `INSERT INTO parents_guardians (student_id, role, name, contact_number, occupation, relationship)
           VALUES (?,?,?,?,?,?)`,
          [studentId, pg.role, pg.name, pg.contact || null, pg.occ || null, pg.rel || null],
        );
      }
    }

    // ── 3. Upsert enrollment ──────────────────────────────────────────────────
    const [dupCheck] = await conn.execute(
      'SELECT id FROM enrollments WHERE student_id = ? AND school_year = ?',
      [studentId, school_year],
    ) as any[];

    const enrollValues = [
      grade_level,
      section                       || null,
      strand                        || null,
      track                         || null,
      learner_type                  || 'new',
      last_school_attended          || null,
      last_school_id                || null,
      last_grade_completed          || null,
      last_sy_completed             || null,
      bool(transfer_credential) ? 1 : 0,
      bool(returning_learner)   ? 1 : 0,
      bool(indigenous_people)   ? 1 : 0,
      ip_group                      || null,
      bool(pwd)                 ? 1 : 0,
      pwd_type                      || null,
      bool(working_student)     ? 1 : 0,
      bool(solo_parent)         ? 1 : 0,
      bool(fourPs)              ? 1 : 0,
      fourPs_household_id           || null,
      remarks                       || null,
      req.teacher!.id,
    ];

    let enrollmentId: number;

    if ((dupCheck as any[]).length > 0) {
      enrollmentId = (dupCheck as any[])[0].id;
      await conn.execute(
        `UPDATE enrollments
         SET grade_level = ?, section = ?, strand = ?, track = ?,
             learner_type = ?,
             last_school_attended = ?, last_school_id = ?,
             last_grade_completed = ?, last_sy_completed = ?,
             transfer_credential = ?,
             returning_learner = ?, indigenous_people = ?, ip_group = ?,
             pwd = ?, pwd_type = ?, working_student = ?, solo_parent = ?,
             \`4Ps_beneficiary\` = ?, fourPs_household_id = ?,
             remarks = ?, encoded_by = ?,
             status = 'pending', approved_at = NULL
         WHERE id = ?`,
        [...enrollValues, enrollmentId],
      );
    } else {
      const [envRes] = await conn.execute(
        `INSERT INTO enrollments
           (student_id, lrn, school_year,
            grade_level, section, strand, track, learner_type,
            last_school_attended, last_school_id,
            last_grade_completed, last_sy_completed,
            transfer_credential, returning_learner, indigenous_people, ip_group,
            pwd, pwd_type, working_student, solo_parent,
            \`4Ps_beneficiary\`, fourPs_household_id,
            remarks, encoded_by, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
        [studentId, lrn, school_year, ...enrollValues],
      ) as any[];
      enrollmentId = (envRes as any).insertId;
    }

    await conn.commit();
    res.status(201).json({ id: enrollmentId, student_id: studentId, message: 'Enrollment submitted successfully.' });
  } catch (err: any) {
    await conn.rollback();
    console.error('createEnrollment error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'A student with this LRN already exists.' });
      return;
    }
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
}

// ─── PATCH /api/enrollments/:id ───────────────────────────────────────────────
export async function updateEnrollment(req: AuthRequest, res: Response): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { id } = req.params;
    const b = parseBody(req.body);
    const {
      name, gender, birthdate, contact,
      address, barangay, municipality, province, birth_place, religion,
      grade_level, section, strand, track, school_year,
      learner_type, status, remarks,
      last_school_attended, last_school_id, last_grade_completed, last_sy_completed,
      transfer_credential, returning_learner, indigenous_people, ip_group,
      pwd, pwd_type, working_student, solo_parent, fourPs, fourPs_household_id,
    } = b;

    // Update enrollment row
    await conn.execute(
      `UPDATE enrollments
       SET grade_level = ?, section = ?, strand = ?, track = ?,
           learner_type = ?, school_year = ?, status = ?, remarks = ?,
           last_school_attended = ?, last_school_id = ?,
           last_grade_completed = ?, last_sy_completed = ?,
           transfer_credential = ?,
           returning_learner = ?, indigenous_people = ?, ip_group = ?,
           pwd = ?, pwd_type = ?, working_student = ?, solo_parent = ?,
           \`4Ps_beneficiary\` = ?, fourPs_household_id = ?
       WHERE id = ?`,
      [
        grade_level     || null, section   || null,
        strand          || null, track     || null,
        learner_type    || 'new',
        school_year     || null,
        status          || 'pending',
        remarks         || null,
        last_school_attended   || null, last_school_id        || null,
        last_grade_completed   || null, last_sy_completed     || null,
        bool(transfer_credential) ? 1 : 0,
        bool(returning_learner)   ? 1 : 0,
        bool(indigenous_people)   ? 1 : 0,
        ip_group        || null,
        bool(pwd)       ? 1 : 0, pwd_type || null,
        bool(working_student)  ? 1 : 0,
        bool(solo_parent)      ? 1 : 0,
        bool(fourPs)           ? 1 : 0,
        fourPs_household_id    || null,
        id,
      ],
    );

    // Update student row (only columns that exist in the actual schema)
    await conn.execute(
      `UPDATE students s
       JOIN enrollments e ON e.student_id = s.id
       SET s.name = ?, s.gender = ?, s.birthdate = ?, s.contact = ?,
           s.address = ?, s.barangay = ?, s.municipality = ?, s.province = ?,
           s.birth_place = ?, s.religion = ?,
           s.grade_level = ?, s.section = ?,
           s.strand = ?, s.school_year = ?
       WHERE e.id = ?`,
      [
        b.name          || null,
        gender          || null, birthdate  || null, contact    || null,
        address         || null, barangay   || null, municipality || null, province || null,
        birth_place     || null, religion   || null,
        grade_level     || null, section    || null,
        strand          || null, school_year || null,
        id,
      ],
    );

    // Update guardians
    const pgList = buildGuardianList(b);
    if (pgList.length > 0) {
      const [envRow] = await conn.execute(
        'SELECT student_id FROM enrollments WHERE id = ?', [id],
      ) as any[];
      const studentId = (envRow as any[])[0]?.student_id;
      if (studentId) {
        await conn.execute('DELETE FROM parents_guardians WHERE student_id = ?', [studentId]);
        for (const pg of pgList) {
          await conn.execute(
            `INSERT INTO parents_guardians (student_id, role, name, contact_number, occupation, relationship)
             VALUES (?,?,?,?,?,?)`,
            [studentId, pg.role, pg.name, pg.contact || null, pg.occ || null, pg.rel || null],
          );
        }
      }
    }

    await conn.commit();
    res.json({ message: 'Enrollment updated successfully.' });
  } catch (err: any) {
    await conn.rollback();
    console.error('updateEnrollment error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
}

// ─── PATCH /api/enrollments/:id/status ───────────────────────────────────────
export async function updateEnrollmentStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { status, remarks } = req.body;

    const allowed = ['pending', 'document_submitted', 'assessed', 'enrolled', 'rejected'];
    if (!allowed.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
      return;
    }

    const approved_at = status === 'enrolled' ? new Date() : null;

    await pool.execute(
      `UPDATE enrollments
       SET status = ?, approved_by = ?, approved_at = ?
       ${remarks !== undefined ? ', remarks = ?' : ''}
       WHERE id = ?`,
      remarks !== undefined
        ? [status, req.teacher!.id, approved_at, remarks, id]
        : [status, req.teacher!.id, approved_at, id],
    );

    const enrollStatus =
      status === 'enrolled' ? 'enrolled' :
      status === 'rejected' ? 'rejected' : 'pending';

    await pool.execute(
      `UPDATE students SET enrollment_status = ?
       WHERE id = (SELECT student_id FROM enrollments WHERE id = ?)`,
      [enrollStatus, id],
    );

    res.json({ message: `Enrollment ${status}.`, status });
  } catch (err: any) {
    console.error('updateEnrollmentStatus error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── DELETE /api/enrollments/:id ─────────────────────────────────────────────
export async function deleteEnrollment(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const [result] = await pool.execute('DELETE FROM enrollments WHERE id = ?', [id]) as any[];
    if ((result as any).affectedRows === 0) {
      res.status(404).json({ error: 'Enrollment not found' }); return;
    }
    res.json({ message: 'Enrollment deleted.' });
  } catch (err: any) {
    console.error('deleteEnrollment error:', err);
    res.status(500).json({ error: err.message });
  }
}