// src/middleware/studentAuth.ts
//
// Verifies the student JWT sent by the mobile app (Authorization: Bearer <token>)
// and attaches the decoded payload to req.student.

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// ⚠️ Must be the SAME secret your student login route uses to sign tokens.
const JWT_SECRET = process.env.JWT_SECRET as string;

export interface StudentTokenPayload {
  id?: number | string;
  lrn?: string;
  name?: string;
  role?: string;
  [key: string]: unknown;
}

export function authenticateStudent(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    res.status(401).json({ error: 'Missing student token' });
    return;
  }

  if (!JWT_SECRET) {
    console.error('[studentAuth] JWT_SECRET is not set');
    res.status(500).json({ error: 'Server auth is not configured' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as StudentTokenPayload;

    // Reject tokens that clearly belong to another role (parent, teacher, admin).
    if (payload.role && String(payload.role).toLowerCase() !== 'student') {
      res.status(403).json({ error: 'Students only' });
      return;
    }

    if (payload.id == null && !payload.lrn) {
      res.status(401).json({ error: 'Invalid student token' });
      return;
    }

    (req as any).student = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}