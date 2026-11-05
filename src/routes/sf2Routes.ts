/**
 * sf2Routes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ChildTrack HS Edition — SF2 Route Definitions
 *
 * Mounted in routes/index.ts as:
 *   import sf2Routes from './sf2Routes';
 *   router.use('/sf2', sf2Routes);
 *
 * Final paths:
 *   GET  /api/sf2/preview
 *   GET  /api/sf2/coordination-status
 *   GET  /api/sf2/history
 *   POST /api/sf2/generate
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express';
import { authMiddleware } from '../../middleware/authMiddleware';
import {
  sf2Upload,
  generateSF2,
  getSF2Preview,
  getCoordinationStatus,
  getSF2History,
} from '../controllers/sf2Controller';

const router = Router();

// All SF2 routes require a valid teacher JWT
router.use(authMiddleware);

/**
 * GET /api/sf2/preview
 * Returns a JSON preview of merged advisory + subject attendance.
 * Used by the adviser dashboard before generating the Excel file.
 *
 * Query params:
 *   month    - 1-12
 *   year     - e.g. 2025
 *   section  - optional; defaults to adviser's own section from JWT
 */
router.get('/preview', getSF2Preview);

/**
 * GET /api/sf2/coordination-status
 * Shows which subject teachers have/haven't submitted records for a
 * given section + month. Helps advisers identify data gaps before
 * generating the final SF2.
 *
 * Query params:
 *   month   - 1-12
 *   year    - e.g. 2025
 *   section - required
 */
router.get('/coordination-status', getCoordinationStatus);

/**
 * GET /api/sf2/history
 * Legacy — kept for compatibility. Returns the last 50 generated
 * sf2_reports rows, if that table is still populated anywhere.
 */
router.get('/history', getSF2History);

/**
 * POST /api/sf2/generate
 * Generates and streams back a filled SF2 Excel file.
 *
 * Multipart body:
 *   template_file - uploaded .xlsx/.xls DepEd template (required —
 *                   generateSF2 currently 400s if req.file is missing)
 *   month         - 1-12
 *   year          - e.g. 2025
 *   section       - optional; defaults to adviser's section from JWT
 */
router.post('/generate', sf2Upload.single('template_file'), generateSF2);

export default router;