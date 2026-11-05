/**
 * sf2Controller.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ChildTrack HS Edition — DepEd School Form 2 (SF2) Generator
 *
 * v18 — Boy/girl blocks now expand dynamically when the roster exceeds the
 *       template's built-in capacity (21 boy rows / 25 girl rows). Extra rows
 *       are cloned from the last row of each block (preserving the B:C name
 *       merge and AE:AJ remarks merge) and inserted directly above the
 *       MALE/FEMALE total rows, which — along with the guidelines and
 *       signature block further down — shift down automatically. Previously,
 *       any student past row 34 (boys) or row 60 (girls) was silently
 *       dropped with no warning.
 *
 * v17 — Roster now keyed by student ID instead of name (eliminates silent
 *       data loss when two students share the same full name). Names are
 *       reformatted to "Last Name, First Name, Middle Name" and both gender
 *       sections are sorted alphabetically by surname.
 */

import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import pool from '../../lib/db';
import { RowDataPacket } from 'mysql2';
import multer from 'multer';

console.log('[SF2] ✅ v18 — Dynamic row expansion for oversized rosters; roster keyed by student ID; surname-sorted "Last, First" formatting');

/* ─── Multer — disk storage (template upload) ─────────────────────────────── */
export const sf2Upload = multer({
  dest: path.join(__dirname, '..', '..', 'uploads', 'sf2_tmp'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls'].includes(ext)) cb(null, true);
    else cb(new Error('Only .xlsx / .xls files are allowed'));
  },
});

/* ─── Output directory ────────────────────────────────────────────────────── */
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'sf2');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ─── DepEd SF2 template layout constants ─────────────────────────────────── */
const DATE_ROW                  = 11;
const DAY_ROW                   = 12;
const BOYS_START_ROW            = 14;
const BOYS_END_ROW_TEMPLATE     = 34;  // last boy row shipped in the blank template (21 rows)
const GIRLS_START_ROW_TEMPLATE  = 36;  // last girl row shipped in the blank template (25 rows)
const GIRLS_END_ROW_TEMPLATE    = 60;
const NAME_COLUMN               = 2;
const FIRST_DAY_COLUMN          = 4;
const ROW_HEIGHT                = 22;

/* ─── Fill colours ────────────────────────────────────────────────────────── */
const GREEN = 'FF00B050';
const RED   = 'FFFF0000';

const FULL_GREEN_FILL: ExcelJS.Fill = {
  type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN },
};
const RED_FILL: ExcelJS.Fill = {
  type: 'pattern', pattern: 'solid', fgColor: { argb: RED },
};
const NO_FILL: ExcelJS.Fill = {
  type: 'pattern', pattern: 'none',
} as ExcelJS.Fill;

/* ─── Status helpers ──────────────────────────────────────────────────────── */
function isAttended(status: string): boolean {
  const s = (status || '').toLowerCase().replace(/[-_\s]/g, '');
  if (s === 'absent')     return false;
  if (s === 'droppedout') return false;
  return true;
}

/* ─── Name formatting: "First Middle Last" → "Last, First Middle" ────────── */
// The DB stores names as plain "First Last" or "First Middle Last"
// (e.g. "Brian Aquino", "Linda Delos Santos"), but SF2 expects
// "Last Name, First Name, Middle Name". This list catches the common
// multi-word Filipino surname prefixes so "Delos Santos", "Dela Cruz",
// "De Los Reyes", etc. aren't split incorrectly.
const MULTI_WORD_SURNAME_PREFIXES = [
  'delos', 'dela', 'de', 'del', 'san', 'santa', 'van', 'der', 'mac', 'mc',
];

