import { Router, Response, NextFunction } from 'express';
import { authMiddleware }       from '../../middleware/authMiddleware';
import { adminMiddleware }      from '../../middleware/adminMiddleware';
import { parentAuthMiddleware } from '../../middleware/parentAuthMiddleware';
import { verifyToken }          from '../../lib/auth';
import pool                     from '../../lib/db';

import { login, register }                                     from '../controllers/authController';
import { enrollmentLogin, enrollmentRegister }                 from '../controllers/enrollmentAuthController';
import { adminLogin, adminRegister }                           from '../controllers/adminAuthController';


import { getEnrollments, getEnrollmentById, getEnrollmentStats, createEnrollment, updateEnrollment, updateEnrollmentStatus, deleteEnrollment } from '../controllers/enrollmentController';

import { getStudents, getStudentById, getStudentByLRN, createStudent, updateStudent, deleteStudent, updateStudentEnrollmentStatus, getStudentStats, dropoutStudent, activateParentAccount, activateStudentAccount, getDistinctSections } from '../controllers/studentController';

import { getAllEvents, getEventById, createEvent, updateEvent, deleteEvent } from '../controllers/eventsController';

import { getSchedules, createSchedule, updateSchedule, deleteSchedule, getSchedulesForParent } from '../controllers/schedulesController';

import { submitAbsenceReason, getAbsenceReasons, updateAbsenceReasonStatus, deleteAbsenceReason } from '../controllers/absenceReasonsController';

import { getSubjects, getStudentsBySection } from '../controllers/gradesController';

import { getSubjects as getSubjectsCatalog, getSubjectById, createSubject, updateSubject, deleteSubject, getPublicSubjectList, getSubjectStats } from '../controllers/subjectsController';

import { getGuardians, getGuardianById, createGuardian, updateGuardian, deleteGuardian } from '../controllers/guardianController';

import { uploadScanPhoto, getScanPhotos, deleteScanPhoto } from '../controllers/scanPhotoController';

import { getAdminStats, getTeachers, getTeacherById, createTeacher, updateTeacher, resetTeacherPassword, deleteTeacher, adminGetStudents, adminGetStudentById, adminEnrollStudent, adminUpdateStudent, adminUpdateStudentStatus, adminDeleteStudent, adminGetAttendance, adminGetAttendanceSummary, adminGetInOut, adminGetEvents, adminCreateEvent, adminUpdateEvent, adminDeleteEvent, updateAdminProfile, changeAdminPassword } from '../controllers/adminController';

import { getParentNotifications, markParentNotificationRead, markAllParentNotificationsRead, saveExpoPushToken } from '../controllers/parentNotificationControllers';

import { getPublicTeacher, publicRegisterStudent } from '../controllers/publicController';

import {
  adminGetSchedules, adminCreateSchedule, adminUpdateSchedule, adminDeleteSchedule,
} from '../controllers/adminSchedulesController';
// ── NEW: Admin Subjects controller ────────────────────────────────────────────
import {
  adminGetSubjects,
  adminGetSubjectById,
  adminCreateSubject,
  adminUpdateSubject,
  adminDeleteSubject,
} from '../controllers/adminSubjectsController';

import parentAuthRoutes  from './parentAuthRoutes';
import studentAuthRoutes from './studentAuthRoutes';
import gradesRoutes       from './gradesRoutes';

const router = Router();

// ═════════════════════════════════════════════════════════════════════════════
// Auth helpers
// ═════════════════════════════════════════════════════════════════════════════

function anyAuth(req: any, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' }); return;
  }
  try {
    const decoded = verifyToken(authHeader.split(' ')[1]) as any;
    if (decoded.username) {
      req.enrollmentAdmin = { id: decoded.id, username: decoded.username, role: decoded.role };
    } else {
      req.teacher = decoded;
    }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function parentOrTeacherAuth(req: any, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' }); return;
  }
  try {
    const decoded = verifyToken(authHeader.split(' ')[1]) as any;
    if (decoded.student_name || decoded.lrn) {
      req.parent = decoded;
    } else {
      req.teacher = decoded;
    }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Public routes
// ═════════════════════════════════════════════════════════════════════════════

router.post('/auth/login',               login);
router.post('/auth/register',            register);
router.post('/enrollment/auth/login',    enrollmentLogin);
router.post('/enrollment/auth/register', enrollmentRegister);
router.post('/admin/auth/login',         adminLogin);
router.post('/admin/auth/register',      adminRegister);

router.use('/parent-auth',  parentAuthRoutes);
router.use('/student-auth', studentAuthRoutes);


router.get('/subject-catalog/public', getPublicSubjectList);

router.get ('/public/teacher/:teacherId',  getPublicTeacher);
router.post('/public/register/:teacherId', publicRegisterStudent);

// ═════════════════════════════════════════════════════════════════════════════
// Device prefs
// ═════════════════════════════════════════════════════════════════════════════

router.get('/device-prefs/:deviceId', async (req: any, res: Response) => {
  try {
    const [rows]: any = await pool.query(
      'SELECT * FROM device_prefs WHERE device_id = ?',
      [req.params.deviceId],
    );
    res.json(rows[0] ?? null);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'DB error' });
  }
});

