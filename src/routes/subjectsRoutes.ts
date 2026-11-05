import { Router } from 'express';
import {
  getSubjects,
  getSubjectById,
  createSubject,
  updateSubject,
  deleteSubject,
  getPublicSubjectList,
  getSubjectStats,
} from '../controllers/subjectsController';
import { authMiddleware } from '../../middleware/authMiddleware';

const router = Router();

router.get('/public',   getPublicSubjectList);
router.get('/stats',    authMiddleware, getSubjectStats);

router.get('/',         authMiddleware, getSubjects);
router.get('/:id',      authMiddleware, getSubjectById);
router.post('/',        authMiddleware, createSubject);
router.patch('/:id',    authMiddleware, updateSubject);
router.delete('/:id',   authMiddleware, deleteSubject);

export default router;