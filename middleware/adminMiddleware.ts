// src/middleware/adminMiddleware.ts
import { Response, NextFunction } from 'express';
import { verifyToken } from '../lib/auth';

export function adminMiddleware(req: any, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyToken(token) as any;

    // Must be a super_admin enrollment token
    if (decoded.role !== 'super_admin') {
      res.status(403).json({ error: 'Access denied — super_admin only' });
      return;
    }

    req.adminUser = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}