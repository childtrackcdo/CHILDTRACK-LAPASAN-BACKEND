// ─────────────────────────────────────────────────────────────────────────────
// ADD THESE IMPORTS at the top of routes/index.ts (with your other imports)
// ─────────────────────────────────────────────────────────────────────────────
import express from 'express';
const router = express.Router();
import { adminMiddleware } from '../../middleware/adminMiddleware';
import {
  getAdminStats,
  getTeachers, getTeacherById, createTeacher, updateTeacher,
  resetTeacherPassword, deleteTeacher,
  adminGetStudents, adminGetStudentById, adminEnrollStudent,
  adminUpdateStudent, adminDeleteStudent,
  adminGetAttendance, adminGetAttendanceSummary,
  adminGetEvents, adminCreateEvent, adminUpdateEvent, adminDeleteEvent,
} from '../controllers/adminController';

// ─────────────────────────────────────────────────────────────────────────────
// ADD THESE ROUTES before `export default router` in routes/index.ts
// ─────────────────────────────────────────────────────────────────────────────

// ── Admin Stats ───────────────────────────────────────────────────────────────
router.get('/admin/stats', adminMiddleware, getAdminStats);

// ── Admin Teachers ────────────────────────────────────────────────────────────
router.get   ('/admin/teachers',                     adminMiddleware, getTeachers);
router.get   ('/admin/teachers/:id',                 adminMiddleware, getTeacherById);
router.post  ('/admin/teachers',                     adminMiddleware, createTeacher);
router.patch ('/admin/teachers/:id',                 adminMiddleware, updateTeacher);
router.patch ('/admin/teachers/:id/reset-password',  adminMiddleware, resetTeacherPassword);
router.delete('/admin/teachers/:id',                 adminMiddleware, deleteTeacher);

// ── Admin Students ────────────────────────────────────────────────────────────
router.get   ('/admin/students',                     adminMiddleware, adminGetStudents);
router.get   ('/admin/students/:id',                 adminMiddleware, adminGetStudentById);
router.post  ('/admin/students/enroll',              adminMiddleware, adminEnrollStudent);
router.patch ('/admin/students/:id',                 adminMiddleware, adminUpdateStudent);
router.delete('/admin/students/:id',                 adminMiddleware, adminDeleteStudent);

// ── Admin Attendance ──────────────────────────────────────────────────────────
router.get   ('/admin/attendance',                   adminMiddleware, adminGetAttendance);
router.get   ('/admin/attendance/summary',           adminMiddleware, adminGetAttendanceSummary);

// ── Admin Events ──────────────────────────────────────────────────────────────
router.get   ('/admin/events',                       adminMiddleware, adminGetEvents);
router.post  ('/admin/events',                       adminMiddleware, adminCreateEvent);
router.patch ('/admin/events/:id',                   adminMiddleware, adminUpdateEvent);
router.delete('/admin/events/:id',                   adminMiddleware, adminDeleteEvent);

export default router;