import { Router } from 'express';
import {
  studentLogin,
  getStudentProfile,
  updateStudentProfile,
  changeStudentPassword,
  studentSelfMiddleware,
  getStudentSelf,
  getStudentSelfAttendance,
  getStudentSelfSchedule,
  getStudentSelfGrades,
  getStudentSelfEvents,
  getStudentSelfNotifications,
  markStudentNotificationRead,
} from '../controllers/studentAuthController';

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────────
router.post('/login', studentLogin);

// ── Self (JWT-authenticated student) ─────────────────────────────────────────
router.get  ('/self/me',            studentSelfMiddleware, getStudentSelf);
router.get  ('/self/attendance',    studentSelfMiddleware, getStudentSelfAttendance);
router.get  ('/self/schedule',      studentSelfMiddleware, getStudentSelfSchedule);
router.get  ('/self/grades',        studentSelfMiddleware, getStudentSelfGrades);
router.get  ('/self/events',        studentSelfMiddleware, getStudentSelfEvents);
router.get  ('/self/notifications', studentSelfMiddleware, getStudentSelfNotifications);
router.patch('/notifications/:id/read', studentSelfMiddleware, markStudentNotificationRead);

// ── Profile (by numeric ID) ───────────────────────────────────────────────────
router.get  ('/:id/profile', getStudentProfile);
router.patch('/:id/profile', updateStudentProfile);
router.patch('/:id/password', changeStudentPassword);

export default router;