function formatNameForSF2(fullName: string): string {
  const name = (fullName || '').trim();
  if (!name) return '';

  // Already "Last, First Middle" — just normalize spacing.
  if (name.includes(',')) {
    const [last, rest] = name.split(',').map(s => s.trim());
    return rest ? `${last}, ${rest}` : last;
  }

  const parts = name.split(/\s+/);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) {
    return `${parts[1]}, ${parts[0]}`;
  }

  // 3+ words: check if the second-to-last word is a known surname-prefix
  // ("Delos Santos", "Dela Cruz", "De Los Reyes", "San Miguel"...).
  const secondToLast = parts[parts.length - 2].toLowerCase();
  if (MULTI_WORD_SURNAME_PREFIXES.includes(secondToLast)) {
    const last  = `${parts[parts.length - 2]} ${parts[parts.length - 1]}`;
    const first = parts.slice(0, parts.length - 2).join(' ');
    return `${last}, ${first}`;
  }

  // Default: last word is the surname, everything else is First (Middle).
  const last  = parts[parts.length - 1];
  const first = parts.slice(0, parts.length - 1).join(' ');
  return `${last}, ${first}`;
}

function extractSurname(formattedName: string): string {
  const idx = formattedName.indexOf(',');
  return (idx !== -1 ? formattedName.slice(0, idx) : formattedName).trim().toLowerCase();
}

/* ─── Triangle Drawing helpers ────────────────────────────────────────────── */
interface CellPos { col: number; row: number; }

function buildDrawingXml(amCells: CellPos[], pmCells: CellPos[]): string {
  let shapeId = 100;
  const shapes: string[] = [];

  const makeShape = (pos: CellPos, isAM: boolean, id: number): string => {
    const flipAttr = isAM ? 'flipV="1"' : 'flipH="1"';
    return `  <xdr:twoCellAnchor editAs="absolute">
    <xdr:from>
      <xdr:col>${pos.col}</xdr:col><xdr:colOff>0</xdr:colOff>
      <xdr:row>${pos.row}</xdr:row><xdr:rowOff>0</xdr:rowOff>
    </xdr:from>
    <xdr:to>
      <xdr:col>${pos.col + 1}</xdr:col><xdr:colOff>0</xdr:colOff>
      <xdr:row>${pos.row + 1}</xdr:row><xdr:rowOff>0</xdr:rowOff>
    </xdr:to>
    <xdr:sp macro="" textlink="">
      <xdr:nvSpPr>
        <xdr:cNvPr id="${id}" name="${isAM ? 'AM' : 'PM'}_c${pos.col}_r${pos.row}"/>
        <xdr:cNvSpPr><a:spLocks noGrp="1"/></xdr:cNvSpPr>
      </xdr:nvSpPr>
      <xdr:spPr>
        <a:xfrm ${flipAttr}>
          <a:off x="0" y="0"/>
          <a:ext cx="100" cy="100"/>
        </a:xfrm>
        <a:prstGeom prst="rtTriangle"><a:avLst/></a:prstGeom>
        <a:solidFill><a:srgbClr val="00B050"/></a:solidFill>
        <a:ln><a:noFill/></a:ln>
      </xdr:spPr>
      <xdr:style>
        <a:lnRef idx="0"><a:schemeClr clr="accent1"/></a:lnRef>
        <a:fillRef idx="0"><a:schemeClr clr="accent1"/></a:fillRef>
        <a:effectRef idx="0"><a:schemeClr clr="accent1"/></a:effectRef>
        <a:fontRef idx="minor"><a:schemeClr clr="lt1"/></a:fontRef>
      </xdr:style>
      <xdr:txBody><a:bodyPr/><a:lstStyle/><a:p/></xdr:txBody>
    </xdr:sp>
    <xdr:clientData/>
  </xdr:twoCellAnchor>`;
  };

  for (const pos of amCells) shapes.push(makeShape(pos, true,  shapeId++));
  for (const pos of pmCells) shapes.push(makeShape(pos, false, shapeId++));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${shapes.join('\n')}
</xdr:wsDr>`;
}

/* ─── JSZip DrawingML patch ───────────────────────────────────────────────── */
async function patchDrawings(
  filePath: string,
  amCells: CellPos[],
  pmCells: CellPos[],
): Promise<void> {
  if (amCells.length === 0 && pmCells.length === 0) return;

  const buf     = fs.readFileSync(filePath);
  const zip     = await JSZip.loadAsync(buf);
  const allKeys = Object.keys(zip.files);

  const sheetKey = allKeys.find(k => /xl\/worksheets\/sheet\d+\.xml$/.test(k));
  if (!sheetKey) throw new Error('Could not find worksheet in xlsx');

  const sheetXml     = await zip.file(sheetKey)!.async('string');
  const sheetName    = path.basename(sheetKey);
  const relsKey      = `xl/worksheets/_rels/${sheetName}.rels`;
  const drawingRelId = 'rId_drawing1';

  let relsXml = zip.file(relsKey)
    ? await zip.file(relsKey)!.async('string')
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

  if (!relsXml.includes('drawing')) {
    relsXml = relsXml.replace(
      '</Relationships>',
      `  <Relationship Id="${drawingRelId}" ` +
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" ` +
      `Target="../drawings/drawing1.xml"/>\n</Relationships>`,
    );
  }

  let newSheetXml = sheetXml;
  if (!newSheetXml.includes('<drawing')) {
    newSheetXml = newSheetXml.replace(
      '</worksheet>',
      `<drawing r:id="${drawingRelId}"/></worksheet>`,
    );
    if (!newSheetXml.includes('xmlns:r=')) {
      newSheetXml = newSheetXml.replace(
        '<worksheet ',
        '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
      );
    }
  }

  const drawingXml = buildDrawingXml(amCells, pmCells);

  let ctXml = await zip.file('[Content_Types].xml')!.async('string');
  if (!ctXml.includes('drawing1.xml')) {
    ctXml = ctXml.replace(
      '</Types>',
      `<Override PartName="/xl/drawings/drawing1.xml" ` +
      `ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>\n</Types>`,
    );
  }

  zip.file(sheetKey,                   newSheetXml);
  zip.file(relsKey,                    relsXml);
  zip.file('xl/drawings/drawing1.xml', drawingXml);
  zip.file('[Content_Types].xml',      ctXml);

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(filePath, out);
}

