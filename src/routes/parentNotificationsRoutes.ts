import { Router } from 'express';
import {
  getParentNotifications,
  markParentNotificationRead,
  markAllParentNotificationsRead,
  saveExpoPushToken,
} from '../controllers/parentNotificationControllers';

const router = Router();

router.get('/',             getParentNotifications);
router.post('/push-token',  saveExpoPushToken);
router.patch('/read-all',   markAllParentNotificationsRead);
router.patch('/:id/read',   markParentNotificationRead);

export default router;