router.patch('/device-prefs/:deviceId', async (req: any, res: Response) => {
  const { theme, super_dark, mono, font, sidebar_w } = req.body;
  try {
    await pool.query(
      `INSERT INTO device_prefs (device_id, theme, super_dark, mono, font, sidebar_w)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         theme      = VALUES(theme),
         super_dark = VALUES(super_dark),
         mono       = VALUES(mono),
         font       = VALUES(font),
         sidebar_w  = VALUES(sidebar_w)`,
      [req.params.deviceId, theme ?? 'light', super_dark ? 1 : 0, mono ? 1 : 0, font ?? 'nunito', sidebar_w ?? 252],
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'DB error' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GSM / SMS
// ═════════════════════════════════════════════════════════════════════════════


// ═════════════════════════════════════════════════════════════════════════════
// Enrollments
// ═════════════════════════════════════════════════════════════════════════════

router.get   ('/enrollments/stats',      anyAuth, getEnrollmentStats);
router.get   ('/enrollments',            anyAuth, getEnrollments);
router.get   ('/enrollments/:id',        anyAuth, getEnrollmentById);
router.post  ('/enrollments',            anyAuth, createEnrollment);
router.patch ('/enrollments/:id',        anyAuth, updateEnrollment);
router.patch ('/enrollments/:id/status', anyAuth, updateEnrollmentStatus);
router.delete('/enrollments/:id',        anyAuth, deleteEnrollment);

// ═════════════════════════════════════════════════════════════════════════════
// Students
// ═════════════════════════════════════════════════════════════════════════════

router.get   ('/students/stats',                authMiddleware,       getStudentStats);
router.get   ('/students/sections',             authMiddleware,       getDistinctSections);
router.get   ('/students/search',               authMiddleware,       getStudentsBySection);
router.get   ('/students/lrn/:lrn',             authMiddleware,       getStudentByLRN);
router.get   ('/students/by-lrn/:lrn',          parentAuthMiddleware, getStudentByLRN);
router.get   ('/students',                      authMiddleware,       getStudents);
router.get   ('/students/:id',                  authMiddleware,       getStudentById);
router.post  ('/students',                      authMiddleware,       createStudent);
router.patch ('/students/:id',                  authMiddleware,       updateStudent);
router.patch ('/students/:id/status',           authMiddleware,       updateStudentEnrollmentStatus);
router.patch ('/students/:id/dropout',          authMiddleware,       dropoutStudent);
router.patch ('/students/:id/activate-parent',  authMiddleware,       activateParentAccount);
router.patch ('/students/:id/activate-student', authMiddleware,       activateStudentAccount);
router.delete('/students/:id',                  authMiddleware,       deleteStudent);

// ═════════════════════════════════════════════════════════════════════════════
// Absence Reasons
// ═════════════════════════════════════════════════════════════════════════════

router.get   ('/absence-reasons',            parentOrTeacherAuth, getAbsenceReasons);
router.post  ('/absence-reasons',            parentOrTeacherAuth, submitAbsenceReason);
router.patch ('/absence-reasons/:id/status', authMiddleware,      updateAbsenceReasonStatus);
router.delete('/absence-reasons/:id',        authMiddleware,      deleteAbsenceReason);

// ═════════════════════════════════════════════════════════════════════════════
// Parent
// ═════════════════════════════════════════════════════════════════════════════

router.get  ('/parent-notifications',            parentAuthMiddleware, getParentNotifications);
router.patch('/parent-notifications/read-all',   parentAuthMiddleware, markAllParentNotificationsRead);
router.patch('/parent-notifications/:id/read',   parentAuthMiddleware, markParentNotificationRead);
router.post ('/parent-notifications/push-token', parentAuthMiddleware, saveExpoPushToken);
router.get  ('/student-schedules',               parentAuthMiddleware, getSchedulesForParent);

// ═════════════════════════════════════════════════════════════════════════════
// Scan Photos
// ═════════════════════════════════════════════════════════════════════════════

router.get   ('/scan-photos',     authMiddleware, getScanPhotos);
router.post  ('/scan-photos',     authMiddleware, uploadScanPhoto);
router.delete('/scan-photos/:id', authMiddleware, deleteScanPhoto);

// ═════════════════════════════════════════════════════════════════════════════
// Events
// ═════════════════════════════════════════════════════════════════════════════

router.get   ('/events',     authMiddleware, getAllEvents);
router.get   ('/events/:id', authMiddleware, getEventById);
router.post  ('/events',     authMiddleware, createEvent);
router.patch ('/events/:id', authMiddleware, updateEvent);
router.delete('/events/:id', authMiddleware, deleteEvent);

// ═════════════════════════════════════════════════════════════════════════════
// Schedules
// ═════════════════════════════════════════════════════════════════════════════

router.get   ('/schedules',     authMiddleware, getSchedules);
router.post  ('/schedules',     authMiddleware, createSchedule);
router.patch ('/schedules/:id', authMiddleware, updateSchedule);
router.delete('/schedules/:id', authMiddleware, deleteSchedule);

// ═════════════════════════════════════════════════════════════════════════════
// SF1 and SF2 — MOVED to sf-service (port 5001). See vite.config.ts proxy
// rules for /api/sf1 and /api/sf2, which route directly to that service.
// Do NOT re-add sf1Controller/sf2Routes imports or route registrations here —
// doing so silently shadows sf-service again since this router is mounted
// at '/api' in server.ts.
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// Class Record — MOVED to sf-service (port 5001). See vite.config.ts proxy
// rules for /api/class-record, which routes directly to that service.
// Do NOT re-add classRecordController/classRecordRoutes imports or route
// registrations here — doing so silently shadows sf-service again since
// this router is mounted at '/api' in server.ts.
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// Grades
// ═════════════════════════════════════════════════════════════════════════════

router.use('/grades', gradesRoutes);

router.get('/subjects', authMiddleware, getSubjects);

// ═════════════════════════════════════════════════════════════════════════════
// Subject Catalog
// ═════════════════════════════════════════════════════════════════════════════

router.get   ('/subject-catalog/stats', authMiddleware, getSubjectStats);
router.get   ('/subject-catalog',       authMiddleware, getSubjectsCatalog);
router.get   ('/subject-catalog/:id',   authMiddleware, getSubjectById);
router.post  ('/subject-catalog',       authMiddleware, createSubject);
router.patch ('/subject-catalog/:id',   authMiddleware, updateSubject);
router.delete('/subject-catalog/:id',   authMiddleware, deleteSubject);

// ═════════════════════════════════════════════════════════════════════════════
// Guardians
// ═════════════════════════════════════════════════════════════════════════════

router.get   ('/guardians',     authMiddleware, getGuardians);
router.get   ('/guardians/:id', authMiddleware, getGuardianById);
router.post  ('/guardians',     authMiddleware, createGuardian);
router.patch ('/guardians/:id', authMiddleware, updateGuardian);
router.delete('/guardians/:id', authMiddleware, deleteGuardian);

// ═════════════════════════════════════════════════════════════════════════════
// Admin
// ═════════════════════════════════════════════════════════════════════════════

router.get   ('/admin/stats',                       adminMiddleware, getAdminStats);
router.get   ('/admin/teachers',                    adminMiddleware, getTeachers);
router.get   ('/admin/teachers/:id',                adminMiddleware, getTeacherById);
router.post  ('/admin/teachers',                    adminMiddleware, createTeacher);
router.patch ('/admin/teachers/:id',                adminMiddleware, updateTeacher);
router.patch ('/admin/teachers/:id/reset-password', adminMiddleware, resetTeacherPassword);
router.delete('/admin/teachers/:id',                adminMiddleware, deleteTeacher);
router.get   ('/admin/students',                    adminMiddleware, adminGetStudents);
router.get   ('/admin/students/:id',                adminMiddleware, adminGetStudentById);
router.post  ('/admin/students',                    adminMiddleware, adminEnrollStudent);
router.patch ('/admin/students/:id',                adminMiddleware, adminUpdateStudent);
router.patch ('/admin/students/:id/status',         adminMiddleware, adminUpdateStudentStatus);
router.delete('/admin/students/:id',                adminMiddleware, adminDeleteStudent);
router.get   ('/admin/attendance/summary',          adminMiddleware, adminGetAttendanceSummary);
router.get   ('/admin/attendance',                  adminMiddleware, adminGetAttendance);
router.get   ('/admin/in-out',                      adminMiddleware, adminGetInOut);
router.get   ('/admin/events',                      adminMiddleware, adminGetEvents);
router.post  ('/admin/events',                      adminMiddleware, adminCreateEvent);
router.patch ('/admin/events/:id',                  adminMiddleware, adminUpdateEvent);
router.delete('/admin/events/:id',                  adminMiddleware, adminDeleteEvent);
router.put   ('/admin/profile',                     adminMiddleware, updateAdminProfile);
router.put   ('/admin/change-password',             adminMiddleware, changeAdminPassword);

// ── Admin Subjects ────────────────────────────────────────────────────────────
router.get   ('/admin/subjects',     adminMiddleware, adminGetSubjects);
router.get   ('/admin/subjects/:id', adminMiddleware, adminGetSubjectById);
router.post  ('/admin/subjects',     adminMiddleware, adminCreateSubject);
router.patch ('/admin/subjects/:id', adminMiddleware, adminUpdateSubject);
router.delete('/admin/subjects/:id', adminMiddleware, adminDeleteSubject);


// ── Admin Schedule Assignments (teacher + section + day/time for a subject) ──
router.get   ('/admin/schedules',     adminMiddleware, adminGetSchedules);
router.post  ('/admin/schedules',     adminMiddleware, adminCreateSchedule);
router.patch ('/admin/schedules/:id', adminMiddleware, adminUpdateSchedule);
router.delete('/admin/schedules/:id', adminMiddleware, adminDeleteSchedule);

export default router;