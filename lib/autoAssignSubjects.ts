import pool from './db';

/**
 * Auto-assigns subjects to a student based on their grade level, strand, and track.
 *
 * For JHS (Grade 7–10): assigns all subjects where strand IS NULL.
 * For SHS (Grade 11–12): assigns BOTH the universal core subjects (strand = 'ALL SHS')
 *   AND the strand-specific specialized subjects.
 *
 * Uses INSERT IGNORE so calling this multiple times (e.g. on re-enrollment)
 * is safe — already-assigned subjects are left untouched.
 *
 * @returns number of subjects inserted
 */
export async function autoAssignSubjects(
  studentId:   number,
  teacherId:   number,
  gradeLevel:  string,
  strand:      string | null,
  track:       string | null,
  schoolYear:  string | null,
  semester?:   number | null,          // optional: 1 or 2; null = assign both
): Promise<number> {

  const isSHS = gradeLevel === 'Grade 11' || gradeLevel === 'Grade 12';

  let templates: any[] = [];

  if (isSHS) {
    // Pull universal SHS core subjects
    const [coreRows] = await pool.execute(
      `SELECT * FROM subject_templates
       WHERE grade_level = ?
         AND strand = 'ALL SHS'
         AND is_active = 1
         AND (? IS NULL OR semester = ?)`,
      [gradeLevel, semester ?? null, semester ?? null],
    ) as any[];

    // Pull strand-specific subjects (STEM, ABM, HUMSS, GAS, TVL strands, etc.)
    let strandRows: any[] = [];
    if (strand) {
      const [rows] = await pool.execute(
        `SELECT * FROM subject_templates
         WHERE grade_level = ?
           AND strand = ?
           AND is_active = 1
           AND (? IS NULL OR semester = ?)`,
        [gradeLevel, strand, semester ?? null, semester ?? null],
      ) as any[];
      strandRows = rows as any[];
    }

    templates = [...(coreRows as any[]), ...strandRows];
  } else {
    // JHS: strand is NULL for all subjects
    const [rows] = await pool.execute(
      `SELECT * FROM subject_templates
       WHERE grade_level = ?
         AND strand IS NULL
         AND is_active = 1`,
      [gradeLevel],
    ) as any[];
    templates = rows as any[];
  }

  if (!templates.length) return 0;

  // Build bulk insert
  const rows = templates.map((t: any) => [
    studentId,
    teacherId,
    t.subject_name,
    t.subject_code  ?? null,
    t.subject_type  ?? 'Core Subject',
    gradeLevel,
    strand          ?? null,
    schoolYear      ?? null,
    t.units         ?? null,
    t.semester      ?? null,
    1, // auto_assigned = true
  ]);

  const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',');
  const flat = rows.flat();

  const [result] = await pool.execute(
    `INSERT IGNORE INTO student_subjects
       (student_id, teacher_id, subject_name, subject_code, subject_type,
        grade_level, strand, school_year, units, semester, auto_assigned)
     VALUES ${placeholders}`,
    flat,
  ) as any[];

  return (result as any).affectedRows ?? 0;
}

/**
 * Re-syncs a student's subjects when they transfer grade level or strand.
 * Removes old auto-assigned subjects for the student, then re-inserts from templates.
 * Manually-added subjects (auto_assigned = 0) are preserved.
 */
export async function resyncStudentSubjects(
  studentId:  number,
  teacherId:  number,
  gradeLevel: string,
  strand:     string | null,
  track:      string | null,
  schoolYear: string | null,
): Promise<{ removed: number; assigned: number }> {

  // Remove only auto-assigned subjects for this student + school year
  const [del] = await pool.execute(
    `DELETE FROM student_subjects
     WHERE student_id = ? AND auto_assigned = 1
       AND (school_year = ? OR (school_year IS NULL AND ? IS NULL))`,
    [studentId, schoolYear ?? null, schoolYear ?? null],
  ) as any[];

  const removed = (del as any).affectedRows ?? 0;
  const assigned = await autoAssignSubjects(studentId, teacherId, gradeLevel, strand, track, schoolYear);

  return { removed, assigned };
}