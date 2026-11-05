import { Router } from 'express';
import {
  parentLogin,
  getParentProfile,
  updateParentProfile,
  changeParentPassword,
} from '../controllers/parentAuthControllers';

const router = Router();

router.post('/login',          parentLogin);
router.get('/:id/profile',     getParentProfile);
router.patch('/:id/profile',   updateParentProfile);
router.patch('/:id/password',  changeParentPassword);

export default router;
