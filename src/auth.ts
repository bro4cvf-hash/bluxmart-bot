import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'data');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new Error('Password must be 8-200 characters.');
  }
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    if (![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0)) return false;
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    if (salt.length < 16 || salt.length > 64 || expected.length !== KEY_LEN) return false;
    if (typeof password !== 'string' || password.length === 0 || password.length > 200) return false;
    const actual = crypto.scryptSync(password, salt, KEY_LEN, { N, r, p });
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export interface AdminCredentials {
  username: string;
  passHash: string;
  source: 'env' | 'file';
}

export async function resolveAdminCredentials(): Promise<AdminCredentials | null> {
  const envUser = (process.env.DASHBOARD_USER ?? process.env.ADMIN_USER ?? '').trim();
  const envHash = (process.env.DASHBOARD_PASS_HASH ?? process.env.ADMIN_PASS_HASH ?? '').trim();
  const envPass = (process.env.DASHBOARD_PASS ?? process.env.ADMIN_PASSWORD ?? '');

  if (envUser && envHash) {
    return { username: envUser, passHash: envHash, source: 'env' };
  }
  if (envUser && envPass) {
    // Hash plain env password in-memory only; never persist plain text.
    const salt = crypto.randomBytes(32);
    const hash = crypto.scryptSync(envPass, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return {
      username: envUser,
      passHash: `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`,
      source: 'env',
    };
  }
  try {
    const raw = await fs.readFile(ADMIN_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { username?: string; passHash?: string };
    if (typeof parsed.username === 'string' && typeof parsed.passHash === 'string' && parsed.username && parsed.passHash) {
      return { username: parsed.username, passHash: parsed.passHash, source: 'file' };
    }
  } catch {
    // no file yet
  }
  return null;
}

export async function saveAdminFile(username: string, passHash: string): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(ADMIN_FILE, JSON.stringify({ username, passHash, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
}

export interface Session {
  token: string;
  username: string;
  csrf: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class SessionStore {
  private sessions = new Map<string, Session>();

  create(username: string, ip: string): Session {
    this.sweep();
    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const s: Session = { token, username, csrf, createdAt: now, expiresAt: now + SESSION_TTL_MS, ip };
    this.sessions.set(token, s);
    return s;
  }

  get(token: string | undefined | null): Session | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  refresh(s: Session): void {
    s.expiresAt = Date.now() + SESSION_TTL_MS;
  }

  destroy(token: string | undefined | null): void {
    if (!token) return;
    this.sessions.delete(token);
  }

  count(): number {
    this.sweep();
    return this.sessions.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.sessions) {
      if (v.expiresAt < now) this.sessions.delete(k);
    }
    // cap memory: keep newest 200
    if (this.sessions.size > 200) {
      const sorted = [...this.sessions.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt);
      this.sessions = new Map(sorted.slice(0, 200));
    }
  }
}

export class LoginRateLimiter {
  private hits = new Map<string, { count: number; firstAt: number; blockedUntil: number }>();
  private readonly maxAttempts = 8;
  private readonly windowMs = 10 * 60 * 1000;
  private readonly blockMs = 10 * 60 * 1000;

  check(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e) return { allowed: true, retryAfterSec: 0 };
    if (e.blockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((e.blockedUntil - now) / 1000) };
    }
    if (now - e.firstAt > this.windowMs) {
      this.hits.delete(key);
      return { allowed: true, retryAfterSec: 0 };
    }
    if (e.count >= this.maxAttempts) {
      e.blockedUntil = now + this.blockMs;
      return { allowed: false, retryAfterSec: Math.ceil(this.blockMs / 1000) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || now - e.firstAt > this.windowMs) {
      this.hits.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
      return;
    }
    e.count += 1;
    if (e.count >= this.maxAttempts) {
      e.blockedUntil = now + this.blockMs;
    }
  }

  recordSuccess(key: string): void {
    this.hits.delete(key);
  }
}
