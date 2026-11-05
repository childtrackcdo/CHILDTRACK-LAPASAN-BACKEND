/**
 * gradesRoutes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ChildTrack HS Edition — Grades Route Definitions
 *
 * Mounted in routes/index.ts as:
 *   import gradesRoutes from './gradesRoutes';
 *   router.use('/grades', gradesRoutes);
 *
 * NOTE: report sub-routes are declared BEFORE '/:id' so Express doesn't
 * try to match "report" as an :id param.
 *
 * NOTE: getSubjects and getStudentsBySection (also exported from
 * gradesController) are NOT mounted here — they stay in routes/index.ts
 * as '/subjects' and '/students/search' respectively, since they belong
 * to different resource namespaces even though they share a controller file.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express';
import { authMiddleware } from '../../middleware/authMiddleware';
import {
  getGrades,
  createGrade,
  updateGrade,
  deleteGrade,
  getSF9Data,
  getSF10Data,
} from '../controllers/gradesController';

const router = Router();

router.use(authMiddleware);

router.get('/report/sf9/:student_id',  getSF9Data);
router.get('/report/sf10/:student_id', getSF10Data);

router.get('/',       getGrades);
router.post('/',      createGrade);
router.patch('/:id',  updateGrade);
router.delete('/:id', deleteGrade);

export default router;