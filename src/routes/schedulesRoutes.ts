import { Router } from 'express';
import {
  getSchedules,
  getScheduleById,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  getWeeklySchedule,
} from '../controllers/schedulesController';
import { authMiddleware } from '../../middleware/authMiddleware';

const router = Router();

// /weekly before /:id
router.get('/weekly',   authMiddleware, getWeeklySchedule);

router.get('/',         authMiddleware, getSchedules);
router.get('/:id',      authMiddleware, getScheduleById);
router.post('/',        authMiddleware, createSchedule);
router.patch('/:id',    authMiddleware, updateSchedule);
router.delete('/:id',   authMiddleware, deleteSchedule);

export default router;