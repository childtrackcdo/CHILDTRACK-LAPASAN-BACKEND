import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from '../lib/auth';

export interface PrincipalRequest extends Request {
  principal?: TokenPayload;
}

export function principalMiddleware(req: PrincipalRequest, res: Response, next: NextFunction): void {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized – no token provided' });
    return;
  }
  const token = header.slice(7);
  try {
    req.principal = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized – invalid or expired token' });
  }
}