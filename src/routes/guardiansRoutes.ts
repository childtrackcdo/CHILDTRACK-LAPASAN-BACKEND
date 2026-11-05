import { Router } from 'express';
import {
  createGuardian,
  getGuardians,
  getGuardianById,
  updateGuardian,
  deleteGuardian,
} from '../controllers/guardianController';
import { authMiddleware } from '../../middleware/authMiddleware';

const router = Router();

router.get   ('/',    getGuardians);
router.get   ('/:id', getGuardianById);
router.post  ('/',    authMiddleware, createGuardian);
router.patch ('/:id', updateGuardian);
router.delete('/:id', deleteGuardian);

export default router;