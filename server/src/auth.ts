import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { row } from './db.js';

export type Role = 'ADMIN' | 'KITCHEN_STAFF';

export interface StaffUser {
  id: number;
  username: string;
  role: Role;
  org_id: number | null;
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function signToken(user: StaffUser): string {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, org_id: user.org_id },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

export interface AuthRequest extends Request {
  user?: StaffUser;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  // Allow ?token= for EventSource (SSE) connections, which can't set headers.
  if (!token && req.method === 'GET' && typeof req.query.token === 'string') {
    token = req.query.token;
  }
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    const user = row<StaffUser>(
      'SELECT id, username, role, org_id FROM users WHERE id = ?',
      payload.sub
    );
    if (!user) return res.status(401).json({ error: 'Invalid session' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Kitchen staff may move orders through the prep pipeline; admins may do anything
// (the old COUNTER_STAFF role was merged into ADMIN — admins take all orders).
export const PREP_STATUSES = ['RECEIVED', 'PREPARING', 'READY', 'PARTIALLY_COMPLETED', 'COMPLETED'] as const;

export function canSetStatus(role: Role, newStatus: string): boolean {
  if (role === 'ADMIN') return true;
  if (role === 'KITCHEN_STAFF') {
    return (PREP_STATUSES as readonly string[]).includes(newStatus);
  }
  return false;
}
