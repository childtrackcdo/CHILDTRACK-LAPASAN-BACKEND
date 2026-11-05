/**
 * sf1Controller.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ChildTrack HS Edition — DepEd School Form 1 (SF1 / School Register) Generator
 * v8 — added concurrency guard to prevent overlapping generations from
 *      stacking memory pressure (multiple full template parses + per-page
 *      workbook parses can OOM the process on memory-constrained hosts).
 */

import { Response } from 'express';
import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';
import multer from 'multer';
import pool from '../../lib/db';
import { AuthRequest } from '../../middleware/authMiddleware';

console.log('[SF1] ✅ v8 — concurrency guard added around generateSF1');

/* ─── Multer ──────────────────────────────────────────────────────────────── */
export const sf1Upload = multer({
  dest: path.join(__dirname, '..', '..', 'uploads', 'sf1_tmp'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls'].includes(ext)) cb(null, true);
    else cb(new Error('Only .xlsx / .xls files are allowed'));
  },
});

/* ─── Output dir ──────────────────────────────────────────────────────────── */
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'sf1');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ─── Layout constants ────────────────────────────────────────────────────── */
const ROWS_PER_PAGE  = 18;
const DATA_START_ROW = 10;   // first student row in template

/* ─── Header value-box columns (1-based) ─────────────────────────────────── */
const HDR4 = { SCHOOL_ID: 6, REGION: 10, DIVISION: 13, DISTRICT: 19 };
const HDR6 = { SCHOOL_NAME: 6, SCHOOL_YEAR: 15, GRADE_LEVEL: 19, SECTION: 22 };

