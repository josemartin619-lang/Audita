/**
 * Authentication & authorization — real multi-user login.
 *
 * - Passwords are hashed with scrypt (salted, never stored in plaintext).
 * - Sessions are stateless HS256 JWTs, signed with a server secret, with expiry.
 * - Roles gate what each user can do (segregation of duties).
 *
 * No external dependencies: scrypt + HMAC come from node:crypto. In production
 * you would keep the secret in a vault and users in the database; the shapes
 * here are production-correct.
 */

import { createHmac, timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export type Role = 'partner' | 'accountant' | 'staff' | 'viewer';

/** Role hierarchy for permission checks (higher includes lower privileges). */
const RANK: Record<Role, number> = { viewer: 0, staff: 1, accountant: 2, partner: 3 };

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  firmId: string;
  passwordHash: string; // "salt:hash"
}

export interface AuthedRequest extends Request {
  user?: { id: string; email: string; name: string; role: Role; firmId: string };
}

const SECRET = process.env.AUDITA_JWT_SECRET ?? 'dev-secret-change-me';
const TOKEN_TTL_SEC = 60 * 60 * 8; // 8 hours

// ---- password hashing ----
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const test = scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return test.length === known.length && timingSafeEqual(test, known);
}

// ---- minimal HS256 JWT (only HS256 is accepted — no alg-confusion) ----
const b64url = (b: Buffer) => b.toString('base64url');
export function signToken(payload: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + TOKEN_TTL_SEC })));
  const data = `${header}.${body}`;
  const sig = b64url(createHmac('sha256', SECRET).update(data).digest());
  return `${data}.${sig}`;
}
export function verifyToken(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, sig] = parts;
  const expected = b64url(createHmac('sha256', SECRET).update(`${h}.${b}`).digest());
  const a = Buffer.from(sig!);
  const e = Buffer.from(expected);
  if (a.length !== e.length || !timingSafeEqual(a, e)) return null;
  try {
    const body = JSON.parse(Buffer.from(b!, 'base64url').toString());
    if (typeof body.exp === 'number' && Math.floor(Date.now() / 1000) > body.exp) return null;
    return body;
  } catch {
    return null;
  }
}

// ---- user store (seeded; swap for a DB in production) ----
export class UserStore {
  private byEmail = new Map<string, User>();
  private seq = 0;

  add(email: string, name: string, role: Role, password: string, firmId = 'firm-1'): User {
    this.seq += 1;
    const user: User = { id: `U-${this.seq}`, email: email.toLowerCase(), name, role, firmId, passwordHash: hashPassword(password) };
    this.byEmail.set(user.email, user);
    return user;
  }
  find(email: string): User | undefined {
    return this.byEmail.get(email.toLowerCase());
  }
  list(): Array<Omit<User, 'passwordHash'>> {
    return [...this.byEmail.values()].map(({ passwordHash, ...u }) => u);
  }
}

export function seedUsers(): UserStore {
  const s = new UserStore();
  s.add('ana@audita.co', 'Ana Restrepo', 'partner', 'audita');
  s.add('carlos@audita.co', 'Carlos Gómez', 'accountant', 'audita');
  s.add('sofia@audita.co', 'Sofía Ruiz', 'staff', 'audita');
  s.add('cliente@andina.co', 'Andina (cliente)', 'viewer', 'audita');
  return s;
}

// ---- middleware ----
export function authMiddleware(users: UserStore) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    // Public routes: health, login, the third-party verification bundle, static assets.
    const p = req.path;
    if (p === '/health' || p === '/api/auth/login' || p.startsWith('/api/verify/') || !p.startsWith('/api/')) {
      return next();
    }
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const claims = token ? verifyToken(token) : null;
    if (!claims) return res.status(401).json({ error: 'Session invalid or expired — please sign in again.' });
    req.user = {
      id: String(claims.sub),
      email: String(claims.email),
      name: String(claims.name),
      role: claims.role as Role,
      firmId: String(claims.firmId),
    };
    next();
  };
}

/** Guard: require at least the given role. */
export function requireRole(min: Role) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado.' });
    if (RANK[req.user.role] < RANK[min]) {
      return res.status(403).json({ error: `Permiso insuficiente: se requiere rol ${min} o superior.` });
    }
    next();
  };
}

export function hasRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}
