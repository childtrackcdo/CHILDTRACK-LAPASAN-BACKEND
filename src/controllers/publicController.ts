import { Request, Response } from 'express';
import { dbQuery, dbTransaction } from '../../lib/db';

// ─────────────────────────────────────────────────────────────────────────────
// Gender normalization
// students.gender is ENUM('M','F','O'). The public registration form sends
// the full word ("Male" / "Female" / "Prefer not to say"), which doesn't
// match any enum member as-is and causes MySQL to throw "Data truncated
// for column 'gender'" on insert. Normalize to the single-character code
// before the INSERT.
// ─────────────────────────────────────────────────────────────────────────────
function normalizeGender(raw?: string): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'male' || v === 'm') return 'M';
  if (v === 'female' || v === 'f') return 'F';
  if (v === 'prefer not to say' || v === 'o' || v === 'other') return 'O';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grade level normalization
// students.grade_level is an INT column. The public registration form sends
// the full label ("Grade 7" .. "Grade 12"), which MySQL can't cast to an
// integer and throws "Incorrect integer value for column 'grade_level'" on
// insert. Extract the numeric part before the INSERT.
// ─────────────────────────────────────────────────────────────────────────────
function normalizeGradeLevel(raw?: string): number | null {
  if (!raw) return null;
  const match = raw.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/public/teacher/:teacherId
// No auth — called by PublicStudentRegister on page load to show teacher info
// ─────────────────────────────────────────────────────────────────────────────
export async function getPublicTeacher(req: Request, res: Response): Promise<void> {
  try {
    const { teacherId } = req.params;

    const rows = await dbQuery<{
      id: number; name: string; section?: string;
      grade_level?: string; strand?: string; track?: string;
      photo_base64?: string; advisory_subject?: string;
    }>(
      `SELECT id, name, section, grade_level, strand, track, photo_base64, advisory_subject
       FROM teachers
       WHERE id = ?
       LIMIT 1`,
      [teacherId],
    );

    if (!rows.length) {
      res.status(404).json({ error: 'Teacher not found.' });
      return;
    }

    res.json(rows[0]);
  } catch (err: any) {
    console.error('getPublicTeacher error:', err.sqlMessage ?? err.message);
    res.status(500).json({ error: err.sqlMessage ?? err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/public/register/:teacherId
// No auth — inserts a pending student + guardian rows atomically
// Frontend: PublicStudentRegister.tsx → handleSubmit()
// ─────────────────────────────────────────────────────────────────────────────
export async function publicRegisterStudent(req: Request, res: Response): Promise<void> {
  try {
    const { teacherId } = req.params;

    const {
      lrn, name, gender, birthdate, age, birth_place, mother_tongue, ip_ethnic,
      religion, contact, address, barangay, municipality, province,
      section, grade_level, strand, track, school_year,
      guardians,
    } = req.body;

    // ── Required field check ────────────────────────────────────────────────
    if (!lrn?.trim())         { res.status(400).json({ error: 'LRN is required.' });          return; }
    if (!name?.trim())        { res.status(400).json({ error: 'Full name is required.' });    return; }
    if (!gender?.trim())      { res.status(400).json({ error: 'Gender is required.' });       return; }
    if (!section?.trim())     { res.status(400).json({ error: 'Section is required.' });      return; }
    if (!grade_level?.trim()) { res.status(400).json({ error: 'Grade level is required.' });  return; }

    // ── Teacher must exist ──────────────────────────────────────────────────
    const teachers = await dbQuery<{ id: number }>(
      'SELECT id FROM teachers WHERE id = ? LIMIT 1',
      [teacherId],
    );
    if (!teachers.length) {
      res.status(404).json({ error: 'Registration link is invalid or has been removed.' });
      return;
    }

    // ── Duplicate LRN check ─────────────────────────────────────────────────
    const existing = await dbQuery<{ id: number }>(
      'SELECT id FROM students WHERE lrn = ? LIMIT 1',
      [lrn.trim()],
    );
    if (existing.length) {
      res.status(409).json({ error: 'A student with this LRN has already been registered.' });
      return;
    }

    // ── Guardian validation ─────────────────────────────────────────────────
    const guardianList: {
      role?: string; name: string; contact_number?: string;
      occupation?: string; highest_educ?: string; relationship?: string;
    }[] = Array.isArray(guardians) ? guardians : [];

    const firstGuardian = guardianList[0];
    if (!firstGuardian?.name?.trim()) {
      res.status(400).json({ error: 'Guardian name is required.' });
      return;
    }
    if (!firstGuardian?.contact_number?.trim()) {
      res.status(400).json({ error: 'Guardian contact number is required.' });
      return;
    }

    // ── Normalize gender to match students.gender ENUM('M','F','O') ────────
    const normalizedGender = normalizeGender(gender);
    if (!normalizedGender) {
      res.status(400).json({ error: 'Gender must be Male, Female, or Prefer not to say.' });
      return;
    }

    // ── Normalize grade level to match students.grade_level INT column ─────
    const normalizedGradeLevel = normalizeGradeLevel(grade_level);
    if (!normalizedGradeLevel) {
      res.status(400).json({ error: 'Invalid grade level.' });
      return;
    }

    // ── Atomic insert: student + guardians ─────────────────────────────────
    await dbTransaction(async (conn) => {
      const [studentResult]: any = await conn.execute(
        `INSERT INTO students (
           lrn, name, gender, birthdate, age, birth_place, mother_tongue, ip_ethnic,
           religion, contact, address, barangay, municipality, province,
           section, grade_level, strand, track, school_year,
           teacher_id, enrollment_status
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
        [
          lrn.trim(),
          name.trim(),
          normalizedGender,
          birthdate     || null,
          age           || null,
          birth_place   || null,
          mother_tongue || null,
          ip_ethnic     || null,
          religion      || null,
          contact       || null,
          address       || null,
          barangay      || null,
          municipality  || null,
          province      || null,
          section.trim(),
          normalizedGradeLevel,
          strand        || null,
          track         || null,
          school_year   || null,
          teacherId,
        ],
      );

      const studentId: number = studentResult.insertId;

      for (const g of guardianList) {
        if (!g.name?.trim()) continue; // skip blank guardian rows
        await conn.execute(
          `INSERT INTO parents_guardians
             (student_id, role, name, contact_number, occupation, highest_educ, relationship)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            studentId,
            g.role             || 'Parent 1',
            g.name.trim(),
            g.contact_number?.trim()  || null,
            g.occupation?.trim()      || null,
            g.highest_educ?.trim()    || null,
            g.relationship             || 'Parent',
          ],
        );
      }
    });

    res.status(201).json({ success: true, message: 'Registration submitted. Pending admin approval.' });
  } catch (err: any) {
    console.error('publicRegisterStudent error:', err.sqlMessage ?? err.message);
    res.status(500).json({ error: err.sqlMessage ?? err.message });
  }
}