/**
 * classRecordRoutes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ChildTrack HS Edition (SHS) — Class Record Route Definitions
 *
 * Mounted in routes/index.ts as:
 *   import classRecordRoutes from './classRecordRoutes';
 *   router.use('/class-record', classRecordRoutes);
 *
 * Final path: GET /api/class-record/generate
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express';
import { authMiddleware } from '../../middleware/authMiddleware';
import { generateClassRecord } from '../controllers/classRecordController';

const router = Router();

// All class-record routes require a valid teacher JWT
router.use(authMiddleware);

/**
 * GET /api/class-record/generate
 * Streams back a filled DepEd SHS Class Record (.xlsx) for a given
 * subject + section + quarter, pre-populated with enrolled learner names.
 *
 * Query params (all required except weightType/gradeLevel):
 *   subject    - subject name, e.g. "Empowerment Technologies"
 *   section    - section name (must match students.section, trimmed)
 *   quarter    - one of Q1, Q2, Q3, Q4
 *   schoolYear - e.g. "2025-2026"
 *   weightType - one of the SHS weight-type keys (Core/Academic, etc.)
 *   gradeLevel - e.g. "Grade 11" (used for the header row)
 */
router.get('/generate', generateClassRecord);

export default router;