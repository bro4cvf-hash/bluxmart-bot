"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoginRateLimiter = exports.SessionStore = void 0;
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.resolveAdminCredentials = resolveAdminCredentials;
exports.saveAdminFile = saveAdminFile;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const DATA_DIR = path_1.default.join(process.cwd(), 'data');
const ADMIN_FILE = path_1.default.join(DATA_DIR, 'admin.json');
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
function hashPassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
        throw new Error('Password must be 8-200 characters.');
    }
    const salt = crypto_1.default.randomBytes(32);
    const hash = crypto_1.default.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
    try {
        const parts = stored.split('$');
        if (parts.length !== 6 || parts[0] !== 'scrypt')
            return false;
        const N = parseInt(parts[1], 10);
        const r = parseInt(parts[2], 10);
        const p = parseInt(parts[3], 10);
        if (![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0))
            return false;
        const salt = Buffer.from(parts[4], 'hex');
        const expected = Buffer.from(parts[5], 'hex');
        if (salt.length < 16 || salt.length > 64 || expected.length !== KEY_LEN)
            return false;
        if (typeof password !== 'string' || password.length === 0 || password.length > 200)
            return false;
        const actual = crypto_1.default.scryptSync(password, salt, KEY_LEN, { N, r, p });
        if (actual.length !== expected.length)
            return false;
        return crypto_1.default.timingSafeEqual(actual, expected);
    }
    catch {
        return false;
    }
}
async function resolveAdminCredentials() {
    const envUser = (process.env.DASHBOARD_USER ?? process.env.ADMIN_USER ?? '').trim();
    const envHash = (process.env.DASHBOARD_PASS_HASH ?? process.env.ADMIN_PASS_HASH ?? '').trim();
    const envPass = (process.env.DASHBOARD_PASS ?? process.env.ADMIN_PASSWORD ?? '');
    if (envUser && envHash) {
        return { username: envUser, passHash: envHash, source: 'env' };
    }
    if (envUser && envPass) {
        // Hash plain env password in-memory only; never persist plain text.
        const salt = crypto_1.default.randomBytes(32);
        const hash = crypto_1.default.scryptSync(envPass, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
        return {
            username: envUser,
            passHash: `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`,
            source: 'env',
        };
    }
    try {
        const raw = await fs_1.promises.readFile(ADMIN_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.username === 'string' && typeof parsed.passHash === 'string' && parsed.username && parsed.passHash) {
            return { username: parsed.username, passHash: parsed.passHash, source: 'file' };
        }
    }
    catch {
        // no file yet
    }
    return null;
}
async function saveAdminFile(username, passHash) {
    await fs_1.promises.mkdir(DATA_DIR, { recursive: true });
    await fs_1.promises.writeFile(ADMIN_FILE, JSON.stringify({ username, passHash, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
}
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
class SessionStore {
    sessions = new Map();
    create(username, ip) {
        this.sweep();
        const token = crypto_1.default.randomBytes(32).toString('hex');
        const csrf = crypto_1.default.randomBytes(32).toString('hex');
        const now = Date.now();
        const s = { token, username, csrf, createdAt: now, expiresAt: now + SESSION_TTL_MS, ip };
        this.sessions.set(token, s);
        return s;
    }
    get(token) {
        if (!token)
            return null;
        const s = this.sessions.get(token);
        if (!s)
            return null;
        if (s.expiresAt < Date.now()) {
            this.sessions.delete(token);
            return null;
        }
        return s;
    }
    refresh(s) {
        s.expiresAt = Date.now() + SESSION_TTL_MS;
    }
    destroy(token) {
        if (!token)
            return;
        this.sessions.delete(token);
    }
    count() {
        this.sweep();
        return this.sessions.size;
    }
    sweep() {
        const now = Date.now();
        for (const [k, v] of this.sessions) {
            if (v.expiresAt < now)
                this.sessions.delete(k);
        }
        // cap memory: keep newest 200
        if (this.sessions.size > 200) {
            const sorted = [...this.sessions.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt);
            this.sessions = new Map(sorted.slice(0, 200));
        }
    }
}
exports.SessionStore = SessionStore;
class LoginRateLimiter {
    hits = new Map();
    maxAttempts = 8;
    windowMs = 10 * 60 * 1000;
    blockMs = 10 * 60 * 1000;
    check(key) {
        const now = Date.now();
        const e = this.hits.get(key);
        if (!e)
            return { allowed: true, retryAfterSec: 0 };
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
    recordFailure(key) {
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
    recordSuccess(key) {
        this.hits.delete(key);
    }
}
exports.LoginRateLimiter = LoginRateLimiter;
