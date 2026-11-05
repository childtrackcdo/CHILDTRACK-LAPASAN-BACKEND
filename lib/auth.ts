import jwt from 'jsonwebtoken';

const JWT_SECRET     = process.env.JWT_SECRET     || 'fallback_hs_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

export interface TokenPayload {
  id:       number;
  username: string;
  name?:    string;    // included in JWT so notification bodies can use teacher name
  section?: string;    // advisory section — used as fallback for teacher_id lookup
  role?:    string;    // 'kiosk' | 'teacher' | 'admin'
  lrn?:     string;    // parent tokens carry the linked student's LRN
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}