import { Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import pool from '../../lib/db';
import { AuthRequest } from '../../middleware/authMiddleware';

const TEMPLATE_PATH = path.join(__dirname, '../templates/Class Record SHS - All Subjects.xlsx');
const FILL_SCRIPT   = path.join(__dirname, '../scripts/fill_class_record.py');

const QUARTER_MAP: Record<string, { semester: string; sheet: 'CLASS RECORD Q1' | 'CLASS RECORD Q2' }> = {
  Q1: { semester: 'FIRST SEMESTER',  sheet: 'CLASS RECORD Q1' },
  Q2: { semester: 'FIRST SEMESTER',  sheet: 'CLASS RECORD Q2' },
  Q3: { semester: 'SECOND SEMESTER', sheet: 'CLASS RECORD Q1' },
  Q4: { semester: 'SECOND SEMESTER', sheet: 'CLASS RECORD Q2' },
};

const SUBJECT_TYPE_MAP: Record<string, string> = {
  'Core/Academic':   'CORE SUBJECT',
  'TVL/Sports/Arts': 'SPECIALIZED/APPLIED- TVL/ARTS & DESIGN',
  'Work Immersion':  'WORK IMMERSION - TVL',
};

interface StudentRow {
  id: number;
  lrn: string | null;
  name: string | null;
  gender: string | null;
}

function formatLearnerName(s: StudentRow): string {
  return (s.name || '').trim().toUpperCase() || '—';
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

// ── Concurrency guard (per-section) ──────────────────────────────────────────
const activeGenerations = new Set<string>();

/**
 * Runs the Python fill script which uses openpyxl to write data into the
 * DepEd template while preserving ALL styles, logos, borders, and formatting.
 *
 * Why Python/openpyxl instead of SheetJS?
 * ────────────────────────────────────────
 * SheetJS requires cellStyles:false to avoid OOM crashes on this template.
 * That flag strips all formatting from the output — the DepEd logo, colored
 * headers, cell borders, and tab colors are all lost.
 *
 * openpyxl reads and writes the xlsx zip structure while keeping every style
 * intact. The Python script is fast (~1-2s) and uses minimal memory since
 * openpyxl only loads what it needs.
 */
function runFillScript(payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(payload);
    execFile(
      'python3',
      [FILL_SCRIPT, json],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        if (stdout.trim() !== 'OK') {
          reject(new Error(`Fill script returned unexpected output: ${stdout}`));
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * GET /api/class-record/generate
 * Streams back a fully-formatted DepEd SHS Class Record (.xlsx) for a given
 * subject + section + quarter, pre-populated with enrolled learner names.
 * The output file is visually identical to the original DepEd template —
 * logos, borders, colors, and merged cells are all preserved.
 */
export async function generateClassRecord(req: AuthRequest, res: Response): Promise<void> {
  const { subject, section, quarter, schoolYear, weightType, gradeLevel } =
    req.query as Record<string, string>;

  // ── Validate query params ──────────────────────────────────────────────────
  if (!subject || !section || !quarter || !schoolYear) {
    res.status(400).json({
      error: 'subject, section, quarter, and schoolYear are required.',
    });
    return;
  }

  const qMap = QUARTER_MAP[quarter];
  if (!qMap) {
    res.status(400).json({ error: 'quarter must be one of Q1, Q2, Q3, Q4.' });
    return;
  }

  if (!fs.existsSync(TEMPLATE_PATH)) {
    res.status(500).json({ error: `Template file not found: ${TEMPLATE_PATH}` });
    return;
  }

  if (!fs.existsSync(FILL_SCRIPT)) {
    res.status(500).json({ error: `Fill script not found: ${FILL_SCRIPT}` });
    return;
  }

  // ── Per-section concurrency guard ─────────────────────────────────────────
  const lockKey = `${section.trim()}__${quarter}__${schoolYear}`;
  if (activeGenerations.has(lockKey)) {
    res.status(503).json({
      error: 'This class record is already being generated. Please wait a moment and try again.',
    });
    return;
  }
  activeGenerations.add(lockKey);

  // Temp file for Python script output — cleaned up in finally block
  const tmpOutput = path.join(
    os.tmpdir(),
    `classrecord_${Date.now()}_${Math.random().toString(36).slice(2)}.xlsx`,
  );

  try {
    console.log('[ClassRecord] ① request received', req.query);

    // ── Fetch teacher name directly from DB using the token's id ──────────
    // This is more reliable than reading from the JWT payload, which may have
    // been signed before the name field was added, or with an outdated value.
    const teacherPayload = req.teacher as any;
    const [teacherRows] = await pool.query(
      'SELECT name FROM teachers WHERE id = ?',
      [teacherPayload?.id],
    ) as any[];
    const teacherName: string =
      (teacherRows as any[])[0]?.name ||  // full name from DB
      teacherPayload?.username         ||  // fallback to username if name is empty
      '';

    // ── 1. Fetch enrolled students ─────────────────────────────────────────
    console.log('[ClassRecord] ② querying DB for section:', section);
    const [rows] = await pool.query(
      `SELECT id, lrn, name, gender
       FROM students
       WHERE TRIM(section) = TRIM(?) AND enrollment_status = 'enrolled'
       ORDER BY name ASC`,
      [section],
    );
    console.log('[ClassRecord] ③ DB query done, rows:', (rows as any[]).length);

    const students = rows as StudentRow[];

    if (students.length === 0) {
      res.status(404).json({
        error: `No enrolled students found for section "${section}".`,
      });
      return;
    }

    const males   = students.filter(s => (s.gender || '').trim().toUpperCase().startsWith('M'));
    const females = students.filter(s => (s.gender || '').trim().toUpperCase().startsWith('F'));

    if (males.length > 50 || females.length > 50) {
      res.status(400).json({
        error: `Template supports up to 50 male and 50 female learners. Found ${males.length} male, ${females.length} female.`,
      });
      return;
    }

    // Fix: gradeLevel="Grade 11", section="Grade 11 - Mabini"
    // Without this guard we'd get "Grade 11 - Grade 11 - Mabini"
    const sectionLabel = section.includes(gradeLevel || '')
      ? section
      : `${gradeLevel || ''} - ${section}`.trim().replace(/^- /, '');

    // ── 2. Run Python fill script ──────────────────────────────────────────
    console.log('[ClassRecord] ④ running Python fill script');
    await runFillScript({
      templatePath: TEMPLATE_PATH,
      outputPath:   tmpOutput,
      schoolYear,
      semester:     qMap.semester,
      subject,
      subjectType:  SUBJECT_TYPE_MAP[weightType] || 'CORE SUBJECT',
      section:      sectionLabel,
      teacher:      teacherName,
      quarter,
      males:        males.map(formatLearnerName),
      females:      females.map(formatLearnerName),
    });
    console.log('[ClassRecord] ⑤ fill script done');

    // ── 3. Stream output file to client ───────────────────────────────────
    const outBuffer = fs.readFileSync(tmpOutput);

    const fileName = sanitizeFileName(
      `ClassRecord_${subject}_${sectionLabel}_${quarter}_${schoolYear}.xlsx`,
    );

    console.log('[ClassRecord] ⑥ streaming response');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.end(outBuffer);
    console.log('[ClassRecord] ⑦ response sent successfully');

  } catch (err: any) {
    console.error('[ClassRecord] ✖ error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message ?? 'Failed to generate class record.' });
    }
  } finally {
    activeGenerations.delete(lockKey);
    // Clean up temp file
    if (fs.existsSync(tmpOutput)) {
      fs.unlinkSync(tmpOutput);
    }
  }
}