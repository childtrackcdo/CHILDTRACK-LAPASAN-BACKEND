import { Request, Response } from 'express';
import pool from '../../lib/db';

// ─────────────────────────────────────────────────────────────────────────────
// Notification helper — shared by createAttendance, kioskConfirm, kioskConfirmBulk
// ─────────────────────────────────────────────────────────────────────────────
async function insertNotification(params: {
  teacher_id: number;
  status:     string;
  student_name: string | null;
  section:    string | null;
  subject:    string | null;
  date:       string | null;
  guardian_name: string | null;
}): Promise<void> {
  const { teacher_id, status, student_name, section, subject, date, guardian_name } = params;
  const normalizedStatus = String(status ?? '').trim().toLowerCase();
  const NOTIFY_STATUSES  = ['late', 'absent', 'pick-up', 'pickup', 'drop-off', 'dropoff'];

  console.log(
    '[notifications][attendance] attempt → teacher_id:', teacher_id,
    '| raw status:', JSON.stringify(status),
    '| normalized:', normalizedStatus,
    '| eligible:', NOTIFY_STATUSES.includes(normalizedStatus),
  );

  if (!teacher_id) {
    console.warn('[notifications][attendance] SKIPPED — no teacher_id resolved');
    return;
  }
  if (!NOTIFY_STATUSES.includes(normalizedStatus)) {
    console.log('[notifications][attendance] SKIPPED — status not in notify list (this is expected for "Present")');
    return;
  }

  const notifType =
    normalizedStatus === 'absent'                              ? 'absent'  :
    normalizedStatus === 'late'                                ? 'late'    :
    ['pick-up', 'pickup'].includes(normalizedStatus)           ? 'pickup'  :
    'dropoff';

  const statusLabel =
    normalizedStatus === 'absent'                              ? 'Absent'   :
    normalizedStatus === 'late'                                ? 'Late'     :
    ['pick-up', 'pickup'].includes(normalizedStatus)           ? 'Pick-Up'  :
    'Drop-Off';

  const body =
    `${student_name ?? 'A student'} marked as ${statusLabel}` +
    (section      ? ` · ${section}`                 : '') +
    (subject      ? ` · ${subject}`                 : '') +
    (date         ? ` on ${date}`                   : '') +
    (guardian_name ? ` (Guardian: ${guardian_name})` : '');

  try {
    const [notifResult]: any = await pool.query(
      'INSERT INTO notifications (teacher_id, type, body, is_read) VALUES (?, ?, ?, 0)',
      [teacher_id, notifType, body],
    );
    console.log('[notifications][attendance] INSERT SUCCESS, insertId:', notifResult.insertId);
  } catch (e) {
    console.error('[notifications][attendance] INSERT FAILED:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION MATCHING — tolerant of a legacy data-corruption bug.
//
// Some kiosk-confirmed rows (written by an earlier version of
// kioskConfirm/kioskConfirmBulk) have `section` = NULL and the section
// name stuck in `subject` instead. That bug is already fixed at the write
// path, but the old rows are still in the table.
//
// Two problems, both handled here:
//  1. An exact `a.section = ?` match will never see these rows, since
//     matching a literal string against a SQL NULL always fails — so we
//     fall back to checking `a.subject` when `a.section IS NULL`.
//  2. The corrupted value in `subject` is NOT consistently formatted: some
//     rows have the full "Grade 11 - Mabini" string, others have just the
//     bare section name "Faraday" with no grade prefix. A plain string
//     equality check on the fallback would only catch whichever format
//     happens to match what the frontend passes in — the other format
//     would still silently disappear (this is exactly why "Grade 10
//     Faraday" showed nothing even after the section IS NULL fallback was
//     added: the incoming param carries a "Grade 10 - " prefix that the
//     stored "Faraday" value doesn't have).
//
// So both sides are normalized before comparing — prefix before the first
// " - " stripped, then lowercased with dashes/underscores/spaces removed —
// mirroring the same normalization the frontend already applies via
// normSectionKey() for the pending-scans view — extended further below.
// This makes the match tolerant of prefix presence/absence, dash
// presence/absence, casing, and stray whitespace on either side, for both
// the primary `section` column and the corrupted `subject` fallback.
//
// The corruption format is NOT consistent across rows — real data has been
// seen in at least three shapes: "Grade 11 - Mabini" (space-dash-space),
// "Grade 10 Einstien" (no dash at all, just a space), and bare "Faraday"
// (no grade prefix at all). A literal ' - ' split only catches the first
// shape; the others need a proper "Grade <number>" prefix pattern that
// tolerates an optional dash.
// ─────────────────────────────────────────────────────────────────────────────
function normalizeSectionValue(s: string): string {
  if (!s) return '';
  const stripped = s.replace(/^grade\s*\d+\s*-?\s*/i, '');
  return stripped.trim().toLowerCase().replace(/[-_\s]+/g, '');
}

// SQL expression mirroring normalizeSectionValue() above, applied to a
// column, so it can be compared against an already-normalized JS value
// passed as a parameter. REGEXP_REPLACE requires MySQL 8+/MariaDB 10.0.5+
// (this project already targets MariaDB per lib/db.ts's migration notes).
function normalizedColumnSQL(expr: string): string {
  const lowered = `LOWER(${expr})`;
  const prefixStripped = `REGEXP_REPLACE(${lowered}, '^grade[[:space:]]*[0-9]+[[:space:]]*-?[[:space:]]*', '')`;
  return `REPLACE(REPLACE(REPLACE(${prefixStripped}, '-', ''), '_', ''), ' ', '')`;
}

function buildSectionCondition(alias: string, section: string, conditions: string[], params: any[]): void {
  const p = alias ? `${alias}.` : '';
  const sectionCol = `${p}section`;
  const subjectCol = `${p}subject`;
  const normalized = normalizeSectionValue(section);

  conditions.push(`(
    ${normalizedColumnSQL(sectionCol)} = ?
    OR (${sectionCol} IS NULL AND ${normalizedColumnSQL(subjectCol)} = ?)
  )`);
  params.push(normalized, normalized);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance
// Query params: date, section, student_id, grade_level, subject, session, schedule_id
// ─────────────────────────────────────────────────────────────────────────────
export async function getAttendance(req: any, res: Response): Promise<void> {
  try {
    const { date, section, student_id, grade_level, subject, session, schedule_id, advisory_only, all_subjects } = req.query;

    const conditions: string[] = [];
    const params: any[]        = [];

    if (date)        { conditions.push('a.date = ?');        params.push(date); }
    if (section)     { buildSectionCondition('a', section, conditions, params); }
    if (student_id)  { conditions.push('a.student_id = ?');  params.push(student_id); }
    if (grade_level) { conditions.push('a.grade_level = ?'); params.push(grade_level); }
    // advisory_only=true → section-only, include NULL-subject kiosk scans (no subject filter)
    // all_subjects=true  → section-only, exclude NULL-subject AND Advisory rows (subject teachers only)
    // otherwise          → apply subject filter normally
    if (advisory_only !== 'true' && all_subjects !== 'true' && subject) {
      conditions.push('a.subject = ?'); params.push(subject);
    }
    if (all_subjects === 'true') {
      conditions.push("a.subject IS NOT NULL AND a.subject != 'Advisory'");
    }
    if (session)     { conditions.push('a.session = ?');     params.push(session); }
    if (schedule_id) { conditions.push('a.schedule_id = ?'); params.push(schedule_id); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows]: any = await pool.query(
      `SELECT * FROM attendance a
       ${where}
       ORDER BY a.date DESC, a.student_name ASC`,
      params,
    );

    res.json(rows);
  } catch (err: any) {
    console.error('getAttendance error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to fetch attendance' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/attendance
// Body: { student_id, student_name, lrn, gender, guardian_name, by_whom,
//         status, session, date, subject, section, grade_level,
//         schedule_id?, qr_data?, teacher_id? }
// ─────────────────────────────────────────────────────────────────────────────
export async function createAttendance(req: any, res: Response): Promise<void> {
  try {
    const {
      student_id, student_name, lrn, gender, guardian_name,
      by_whom, status, session, date, subject, section,
      grade_level, schedule_id, qr_data,
    } = req.body;

    if (!student_id || !date || !status) {
      res.status(400).json({ error: 'student_id, date, and status are required' });
      return;
    }

    // ── Resolve teacher_id ────────────────────────────────────────────────
    let teacher_id: number | null = req.teacher?.id ?? null;
    console.log('[attendance] req.teacher:', req.teacher, '| resolved teacher_id from JWT:', teacher_id);

    if (!teacher_id && section) {
      const [advisory]: any = await pool.query(
        `SELECT id FROM teachers
         WHERE LOWER(advisory_section) = LOWER(?) OR LOWER(section) = LOWER(?)
         LIMIT 1`,
        [section, section],
      );
      console.log('[attendance] advisory lookup for section:', JSON.stringify(section), '→ rows:', advisory);
      if (advisory.length > 0) teacher_id = advisory[0].id;
    }
    console.log('[attendance] FINAL teacher_id:', teacher_id, '| status:', JSON.stringify(status));
    // ─────────────────────────────────────────────────────────────────────

    const [existing]: any = await pool.query(
      'SELECT id FROM attendance WHERE student_id = ? AND date = ? AND subject = ? AND session = ?',
      [student_id, date, subject ?? null, session ?? null],
    );
    if (existing.length > 0) {
      res.status(409).json({ error: 'Attendance record already exists for this student on this date/subject/session' });
      return;
    }

    const [result]: any = await pool.query(
      `INSERT INTO attendance
         (teacher_id, student_id, student_name, lrn, gender, guardian_name,
          by_whom, status, session, date, subject, section, grade_level,
          schedule_id, qr_data, verified_in_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        teacher_id,
        student_id,
        student_name  ?? null,
        lrn           ?? null,
        gender        ?? null,
        guardian_name ?? null,
        by_whom       ?? 'teacher',
        status,
        session       ?? 'FULL',
        date,
        subject       ?? null,
        section       ?? null,
        grade_level   ?? null,
        schedule_id   ?? null,
        qr_data       ?? null,
      ],
    );

    const [created]: any = await pool.query(
      'SELECT * FROM attendance WHERE id = ?',
      [result.insertId],
    );

    // ── Insert notification ───────────────────────────────────────────────
    if (teacher_id) {
      await insertNotification({
        teacher_id,
        status,
        student_name: student_name ?? null,
        section:      section      ?? null,
        subject:      subject      ?? null,
        date:         date         ?? null,
        guardian_name: guardian_name ?? null,
      });
    }
    // ─────────────────────────────────────────────────────────────────────

    res.status(201).json(created[0]);
  } catch (err: any) {
    console.error('createAttendance error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to create attendance' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/attendance/:id
// Body: { status?, session?, remarks?, verified_in_class?, by_whom? }
// ─────────────────────────────────────────────────────────────────────────────
export async function updateAttendance(req: any, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { status, session, verified_in_class, by_whom } = req.body;

    const fields: string[] = [];
    const params: any[]    = [];

    if (status             !== undefined) { fields.push('status = ?');             params.push(status); }
    if (session            !== undefined) { fields.push('session = ?');            params.push(session); }
    if (by_whom            !== undefined) { fields.push('by_whom = ?');            params.push(by_whom); }
    if (verified_in_class  !== undefined) { fields.push('verified_in_class = ?');  params.push(verified_in_class ? 1 : 0); }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    params.push(id);
    const [result]: any = await pool.query(
      `UPDATE attendance SET ${fields.join(', ')} WHERE id = ?`,
      params,
    );

    if (result.affectedRows === 0) {
      res.status(404).json({ error: 'Attendance record not found' });
      return;
    }

    const [updated]: any = await pool.query(
      'SELECT * FROM attendance WHERE id = ?',
      [id],
    );

    res.json(updated[0]);
  } catch (err: any) {
    console.error('updateAttendance error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to update attendance' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/attendance/:id
// ─────────────────────────────────────────────────────────────────────────────
export async function deleteAttendance(req: any, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const [result]: any = await pool.query(
      'DELETE FROM attendance WHERE id = ?',
      [id],
    );

    if (result.affectedRows === 0) {
      res.status(404).json({ error: 'Attendance record not found' });
      return;
    }

    res.json({ ok: true, deleted: Number(id) });
  } catch (err: any) {
    console.error('deleteAttendance error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to delete attendance' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance/stats  →  getAttendanceSummary
// Query params: date, section, grade_level, subject, session, date_from, date_to
// ─────────────────────────────────────────────────────────────────────────────
export async function getAttendanceSummary(req: any, res: Response): Promise<void> {
  try {
    const { date, section, grade_level, subject, session, date_from, date_to } = req.query;

    const conditions: string[] = [];
    const params: any[]        = [];

    if (date)        { conditions.push('date = ?');        params.push(date); }
    if (section)     { buildSectionCondition('', section, conditions, params); }
    if (grade_level) { conditions.push('grade_level = ?'); params.push(grade_level); }
    if (subject)     { conditions.push('subject = ?');     params.push(subject); }
    if (session)     { conditions.push('session = ?');     params.push(session); }
    if (date_from)   { conditions.push('date >= ?');       params.push(date_from); }
    if (date_to)     { conditions.push('date <= ?');       params.push(date_to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [totals]: any = await pool.query(
      `SELECT
         COUNT(*)                              AS total,
         SUM(status = 'Present')              AS present,
         SUM(status = 'Absent')               AS absent,
         SUM(status = 'Late')                 AS late,
         SUM(status = 'Excused')              AS excused,
         SUM(verified_in_class = 1)           AS verified
       FROM attendance
       ${where}`,
      params,
    );

    const [byStudent]: any = await pool.query(
      `SELECT
         student_id,
         student_name,
         lrn,
         gender,
         section,
         grade_level,
         COUNT(*)                    AS total_days,
         SUM(status = 'Present')    AS present,
         SUM(status = 'Absent')     AS absent,
         SUM(status = 'Late')       AS late,
         SUM(status = 'Excused')    AS excused
       FROM attendance
       ${where}
       GROUP BY student_id
       ORDER BY student_name ASC`,
      params,
    );

    res.json({
      summary:    totals[0],
      by_student: byStudent,
    });
  } catch (err: any) {
    console.error('getAttendanceSummary error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to fetch summary' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance/for-parent
// parentAuthMiddleware sets req.parent = TokenPayload (expects student_name and/or lrn)
// ─────────────────────────────────────────────────────────────────────────────
export async function getAttendanceForParent(req: any, res: Response): Promise<void> {
  try {
    const parent      = req.parent;
    const studentName = parent?.student_name;
    const lrn         = parent?.lrn;

    if (!studentName && !lrn) {
      res.status(403).json({ error: 'No linked student for this parent account' });
      return;
    }

    const { date_from, date_to, subject, session } = req.query;

    const conditions: string[] = [];
    const params: any[]        = [];

    if (lrn) {
      conditions.push('lrn = ?');
      params.push(lrn);
    } else {
      conditions.push('student_name = ?');
      params.push(studentName);
    }

    if (date_from) { conditions.push('date >= ?');   params.push(date_from); }
    if (date_to)   { conditions.push('date <= ?');   params.push(date_to); }
    if (subject)   { conditions.push('subject = ?'); params.push(subject); }
    if (session)   { conditions.push('session = ?'); params.push(session); }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [rows]: any = await pool.query(
      `SELECT * FROM attendance ${where} ORDER BY date DESC`,
      params,
    );

    const total   = rows.length;
    const present = rows.filter((r: any) => r.status === 'Present').length;
    const absent  = rows.filter((r: any) => r.status === 'Absent').length;
    const late    = rows.filter((r: any) => r.status === 'Late').length;
    const excused = rows.filter((r: any) => r.status === 'Excused').length;

    res.json({
      summary: { total, present, absent, late, excused },
      records: rows,
    });
  } catch (err: any) {
    console.error('getAttendanceForParent error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to fetch attendance for parent' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/attendance/:id/verify
// ─────────────────────────────────────────────────────────────────────────────
export async function verifyInClass(req: any, res: Response): Promise<void> {
  try {
    const { id }  = req.params;
    const teacher = req.teacher;

    const [result]: any = await pool.query(
      `UPDATE attendance
       SET verified_in_class = 1,
           verified_at       = NOW(),
           verified_by       = ?
       WHERE id = ?`,
      [teacher?.id ?? null, id],
    );

    if (result.affectedRows === 0) {
      res.status(404).json({ error: 'Attendance record not found' });
      return;
    }

    const [updated]: any = await pool.query(
      'SELECT * FROM attendance WHERE id = ?',
      [id],
    );

    res.json(updated[0]);
  } catch (err: any) {
    console.error('verifyInClass error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to verify attendance' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/attendance/verify-bulk
//
// FIX: the frontend's "Verify All Present" button (AttendancePage.tsx)
// sends { date, section, subject? } — never { ids }. The previous version
// of this handler only accepted an `ids` array and rejected every real
// call with 400, silently breaking "Verify All Present". This version
// accepts the shape the frontend actually sends and bulk-verifies every
// Present/Late row matching date + section (+ subject, if given).
// Section matching uses the same NULL-tolerant fallback as getAttendance,
// since verify-bulk hits the same legacy-corrupted rows.
// ─────────────────────────────────────────────────────────────────────────────
export async function verifyBulk(req: any, res: Response): Promise<void> {
  try {
    const { date, section, subject, verified = true } = req.body;

    if (!date || !section) {
      res.status(400).json({ error: 'date and section are required' });
      return;
    }

    const teacher = req.teacher;

    const conditions: string[] = ["date = ?", "status IN ('Present','Late')"];
    const params: any[]        = [date];

    buildSectionCondition('', section, conditions, params);

    if (subject) {
      conditions.push('subject = ?');
      params.push(subject);
    }

    const [result]: any = await pool.query(
      `UPDATE attendance
       SET verified_in_class = ?,
           verified_at       = ${verified ? 'NOW()' : 'NULL'},
           verified_by       = ?
       WHERE ${conditions.join(' AND ')}`,
      [verified ? 1 : 0, teacher?.id ?? null, ...params],
    );

    res.json({ ok: true, affected: result.affectedRows });
  } catch (err: any) {
    console.error('verifyBulk error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to bulk verify attendance' });
  }
}