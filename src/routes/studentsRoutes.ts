import { Router } from 'express';
import {
  getStudents,
  getStudentById,
  getStudentByLRN,
  createStudent,
  updateStudent,
  deleteStudent,
  updateStudentEnrollmentStatus,
  getStudentStats,
  dropoutStudent,
  getDistinctSections,            // ← ADD THIS IMPORT
} from '../controllers/studentController';
import { authMiddleware } from '../../middleware/authMiddleware';

const router = Router();

// ── Static named routes first (before /:id) ────────────────────────────────
router.get('/stats',     authMiddleware, getStudentStats);
router.get('/sections',  authMiddleware, getDistinctSections);  // ← ADD THIS LINE
router.get('/lrn/:lrn',                 getStudentByLRN);  // public — QR scan

// ── Collection routes ──────────────────────────────────────────────────────
router.get('/',  authMiddleware, getStudents);
router.post('/', authMiddleware, createStudent);

// ── Dynamic /:id routes last ───────────────────────────────────────────────
router.get('/:id',          authMiddleware, getStudentById);
router.patch('/:id/status', authMiddleware, updateStudentEnrollmentStatus);
router.patch('/:id/dropout',authMiddleware, dropoutStudent);
router.patch('/:id',        authMiddleware, updateStudent);
router.delete('/:id',       authMiddleware, deleteStudent);

export default router;