import { Router } from 'express';
import {
  getAllEvents,
  getEventById,
  createEvent,
  updateEvent,
  deleteEvent,
} from '../controllers/eventsController';
import { authMiddleware } from '../../middleware/authMiddleware';

const router = Router();

router.get('/',       getAllEvents);
router.get('/:id',    getEventById);
router.post('/',      authMiddleware, createEvent);
router.patch('/:id',  authMiddleware, updateEvent);
router.delete('/:id', authMiddleware, deleteEvent);

export default router;