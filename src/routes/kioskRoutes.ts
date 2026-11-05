import { Router, Response, NextFunction } from 'express';
import { verifyToken } from '../../lib/auth';
import { authMiddleware } from '../../middleware/authMiddleware';
import {
  kioskLogin,
  kioskScan,
  kioskGetRecords,
  kioskGetPending,
  kioskConfirm,
  kioskConfirmBulk,
  kioskDismiss,
} from '../controllers/kioskController';
import { kioskSync } from '../../server-patch/kioskSync';
const router = Router();

// ── Kiosk-device auth (role === 'kiosk') ─────────────────────────────────────
// Used by the physical gate scanner — NOT the teacher dashboard.
function kioskAuth(req: any, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No kiosk token provided' });
    return;
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyToken(token) as any;
    if (decoded.role !== 'kiosk') {
      res.status(403).json({ error: 'Not a kiosk token' });
      return;
    }
    req.kioskAdmin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired kiosk token' });
  }
}

// ── Public ────────────────────────────────────────────────────────────────────
// The physical kiosk device logs in with teacher credentials and gets a kiosk-role JWT.
router.post('/login', kioskLogin);

// ── Kiosk-device-authenticated ────────────────────────────────────────────────
// Only the physical scanner calls these — no notifications fired here yet.
router.post('/scan',    kioskAuth, kioskScan, );
router.get ('/records', kioskAuth, kioskGetRecords);
router.post('/sync', kioskAuth, kioskSync);


// ── Teacher-authenticated ─────────────────────────────────────────────────────
// These are what actually create attendance rows AND fire insertNotification().
// The teacher confirms pending scans from the AttendancePage dashboard.
router.get ('/pending',      authMiddleware, kioskGetPending);
router.post('/confirm/:id',  authMiddleware, kioskConfirm);
router.post('/confirm-bulk', authMiddleware, kioskConfirmBulk);
router.post('/dismiss/:id',  authMiddleware, kioskDismiss);

export default router;