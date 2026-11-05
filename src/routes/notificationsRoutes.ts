import { Router } from 'express';
import { authMiddleware } from '../../middleware/authMiddleware';
import {
  getNotifications,
  getNotificationsSummary,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  clearReadNotifications,
  sendTestNotification,
} from '../controllers/notificationsController';

const router = Router();

// All notifications routes require teacher auth
router.use(authMiddleware);

// ── Specific static paths BEFORE dynamic /:id routes ─────────────────────────
router.get   ('/summary',                 getNotificationsSummary);
router.post  ('/test',                    sendTestNotification);
router.get   ('/persistent/unread-count', getUnreadCount);
router.patch ('/persistent/read-all',     markAllNotificationsRead);
router.patch ('/persistent/:id/read',     markNotificationRead);

// ── Root collection ───────────────────────────────────────────────────────────
router.get   ('/', getNotifications);

// ── Single-item delete  (DELETE /api/notifications/:id) ──────────────────────
router.delete('/:id', deleteNotification);

// ── Bulk clear all read (DELETE /api/notifications) ──────────────────────────
router.delete('/', clearReadNotifications);

export default router;