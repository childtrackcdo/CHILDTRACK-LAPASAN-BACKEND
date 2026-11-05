#!/usr/bin/env python3
"""
fill_class_record.py
Called by the Node.js backend via child_process.execFile to fill the DepEd
Class Record template using openpyxl, which preserves all styles, logos,
borders, and formatting — unlike SheetJS with cellStyles:false.

Usage (called by Node, not manually):
  python3 fill_class_record.py '<json_string>'

JSON input shape:
{
  "templatePath": "/path/to/Class Record SHS - All Subjects.xlsx",
  "outputPath":   "/tmp/some_output.xlsx",
  "schoolYear":   "2026-2027",
  "semester":     "FIRST SEMESTER",
  "subject":      "Komunikasyon...",
  "subjectType":  "CORE SUBJECT",
  "section":      "Grade 11 - Mabini",
  "teacher":      "Juan dela Cruz",
  "quarter":      "Q1",
  "males":        ["AQUINO, BRIAN A.", ...],
  "females":      ["ABAD, AMY B.", ...]
}

Exits 0 and prints "OK" on success.
Exits 1 and prints error message on failure.
"""
import sys
import json
from openpyxl import load_workbook

# Template sheet names — Q3/Q4 reuse Q1/Q2 sheets (second semester)
QUARTER_SHEET = {
    'Q1': 'CLASS RECORD Q1 ',  # trailing space is in the template
    'Q2': 'CLASS RECORD Q2',
    'Q3': 'CLASS RECORD Q1 ',
    'Q4': 'CLASS RECORD Q2',
}

def main():
    try:
        data = json.loads(sys.argv[1])

        school_year  = data['schoolYear']
        semester     = data['semester']
        subject      = data['subject']
        subject_type = data['subjectType']
        section      = data['section']
        teacher      = data.get('teacher', '')
        quarter      = data['quarter']
        males        = data['males']
        females      = data['females']

        wb = load_workbook(data['templatePath'])

        # ── DATA ENTRY ────────────────────────────────────────────────────
        de = wb['DATA ENTRY']
        de['C1'] = school_year
        de['C2'] = semester
        de['C3'] = subject
        de['C4'] = subject_type
        de['C5'] = section
        de['C6'] = teacher

        # Males → B9:B58 | Females → I9:I58
        for i, name in enumerate(males):
            de[f'B{9 + i}'] = name
        for i, name in enumerate(females):
            de[f'I{9 + i}'] = name

        # ── CLASS RECORD sheet ────────────────────────────────────────────
        # Write values directly so the file is print-ready without needing
        # Excel to recalculate the cross-sheet formula chain.
        #
        # Header cell map (verified against template):
        #   AG5 = School Year  |  X5  = Semester
        #   K7  = Grade & Section  |  S7 = Teacher  |  AG7 = Subject
        #
        # Name cell map:
        #   Males:   B12–B61  (row 12 = learner 1, up to 50)
        #   Females: B63–B112 (row 63 = learner 1, up to 50)
        sheet_name = QUARTER_SHEET.get(quarter)
        if not sheet_name or sheet_name not in wb.sheetnames:
            # Fallback: try without trailing space
            sheet_name = sheet_name.strip() if sheet_name else None
            if not sheet_name or sheet_name not in wb.sheetnames:
                raise ValueError(f'Sheet for quarter {quarter} not found. Available: {wb.sheetnames}')

        cr = wb[sheet_name]

        cr['AG5'] = school_year
        cr['X5']  = semester
        cr['K7']  = section
        cr['S7']  = teacher
        cr['AG7'] = subject

        for i, name in enumerate(males):
            cr[f'B{12 + i}'] = name
        for i, name in enumerate(females):
            cr[f'B{63 + i}'] = name

        wb.save(data['outputPath'])
        print('OK')
        sys.exit(0)

    except Exception as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()