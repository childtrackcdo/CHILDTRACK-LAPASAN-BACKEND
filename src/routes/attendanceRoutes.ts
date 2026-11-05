import { Router } from 'express';
import {
  getAttendance,
  createAttendance,
  updateAttendance,
  deleteAttendance,
  getAttendanceForParent,
  getAttendanceSummary,
  verifyInClass,
  verifyBulk,
} from '../controllers/attendanceController';
import { authMiddleware }       from '../../middleware/authMiddleware';
import { parentAuthMiddleware } from '../../middleware/parentAuthMiddleware';

const router = Router();

// ── Static paths FIRST (before any /:id routes) ───────────────────────────────
router.get   ('/stats',       authMiddleware,       getAttendanceSummary);
router.get   ('/for-parent',  parentAuthMiddleware, getAttendanceForParent);
router.patch ('/verify-bulk', authMiddleware,       verifyBulk);

// ── Collection ────────────────────────────────────────────────────────────────
router.get  ('/', authMiddleware, getAttendance);
// POST /api/attendance — fires insertNotification() for manually-marked records
router.post ('/', authMiddleware, createAttendance);

// ── Dynamic /:id routes LAST ──────────────────────────────────────────────────
router.patch ('/:id/verify', authMiddleware, verifyInClass);
router.patch ('/:id',        authMiddleware, updateAttendance);
router.delete('/:id',        authMiddleware, deleteAttendance);

export default router;