import { Router } from 'express';
import {
  getAllTeachers,
  getTeacherById,
  updateProfile,
  changePassword,
  deleteTeacher,
} from '../controllers/teachersController';

const router = Router();

router.get('/',                    getAllTeachers);
router.get('/:id',                 getTeacherById);
router.put('/:id',                 updateProfile);
router.put('/:id/change-password', changePassword);
router.delete('/:id',              deleteTeacher);

export default router;
