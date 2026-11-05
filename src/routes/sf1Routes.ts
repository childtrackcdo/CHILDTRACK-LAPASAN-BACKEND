/**
 * sf1Routes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ChildTrack HS Edition — SF1 route definitions
 *
 * Mount in your main router:
 *   import sf1Router from './routes/sf1Routes';
 *   app.use('/api/sf1', authMiddleware, sf1Router);
 */

import { Router } from 'express';
import { sf1Upload, generateSF1, getSF1Preview } from '../controllers/sf1Controller';

const router = Router();

/**
 * GET /api/sf1/preview
 * Returns the list of students that would populate the SF1, without generating a file.
 * Query: section?, school_year?
 */
router.get('/preview', getSF1Preview);

/**
 * POST /api/sf1/generate
 * Accepts a multipart form with:
 *   file        (required) — blank DepEd SF1 .xlsx template
 *   section     (optional) — overrides teacher's advisory section
 *   school_year (optional) — e.g. "2024-2025"
 *   school_name (optional)
 *   school_id   (optional)
 *   region      (optional)
 *   division    (optional)
 *   district    (optional)
 *
 * Returns the filled SF1 workbook as a downloadable .xlsx.
 */
router.post('/generate', sf1Upload.single('file'), generateSF1);

export default router;