/* ─── Student data columns (1-based) ─────────────────────────────────────── */
const COL = {
  SEQ:           1,
  LRN:           2,
  NAME:          3,
  SEX:           7,
  BIRTHDATE:     8,
  AGE:           9,
  BIRTH_PLACE:   10,
  MOTHER_TONGUE: 11,
  IP:            12,
  RELIGION:      13,
  ADDRESS:       14,
  BARANGAY:      15,
  MUNICIPALITY:  16,
  PROVINCE:      17,
  FATHER:        18,
  MOTHER:        20,
  GUARDIAN_NAME: 22,
  GUARDIAN_REL:  23,
  CONTACT:       24,
  REMARKS:       25,
} as const;

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
function formatBirthdate(raw: string | null): string {
  if (!raw) return '';
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${mm}/${dd}/${yy}`;
  } catch { return raw; }
}

function normaliseGender(g: string | null): string {
  if (!g) return '';
  const u = g.toUpperCase().trim();
  if (u === 'M' || u === 'MALE')   return 'M';
  if (u === 'F' || u === 'FEMALE') return 'F';
  return g;
}

function parseGuardians(raw: any): {
  father: string; mother: string;
  guardianName: string; guardianRel: string; contact: string;
} {
  let arr: any[] = [];
  try {
    if (Array.isArray(raw))           arr = raw;
    else if (typeof raw === 'string') arr = JSON.parse(raw);
    else                              arr = raw ?? [];
  } catch { arr = []; }

  // Filter out null entries that JSON_ARRAYAGG adds when there are no rows
  arr = arr.filter((g: any) => g && g.name);

  const find = (role: string) => arr.find((g: any) =>
    (g.role || '').toLowerCase() === role.toLowerCase()
  );
  const p1  = find('Parent 1');
  const p2  = find('Parent 2');
  const grd = arr.find((g: any) => {
    const r = (g.role || '').toLowerCase();
    return r !== 'parent 1' && r !== 'parent 2';
  });

  return {
    father:       p1?.name   || '',
    mother:       p2?.name   || '',
    guardianName: grd?.name  || '',
    guardianRel:  grd?.role  || '',
    contact: (p1?.contact_number || p2?.contact_number || grd?.contact_number || ''),
  };
}

/* ─── DB fetch ────────────────────────────────────────────────────────────── */
async function fetchStudents(
  teacherId: number,
  section?: string,
  school_year?: string,
): Promise<any[]> {
  let sql = `
    SELECT
      s.lrn, s.name, s.gender, s.birthdate, s.age,
      s.contact, s.address, s.section, s.grade_level,
      s.school_year, s.enrollment_status,
      s.birth_place, s.mother_tongue, s.ip_ethnic,
      s.religion, s.barangay, s.municipality, s.province, s.remarks,
      CONCAT('[', COALESCE(
  GROUP_CONCAT(
    JSON_OBJECT(
      'role',           pg.role,
      'name',           pg.name,
      'contact_number', pg.contact_number
    )
    ORDER BY pg.id
    SEPARATOR ','
  ), ''
), ']') AS parents_guardians
    FROM students s
    LEFT JOIN parents_guardians pg ON pg.student_id = s.id
    WHERE s.teacher_id = ?
      AND s.enrollment_status NOT IN ('dropped', 'transferred')
  `;
  const params: any[] = [teacherId];

  if (section?.trim()) {
    const sn = section.includes(' - ') ? section.split(' - ')[1] : section;
    sql += ' AND s.section LIKE ?';
    params.push(`%${sn}%`);
  }
  if (school_year?.trim()) {
    sql += ' AND s.school_year = ?';
    params.push(school_year.trim());
  }

  sql += ' GROUP BY s.id ORDER BY s.name';

  const [rows] = await pool.execute(sql, params) as any[];
  return rows as any[];
}

/* ─── Fill one worksheet page ─────────────────────────────────────────────── */
function fillPage(
  ws: ExcelJS.Worksheet,
  pageStudents: any[],
  startNum: number,
  schoolInfo: Record<string, string>,
  totalCols: number,
): void {
  /* header row 4 */
  if (schoolInfo.school_id)   ws.getCell(4, HDR4.SCHOOL_ID).value = schoolInfo.school_id;
  if (schoolInfo.region)      ws.getCell(4, HDR4.REGION).value    = schoolInfo.region;
  if (schoolInfo.division)    ws.getCell(4, HDR4.DIVISION).value  = schoolInfo.division;
  if (schoolInfo.district)    ws.getCell(4, HDR4.DISTRICT).value  = schoolInfo.district;

  /* header row 6 */
  if (schoolInfo.school_name) ws.getCell(6, HDR6.SCHOOL_NAME).value  = schoolInfo.school_name;
  if (schoolInfo.school_year) ws.getCell(6, HDR6.SCHOOL_YEAR).value  = schoolInfo.school_year;
  if (schoolInfo.grade_level) ws.getCell(6, HDR6.GRADE_LEVEL).value  = schoolInfo.grade_level;
  if (schoolInfo.section)     ws.getCell(6, HDR6.SECTION).value      = schoolInfo.section;

  // Capture reference style from first data row
  const refStyles: Record<number, any> = {};
  for (let c = 1; c <= totalCols; c++) {
    const cell = ws.getCell(DATA_START_ROW, c);
    if (cell.style) refStyles[c] = JSON.parse(JSON.stringify(cell.style));
  }
  const refHeight = ws.getRow(DATA_START_ROW).height ?? 15;

  // ── Unmerge any merged regions that fall within the data rows ──────────────
  // Prevents row 14+ cell corruption caused by template merged cells
  const dataEndRow = DATA_START_ROW + ROWS_PER_PAGE - 1;
  (ws as any).model?.merges?.forEach((range: string) => {
    try {
      const match = range.match(/[A-Z]+(\d+)/);
      if (match) {
        const r = parseInt(match[1]);
        if (r >= DATA_START_ROW && r <= dataEndRow) {
          ws.unMergeCells(range);
        }
      }
    } catch { /* skip */ }
  });

  // ── Apply correct per-row merges matching the DepEd SF1 header structure ───
  // NAME: C–F (cols 3–6), Father: R–S (cols 18–19), Mother: T–U (cols 20–21)
  const DATA_ROW_MERGES: [number, number][] = [
    [3,  6],   // NAME column
    [18, 19],  // Father column
    [20, 21],  // Mother column
  ];
  for (let i = 0; i < pageStudents.length; i++) {
    const row = DATA_START_ROW + i;
    DATA_ROW_MERGES.forEach(([startCol, endCol]) => {
      const startLetter = ws.getColumn(startCol).letter;
      const endLetter   = ws.getColumn(endCol).letter;
      try { ws.mergeCells(`${startLetter}${row}:${endLetter}${row}`); } catch { /* skip */ }
    });
  }
  // ──────────────────────────────────────────────────────────────────────────

  /* student rows */
  pageStudents.forEach((s, i) => {
    const row = DATA_START_ROW + i;
    const pg  = parseGuardians(s.parents_guardians);

    // Apply reference style to every cell in this row FIRST so all rows
    // look identical (fixes left-aligned names on rows 13+)
    const destRow = ws.getRow(row);
    destRow.height = refHeight;
    for (let c = 1; c <= totalCols; c++) {
      const destCell = ws.getCell(row, c);
      if (refStyles[c]) destCell.style = JSON.parse(JSON.stringify(refStyles[c]));
      destCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }

    // Helper: write value and re-apply alignment
    const set = (col: number, val: any) => {
      const c = ws.getCell(row, col);
      c.value = val;
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    };

    set(COL.SEQ,           startNum + i);
    set(COL.LRN,           s.lrn            || '');
    set(COL.NAME,          s.name           || '');
    set(COL.SEX,           normaliseGender(s.gender));
    set(COL.BIRTHDATE,     formatBirthdate(s.birthdate));
    set(COL.AGE,           s.age            || '');
    set(COL.BIRTH_PLACE,   s.birth_place    || '');
    set(COL.MOTHER_TONGUE, s.mother_tongue  || '');
    set(COL.IP,            s.ip_ethnic      || '');
    set(COL.RELIGION,      s.religion       || '');
    set(COL.ADDRESS,       s.address        || '');
    set(COL.BARANGAY,      s.barangay       || '');
    set(COL.MUNICIPALITY,  s.municipality   || '');
    set(COL.PROVINCE,      s.province       || '');
    set(COL.FATHER,        pg.father);
    set(COL.MOTHER,        pg.mother);
    set(COL.GUARDIAN_NAME, pg.guardianName);
    set(COL.GUARDIAN_REL,  pg.guardianRel);
    set(COL.CONTACT,       pg.contact || s.contact || '');
    set(COL.REMARKS,       s.remarks        || '');
  });
}

// ── Concurrency guard ───────────────────────────────────────────────────────
// generateSF1 parses a fresh copy of the uploaded template once PER PAGE
// (multiple full ExcelJS workbook parses for a single request when a section
// has more than 18 students), plus deep-clones every cell style via
// JSON.stringify/parse for every row on every page. This is significantly
// more memory- and GC-intensive than a single-template-parse endpoint.
// On a memory-constrained host, two overlapping requests can each hold
// several parsed workbooks in memory at once and OOM-crash the whole
// process. This flag ensures only one generation runs at a time; a second
// request while one is in flight gets a clear 503 instead of silently
// stacking memory pressure on top of the first.
let sf1GenerationInProgress = false;

/* ═══════════════════════════════════════════════════════════════════════════
   CONTROLLER: POST /api/sf1/generate
   ═══════════════════════════════════════════════════════════════════════════ */
export async function generateSF1(req: AuthRequest, res: Response): Promise<void> {
  const file = req.file;
  if (!file) { res.status(400).json({ error: 'Upload the SF1 template file.' }); return; }

  if (sf1GenerationInProgress) {
    fs.unlink(file.path, () => {});
    res.status(503).json({
      error: 'Another SF1 is currently being generated. Please try again in a moment.',
    });
    return;
  }
  sf1GenerationInProgress = true;

  try {
    const teacherId = req.teacher!.id;
    const teacher   = req.teacher as any;

    const section     = (req.body.section     || teacher?.section || '').trim();
    const school_year = (req.body.school_year  || '').trim();
    const schoolInfo  = {
      school_id:   (req.body.school_id   || '').trim(),
      region:      (req.body.region      || '').trim(),
      division:    (req.body.division    || '').trim(),
      district:    (req.body.district    || '').trim(),
      school_name: (req.body.school_name || '').trim(),
      school_year,
      grade_level: '',
      section:     section.includes(' - ') ? section.split(' - ')[1] : section,
    };

    const students = await fetchStudents(teacherId, section, school_year);

    if (students.length === 0) {
      fs.unlink(file.path, () => {});
      res.status(404).json({ error: 'No enrolled students found for this section/school year.' });
      return;
    }

    schoolInfo.grade_level = students[0]?.grade_level || '';

    /* chunk into pages of 18 */
    const pages: any[][] = [];
    for (let i = 0; i < students.length; i += ROWS_PER_PAGE) {
      pages.push(students.slice(i, i + ROWS_PER_PAGE));
    }

    const workbook = new ExcelJS.Workbook();

    for (let p = 0; p < pages.length; p++) {
      /* Load a fresh copy of the template for each page */
      const tmpl = new ExcelJS.Workbook();
      await tmpl.xlsx.readFile(file.path);

      if (!tmpl.worksheets.length) {
        fs.unlink(file.path, () => {});
        res.status(400).json({ error: 'Template has no worksheets.' });
        return;
      }

      const srcWs = tmpl.worksheets[0];

      /* figure out how many columns the template uses */
      let totalCols = 25; // default (column Y)
      srcWs.eachRow({ includeEmpty: false }, row => {
        if ((row.actualCellCount ?? 0) > totalCols) totalCols = row.actualCellCount!;
      });

      const pageLabel = pages.length > 1 ? `Page ${p + 1}` : (schoolInfo.section || 'SF1');
      const destWs    = workbook.addWorksheet(pageLabel);

      /* Copy column widths */
      srcWs.columns.forEach((col, idx) => {
        if (col.width) destWs.getColumn(idx + 1).width = col.width;
      });

      /* Copy every row: values + styles */
      srcWs.eachRow({ includeEmpty: true }, (row, rowNum) => {
        const destRow = destWs.getRow(rowNum);
        destRow.height = row.height ?? 15;
        row.eachCell({ includeEmpty: true }, (cell, colNum) => {
          const destCell = destWs.getCell(rowNum, colNum);
          destCell.value = cell.value;
          if (cell.style) destCell.style = JSON.parse(JSON.stringify(cell.style));
        });
      });

      /* Copy merged cells */
      (srcWs as any).model?.merges?.forEach((mergeRange: string) => {
        try { destWs.mergeCells(mergeRange); } catch { /* skip duplicate */ }
      });

      /* ── Copy images / logos ─────────────────────────────────────────── */
      try {
        const wsMedia: any[] = (srcWs as any)._media ?? [];
        const tmplImgs: any[] = srcWs.getImages();

        console.log(`[SF1] p${p+1}: getImages=${tmplImgs.length}, _media=${wsMedia.length}, wb.media=${(tmpl as any).media?.length}`);

        if (tmplImgs.length > 0 && tmplImgs[0].range) {
          // ── Path A: normal ExcelJS Anchor objects ──────────────────────
          tmplImgs.forEach((img: any) => {
            try {
              const media = tmpl.getImage(img.imageId) as any;
              if (!media?.buffer) return;
              const newId = workbook.addImage({ buffer: media.buffer, extension: media.extension as any });
              const tl  = img.range.tl;
              const br  = img.range.br;
              const ext = img.range.ext;
              if (br) {
                destWs.addImage(newId, {
                  tl: { col: tl.nativeCol ?? 0, row: tl.nativeRow ?? 0 },
                  br: { col: br.nativeCol ?? 3, row: br.nativeRow ?? 6 },
                } as any);
              } else {
                destWs.addImage(newId, {
                  tl:  { col: tl.nativeCol ?? 0, row: tl.nativeRow ?? 0 },
                  ext: { width: ext?.width ?? 150, height: ext?.height ?? 80 },
                } as any);
              }
              console.log(`[SF1] ✅ path-A copied image ${img.imageId}`);
            } catch (e) { console.warn('[SF1] path-A image error:', e); }
          });

        } else if (wsMedia.length > 0) {
          // ── Path B: _media has entries but Anchors are broken ──────────
          wsMedia.forEach((m: any) => {
            try {
              const srcImg = tmpl.getImage(m.imageId ?? m.index) as any;
              if (!srcImg?.buffer) return;
              const newId = workbook.addImage({ buffer: srcImg.buffer, extension: srcImg.extension as any });
              destWs.addImage(newId, {
                tl: { col: m.range?.tl?.nativeCol ?? m.tl?.nativeCol ?? 0,
                      row: m.range?.tl?.nativeRow ?? m.tl?.nativeRow ?? 0 },
                br: { col: m.range?.br?.nativeCol ?? m.br?.nativeCol ?? 3,
                      row: m.range?.br?.nativeRow ?? m.br?.nativeRow ?? 6 },
              } as any);
              console.log(`[SF1] ✅ path-B copied image`);
            } catch (e) { console.warn('[SF1] path-B image error:', e); }
          });

        } else if (((tmpl as any).media?.length ?? 0) > 0) {
          // ── Path C: hardcode DepEd logo positions ──────────────────────
          const seen = new Set<number>();
          const logoPositions = [
            { tl: { col: 0, row: 0 }, br: { col: 3, row: 6 } },
            { tl: { col: 22, row: 0 }, br: { col: 25, row: 6 } },
          ];
          let posIdx = 0;
          (tmpl as any).media.forEach((m: any) => {
            if (seen.has(m.buffer?.length)) return;
            seen.add(m.buffer?.length);
            const pos = logoPositions[posIdx++];
            if (!pos || !m.buffer) return;
            try {
              const newId = workbook.addImage({ buffer: m.buffer, extension: (m.extension ?? 'png') as any });
              destWs.addImage(newId, pos as any);
              console.log(`[SF1] ✅ path-C logo ${posIdx} added`);
            } catch (e) { console.warn('[SF1] path-C image error:', e); }
          });
        }
      } catch (e) {
        console.warn('[SF1] Image copy block error:', e);
      }

      /* Fill data */
      fillPage(destWs, pages[p], p * ROWS_PER_PAGE + 1, schoolInfo, totalCols);
    }

    /* write to disk */
    const outputPath = path.join(UPLOAD_DIR, `SF1_${Date.now()}.xlsx`);
    await workbook.xlsx.writeFile(outputPath);

    fs.unlink(file.path, () => {});

    /* stream to client */
    const safeSec  = schoolInfo.section.replace(/\s+/g, '_') || 'Section';
    const safeYear = school_year.replace(/[^a-zA-Z0-9-]/g, '') || new Date().getFullYear().toString();
    const filename = `SF1_${safeSec}_${safeYear}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end',   () => fs.unlink(outputPath, () => {}));
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });

    console.log(`[SF1] ✅ section="${section}" pages=${pages.length} students=${students.length} file="${filename}"`);

  } catch (err: any) {
    console.error('[SF1] generateSF1 error:', err);
    fs.unlink(file.path, () => {});
    if (!res.headersSent) res.status(500).json({ error: err.message ?? 'Server error' });
  } finally {
    sf1GenerationInProgress = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONTROLLER: GET /api/sf1/preview
   ═══════════════════════════════════════════════════════════════════════════ */
export async function getSF1Preview(req: AuthRequest, res: Response): Promise<void> {
  try {
    const teacherId   = req.teacher!.id;
    const teacher     = req.teacher as any;
    const section     = ((req.query.section     as string) || teacher?.section || '').trim();
    const school_year = ((req.query.school_year as string) || '').trim();

    const students = await fetchStudents(teacherId, section, school_year);

    res.json({
      section,
      school_year,
      count:      students.length,
      page_count: Math.ceil(students.length / ROWS_PER_PAGE),
      students: students.map((s, i) => {
        const pg = parseGuardians(s.parents_guardians);
        return {
          row_number:    i + 1,
          lrn:           s.lrn,
          name:          s.name,
          gender:        normaliseGender(s.gender),
          birthdate:     formatBirthdate(s.birthdate),
          age:           s.age,
          birth_place:   s.birth_place,
          mother_tongue: s.mother_tongue,
          ip_ethnic:     s.ip_ethnic,
          religion:      s.religion,
          address:       s.address,
          barangay:      s.barangay,
          municipality:  s.municipality,
          province:      s.province,
          father:        pg.father,
          mother:        pg.mother,
          guardian:      pg.guardianName,
          contact:       pg.contact || s.contact,
          remarks:       s.remarks,
          grade_level:   s.grade_level,
          section:       s.section,
          school_year:   s.school_year,
        };
      }),
    });
  } catch (err: any) {
    console.error('[SF1] getSF1Preview error:', err);
    res.status(500).json({ error: err.message ?? 'Server error' });
  }
}