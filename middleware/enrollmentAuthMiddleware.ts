import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/auth';

export interface EnrollmentRequest extends Request {
  enrollmentAdmin?: { id: number; username: string; role: string };
}

export function enrollmentAuthMiddleware(
  req: EnrollmentRequest,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyToken(token) as any;
    req.enrollmentAdmin = {
      id:       decoded.id,
      username: decoded.username,
      role:     decoded.role,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}