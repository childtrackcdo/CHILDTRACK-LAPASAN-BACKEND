import { Router } from 'express';
import {
  login,
  getProfile,
  updateProfile,
  changePassword,
  getOverview,
  getAllAttendance,
  getAllEnrollments,
  updateEnrollmentStatus,
  getAllTeachers,
  getAllStudents,
  getAllSchedules,
  getAllAbsences,
  getAllEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from '../controllers/principalController';
import { principalMiddleware } from '../../middleware/principalMiddleware';

const router = Router();

// Auth
router.post('/login',                       login);

// Profile
router.get('/profile',                      principalMiddleware, getProfile);
router.put('/profile',                      principalMiddleware, updateProfile);
router.put('/change-password',              principalMiddleware, changePassword);

// Dashboard
router.get('/overview',                     getOverview);

// Data views
router.get('/attendance',                   getAllAttendance);
router.get('/enrollments',                  getAllEnrollments);
router.patch('/enrollments/:id/status',     principalMiddleware, updateEnrollmentStatus);
router.get('/teachers',                     getAllTeachers);
router.get('/students',                     getAllStudents);
router.get('/schedules',                    getAllSchedules);
router.get('/absences',                     getAllAbsences);

// Events
router.get('/events',                       getAllEvents);
router.post('/events',                      principalMiddleware, createEvent);
router.put('/events/:id',                   principalMiddleware, updateEvent);
router.delete('/events/:id',                principalMiddleware, deleteEvent);

export default router;