/* ─── Cell reset (preserves outer border from template) ──────────────────── */
function hardReset(cell: ExcelJS.Cell) {
  const b = (cell.border || {}) as any;
  const outerBorder = {
    top: b.top, left: b.left, bottom: b.bottom, right: b.right,
  };
  cell.value = null;
  cell.style = {
    font:      { name: 'Arial Narrow', size: 11 },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border:    outerBorder as ExcelJS.Borders,
    numFmt:    'General',
    fill:      NO_FILL,
  };
  cell.border = outerBorder as ExcelJS.Borders;
}

/* ─── Utility ─────────────────────────────────────────────────────────────── */
const daysInMonth = (m: number, y: number) => new Date(y, m, 0).getDate();

/* ═══════════════════════════════════════════════════════════════════════════
   CORE DATA FETCH
   Roster keyed by student ID (falls back to a synthetic "name:<name>" key
   only for attendance rows that can't be resolved to any known student —
   e.g. a name typo at kiosk time with no matching LRN/name in `students`).
   ═══════════════════════════════════════════════════════════════════════════ */
interface StudentMetaEntry {
  studentId:    number | null;
  originalName: string;
  gender:       string;
  days:         Record<number, { am: boolean; pm: boolean }>;
}

async function buildStudentMeta(
  month: number,
  year: number,
  section?: string,
): Promise<Record<string, StudentMetaEntry>> {

  const meta: Record<string, StudentMetaEntry> = {};

  // ── Step 1: seed every enrolled student in this section by ID, regardless
  // of whether they have any attendance records at all this month. Without
  // this, a student with zero scans never appears in the report instead of
  // appearing with all-red cells. ─────────────────────────────────────────
  if (section?.trim()) {
    const [studentRows] = await (pool as any).execute(
      `SELECT id, name, gender
       FROM students
       WHERE section = ?
         AND enrollment_status = 'enrolled'`,
      [section.trim()],
    ) as [RowDataPacket[], any];

    for (const s of studentRows as any[]) {
      const name = (s.name || '').trim();
      if (!name) continue;
      const raw = (s.gender || '').trim().toUpperCase();
      const gender = raw.startsWith('M') ? 'M' : raw.startsWith('F') ? 'F' : '';
      meta[`id:${s.id}`] = { studentId: s.id, originalName: name, gender, days: {} };
    }
  }

  // ── Step 2: overlay attendance records on top of the seeded roster,
  // matched by a.student_id (the reliable key) with a name-based fallback
  // only for legacy rows that somehow lack a student_id. ──────────────────
  const conditions: string[] = [
    'MONTH(a.date) = ?',
    'YEAR(a.date)  = ?',
  ];
  const params: any[] = [month, year];

  if (section?.trim()) {
    conditions.push('a.section = ?');
    params.push(section.trim());
  }

  const [rows] = await (pool as any).execute(
    `SELECT
       a.student_id,
       a.student_name,
       a.lrn,
       COALESCE(
         (SELECT s.gender
          FROM students s
          WHERE s.id = a.student_id
            AND a.student_id IS NOT NULL
            AND s.gender IS NOT NULL
            AND s.gender != ''
          LIMIT 1),
         (SELECT s.gender
          FROM students s
          WHERE s.lrn = a.lrn
            AND a.lrn IS NOT NULL
            AND a.lrn != ''
            AND s.gender IS NOT NULL
            AND s.gender != ''
          LIMIT 1),
         (SELECT s.gender
          FROM students s
          WHERE s.name = a.student_name
            AND s.gender IS NOT NULL
            AND s.gender != ''
          LIMIT 1),
         NULLIF(a.gender, ''),
         ''
       ) AS gender,
       DATE_FORMAT(a.date, '%Y-%m-%d') AS date,
       COALESCE(a.session, 'AM')       AS session,
       a.status,
       CASE
         WHEN (a.subject IS NULL OR a.subject = '' OR a.subject = 'Advisory') THEN 0
         ELSE 1
       END AS is_subject
     FROM attendance a
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.student_name, a.date, a.session,
              is_subject ASC,
              a.id ASC`,
    params,
  ) as [RowDataPacket[], any];

  for (const r of rows as any[]) {
    const name    = (r.student_name || '').trim();
    const raw     = (r.gender || '').trim().toUpperCase();
    const gender  = raw.startsWith('M') ? 'M' : raw.startsWith('F') ? 'F' : '';
    const day     = Number((r.date  as string).split('-')[2]);
    const session = (r.session      || '').trim().toUpperCase();

    if (!name || isNaN(day) || day < 1 || day > 31) continue;

    // Prefer the real student_id key; only fall back to a name-based key
    // when student_id is genuinely absent on the attendance row.
    const key = r.student_id != null ? `id:${r.student_id}` : `name:${name.toLowerCase()}`;

    if (!meta[key]) {
      meta[key] = {
        studentId:    r.student_id ?? null,
        originalName: name,
        gender:       '',
        days:         {},
      };
    }

    if (!meta[key].gender && gender) meta[key].gender = gender;

    if (!meta[key].days[day]) meta[key].days[day] = { am: false, pm: false };

    const attended = isAttended(r.status);

    if      (session === 'AM')   meta[key].days[day].am = attended;
    else if (session === 'PM')   meta[key].days[day].pm = attended;
    else if (session === 'FULL') {
      meta[key].days[day].am = attended;
      meta[key].days[day].pm = attended;
    }
  }

  const boyCount  = Object.values(meta).filter(m => m.gender === 'M').length;
  const girlCount = Object.values(meta).filter(m => m.gender === 'F').length;
  const unkCount  = Object.values(meta).filter(m => !m.gender).length;
  console.log(`[SF2] Gender resolved — Boys: ${boyCount}, Girls: ${girlCount}, Unknown: ${unkCount}`);
  if (unkCount > 0) {
    Object.values(meta)
      .filter(m => !m.gender)
      .forEach(m => console.log(`  [SF2] No gender found: "${m.originalName}"`));
  }

  return meta;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONTROLLER: POST /api/sf2/generate
   ═══════════════════════════════════════════════════════════════════════════ */
export async function generateSF2(req: Request, res: Response) {

  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Upload template file' });

  const month     = Number(req.body.month);
  const year      = Number(req.body.year);
  const section   = (req.body.section || '').trim() || (req as any).teacher?.section?.trim() || '';
  const totalDays = daysInMonth(month, year);

  if (isNaN(month) || month < 1 || month > 12)
    return res.status(400).json({ error: 'Invalid month' });
  if (isNaN(year) || year < 2000 || year > 2100)
    return res.status(400).json({ error: 'Invalid year' });

  const studentMeta = await buildStudentMeta(month, year, section);

  /* ── gender split — formatted "Last, First Middle", sorted by surname ── */
  // Row objects carry both the display name and the meta key, so fillSection
  // can look attendance data back up without any name-collision risk.
  interface Row { key: string; displayName: string; }

  const boys:  Row[] = [];
  const girls: Row[] = [];
  const other: Row[] = [];

  Object.entries(studentMeta)
    .map(([key, m]) => ({ key, displayName: formatNameForSF2(m.originalName), gender: m.gender }))
    .sort((a, b) => {
      const surnameCmp = extractSurname(a.displayName).localeCompare(extractSurname(b.displayName));
      return surnameCmp !== 0 ? surnameCmp : a.displayName.localeCompare(b.displayName);
    })
    .forEach(({ key, displayName, gender }) => {
      const row = { key, displayName };
      if      (gender === 'M') boys.push(row);
      else if (gender === 'F') girls.push(row);
      else                     other.push(row);
    });

  boys.push(...other);   // unknown gender appended to boys section

  /* ── load the uploaded DepEd template ── */
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file.path);

  if (!workbook.worksheets.length)
    return res.status(400).json({ error: 'Template has no worksheets' });

  const ws = workbook.worksheets[0];

  /* ── expand boy/girl blocks if the roster exceeds the template's built-in
     capacity (21 boys / 25 girls). New rows are cloned from the last row of
     each block — which already carries the correct B:C (name) and AE:AJ
     (remarks) merges — and inserted directly above the MALE/FEMALE total
     rows. Those total rows, plus the guidelines and signature block further
     down the sheet, are pushed down automatically by ExcelJS as part of the
     row insertion. Previously, any student past row 34 (boys) or row 60
     (girls) was silently dropped with no warning. ─────────────────────────── */
  const boysCapacity  = BOYS_END_ROW_TEMPLATE  - BOYS_START_ROW           + 1; // 21
  const girlsCapacity = GIRLS_END_ROW_TEMPLATE - GIRLS_START_ROW_TEMPLATE + 1; // 25

  const extraBoyRows  = Math.max(0, boys.length  - boysCapacity);
  const extraGirlRows = Math.max(0, girls.length - girlsCapacity);

  function ensureRowMerges(row: number) {
    const mergeIfMissing = (range: string) => {
      try { ws.mergeCells(range); } catch { /* already merged, ignore */ }
    };
    mergeIfMissing(`B${row}:C${row}`);
    mergeIfMissing(`AE${row}:AJ${row}`);
  }

  if (extraBoyRows > 0) {
    ws.duplicateRow(BOYS_END_ROW_TEMPLATE, extraBoyRows, true); // insert after row 34
    for (let r = BOYS_END_ROW_TEMPLATE + 1; r <= BOYS_END_ROW_TEMPLATE + extraBoyRows; r++) {
      ensureRowMerges(r);
    }
  }

  const boysEndRow    = BOYS_END_ROW_TEMPLATE   + extraBoyRows;
  const girlsStartRow = GIRLS_START_ROW_TEMPLATE + extraBoyRows;
  let   girlsEndRow   = GIRLS_END_ROW_TEMPLATE   + extraBoyRows;

  if (extraGirlRows > 0) {
    ws.duplicateRow(girlsEndRow, extraGirlRows, true); // insert after the (shifted) last girl row
    for (let r = girlsEndRow + 1; r <= girlsEndRow + extraGirlRows; r++) {
      ensureRowMerges(r);
    }
    girlsEndRow += extraGirlRows;
  }

  if (extraBoyRows > 0 || extraGirlRows > 0) {
    console.log(
      `[SF2] Roster (${boys.length} boys / ${girls.length} girls) exceeds template ` +
      `capacity (${boysCapacity}/${girlsCapacity}) — inserted ${extraBoyRows} boy row(s), ` +
      `${extraGirlRows} girl row(s).`,
    );
  }

  /* ── map weekday columns (Mon–Fri only, skip weekends) ── */
  const dayColumns: Record<number, number> = {};
  let col = FIRST_DAY_COLUMN;

  for (let d = 1; d <= totalDays; d++) {
    const wd = new Date(year, month - 1, d).getDay();
    if (wd >= 1 && wd <= 5) {
      dayColumns[d] = col;
      ws.getCell(DATE_ROW, col).value = d;
      ws.getCell(DAY_ROW,  col).value =
        ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][wd - 1];
      col++;
    }
  }

  /* ── triangle cell collectors (0-indexed for DrawingML) ── */
  const amCells: CellPos[] = [];
  const pmCells: CellPos[] = [];

  /* ── fill a gender section into the template ── */
  function fillSection(list: Row[], startRow: number, endRow: number) {
    list.forEach(({ key, displayName }, i) => {
      const row = startRow + i;
      if (row > endRow) return; // should be unreachable now — rows are pre-expanded to fit

      ws.getRow(row).height = ROW_HEIGHT;
      ws.getCell(row, NAME_COLUMN).value = displayName;

      for (const [dStr, c] of Object.entries(dayColumns)) {
        const day   = Number(dStr);
        const cell  = ws.getCell(row, c);
        const flags = studentMeta[key]?.days[day] ?? { am: false, pm: false };

        hardReset(cell);

        if (flags.am && flags.pm) {
          cell.fill = FULL_GREEN_FILL;
        } else if (flags.am) {
          cell.fill = NO_FILL;
          amCells.push({ col: c - 1, row: row - 1 });
        } else if (flags.pm) {
          cell.fill = NO_FILL;
          pmCells.push({ col: c - 1, row: row - 1 });
        } else {
          cell.fill = RED_FILL;
        }
      }
    });
  }

  fillSection(boys,  BOYS_START_ROW,  boysEndRow);
  fillSection(girls, girlsStartRow,   girlsEndRow);

  /* ── write base xlsx to disk ── */
  const outputPath = path.join(UPLOAD_DIR, `SF2_${Date.now()}.xlsx`);
  await workbook.xlsx.writeFile(outputPath);

  /* ── patch DrawingML triangles for AM-only / PM-only cells ── */
  await patchDrawings(outputPath, amCells, pmCells);

  /* ── clean up temp upload ── */
  fs.unlink(file.path, () => {});

  /* ── stream back to client ── */
  const monthName = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long' });
  const filename  = section
    ? `SF2_${section.replace(/\s+/g, '_')}_${monthName}_${year}.xlsx`
    : `SF2_${monthName}_${year}.xlsx`;

  res.setHeader('Content-Type',        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const fileStream = fs.createReadStream(outputPath);
  fileStream.pipe(res);
  fileStream.on('end',   () => fs.unlink(outputPath, () => {}));
  fileStream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONTROLLER: GET /api/sf2/preview
   ═══════════════════════════════════════════════════════════════════════════ */
export async function getSF2Preview(req: Request, res: Response) {
  try {
    const teacher   = (req as any).teacher;
    const { month, year, section } = req.query as Record<string, string>;

    if (!month || !year)
      return res.status(400).json({ error: 'month and year are required' });

    const m = parseInt(month, 10);
    const y = parseInt(year,  10);
    const targetSection = section?.trim() || teacher?.section?.trim();

    const meta      = await buildStudentMeta(m, y, targetSection);
    const schoolDays: string[] = [];
    const totalDays = daysInMonth(m, y);

    for (let d = 1; d <= totalDays; d++) {
      const wd = new Date(y, m - 1, d).getDay();
      if (wd >= 1 && wd <= 5) {
        schoolDays.push(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
      }
    }

    res.json({
      section:     targetSection ?? '',
      month:       m,
      year:        y,
      school_days: schoolDays.length,
      students:    Object.values(meta).map(rec => ({
        student_id:    rec.studentId,
        student_name:  formatNameForSF2(rec.originalName),
        gender:        rec.gender,
        days:          rec.days,
      })),
    });
  } catch (err: any) {
    console.error('[SF2 Preview]', err);
    res.status(500).json({ error: err.message ?? 'Internal server error' });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONTROLLER: GET /api/sf2/coordination-status
   ═══════════════════════════════════════════════════════════════════════════ */
export async function getCoordinationStatus(req: Request, res: Response) {
  try {
    const { month, year, section } = req.query as Record<string, string>;
    if (!month || !year || !section)
      return res.status(400).json({ error: 'month, year, and section are required' });

    const m         = parseInt(month, 10);
    const y         = parseInt(year,  10);
    const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
    const endDate   = `${y}-${String(m).padStart(2, '0')}-31`;

    // student_schedules has no teacher_name column — only teacher_id.
    // The actual name lives on teachers.name, so we join through that.
    // Advisory-tagged rows are excluded here — they have no matching
    // student_schedules entry (no subject is literally named "Advisory")
    // and are already counted separately below in advisoryRows.
    const [subjectRows] = await (pool as any).execute(`
      SELECT
        a.subject,
        t.name AS teacher_name,
        COUNT(DISTINCT a.date) AS days_recorded,
        COUNT(*)               AS total_records,
        MAX(a.date)            AS last_recorded
      FROM attendance a
      LEFT JOIN student_schedules s
             ON s.subject = a.subject
            AND s.section = a.section
      LEFT JOIN teachers t
             ON t.id = s.teacher_id
      WHERE a.section = ?
        AND a.date BETWEEN ? AND ?
        AND a.subject IS NOT NULL
        AND a.subject != ''
        AND a.subject != 'Advisory'
      GROUP BY a.subject, t.name
      ORDER BY a.subject
    `, [section, startDate, endDate]) as [any[], any];

    const totalDays = daysInMonth(m, y);
    let schoolDaysCount = 0;
    for (let d = 1; d <= totalDays; d++) {
      const wd = new Date(y, m - 1, d).getDay();
      if (wd >= 1 && wd <= 5) schoolDaysCount++;
    }

    const [advisoryRows] = await (pool as any).execute(`
      SELECT
        COUNT(DISTINCT date) AS days_recorded,
        COUNT(*)             AS total_records
      FROM attendance
      WHERE section = ?
        AND date BETWEEN ? AND ?
        AND (subject IS NULL OR subject = '' OR subject = 'Advisory')
    `, [section, startDate, endDate]) as [any[], any];

    res.json({
      section,
      month:       m,
      year:        y,
      school_days: schoolDaysCount,
      advisory:    advisoryRows[0] ?? { days_recorded: 0, total_records: 0 },
      subjects:    subjectRows,
    });

  } catch (err: any) {
    console.error('[SF2 Coordination]', err);
    res.status(500).json({ error: err.message ?? 'Internal server error' });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONTROLLER: GET /api/sf2/history  (legacy — kept for compatibility)
   ═══════════════════════════════════════════════════════════════════════════ */
export async function getSF2History(_req: Request, res: Response) {
  try {
    const [rows] = await (pool as any).execute(
      `SELECT * FROM sf2_reports ORDER BY created_at DESC LIMIT 50`,
    ) as [RowDataPacket[], any];
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}