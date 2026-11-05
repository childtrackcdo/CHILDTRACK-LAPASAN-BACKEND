import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from '../lib/auth';

export interface ParentAuthRequest extends Request {
  parent?: TokenPayload;
}

export function parentAuthMiddleware(req: ParentAuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized – no token provided' });
    return;
  }
  const token = header.slice(7);
  try {
    req.parent = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized – invalid or expired token' });
  }
}