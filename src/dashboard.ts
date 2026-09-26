import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import type { Client } from 'discord.js';
import { config } from './config';
import { getTemplate, saveTemplate, validateTemplate, DEFAULT_TEMPLATE, type BotTemplate } from './botConfig';
import {
  LoginRateLimiter,
  SessionStore,
  resolveAdminCredentials,
  saveAdminFile,
  verifyPassword,
  hashPassword,
} from './auth';
import { getGuildSetup, saveGuildSetup } from './store';
import { requestTemplateSync } from './lib/guildSync';

let botClient: Client | null = null;
const bootTime = Date.now();

export function setBotClient(c: Client): void {
  botClient = c;
}

function resolvePublicDir(): string {
  const candidates = [
    path.join(process.cwd(), 'dashboard/public'),
    path.join(__dirname, '..', '..', 'dashboard', 'public'),
    path.join(__dirname, '..', 'dashboard', 'public'),
    path.join(__dirname, 'dashboard', 'public'),
  ];
  // Use first candidate; express static falls through if missing.
  // Prefer the cwd one when it exists.
  return candidates[0];
}

function clientIp(req: express.Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim().slice(0, 64);
  return (req.ip ?? req.socket.remoteAddress ?? 'unknown').slice(0, 64);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function maskToken(t: string): string {
  if (!t) return 'not set';
  if (t.length <= 8) return 'set (short)';
  return `set (…${t.slice(-4)})`;
}

async function readAllGuilds(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'data', 'guilds.json'), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function startDashboard(): Promise<void> {
  const enabled = (process.env.DASHBOARD_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[dashboard] disabled via DASHBOARD_ENABLED=false');
    return;
  }
  const port = parseInt(process.env.DASHBOARD_PORT ?? '3001', 10) || 3001;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: false }));

  // Security headers (Apple-clean, no external resources needed)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    next();
  });

  const sessions = new SessionStore();
  const limiter = new LoginRateLimiter();
  const SESSION_COOKIE = 'blux_session';

  const getSession = (req: express.Request) => {
    const cookies = parseCookies(req.headers.cookie);
    return sessions.get(cookies[SESSION_COOKIE]);
  };

  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const s = getSession(req);
    if (!s) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated.' });
      return res.redirect('/login');
    }
    sessions.refresh(s);
    (req as unknown as { session: typeof s }).session = s;
    next();
  };

  const requireCsrf = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const s = (req as unknown as { session?: { csrf: string } }).session;
    const sent = (req.headers['x-csrf-token'] as string | undefined) ?? (req.body as Record<string, unknown>)?.['_csrf'];
    if (!s || typeof sent !== 'string' || sent.length === 0 || sent !== s.csrf) {
      return res.status(403).json({ error: 'Invalid CSRF token. Refresh and try again.' });
    }
    next();
  };

  const publicDir = resolvePublicDir();

  app.get('/login', (req, res) => {
    if (getSession(req)) return res.redirect('/');
    res.sendFile(path.join(publicDir, 'login.html'), (err) => {
      if (err) res.status(500).send('Login page missing. Check dashboard/public/login.html.');
    });
  });

  app.post('/login', async (req, res) => {
    const ip = clientIp(req);
    const body = req.body as { username?: string; password?: string };
    const username = typeof body.username === 'string' ? body.username.trim().slice(0, 64) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const key = `${ip}|${username.toLowerCase()}`;

    const check = limiter.check(key);
    if (!check.allowed) {
      res.setHeader('Retry-After', String(check.retryAfterSec));
      return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(check.retryAfterSec / 60)} min.` });
    }
    if (!username || !password) {
      limiter.recordFailure(key);
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const creds = await resolveAdminCredentials();
    if (!creds) {
      return res.status(503).json({
        error: 'No admin credentials configured. Set DASHBOARD_USER + DASHBOARD_PASS_HASH (run npm run dashboard:hash) or DASHBOARD_PASS.',
      });
    }
    const userOk = crypto_tsafeEqual(username, creds.username);
    const passOk = verifyPassword(password, creds.passHash);
    if (!userOk || !passOk) {
      limiter.recordFailure(key);
      // Small delay to slow brute force without hurting UX
      await new Promise((r) => setTimeout(r, 600));
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    limiter.recordSuccess(key);
    const s = sessions.create(creds.username, ip);
    const isHttps = req.secure || (req.headers['x-forwarded-proto'] as string | undefined)?.includes('https');
    const cookie = [
      `${SESSION_COOKIE}=${encodeURIComponent(s.token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${12 * 60 * 60}`,
      ...(isHttps ? ['Secure'] : []),
    ].join('; ');
    res.setHeader('Set-Cookie', cookie);
    return res.json({ ok: true, csrf: s.csrf });
  });

  app.post('/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    sessions.destroy(cookies[SESSION_COOKIE]);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return res.json({ ok: true });
  });

  // ---- Authenticated API ----
  app.get('/api/me', requireAuth, (req, res) => {
    const s = (req as unknown as { session: { username: string; csrf: string } }).session;
    res.json({ username: s.username, csrf: s.csrf });
  });

  app.get('/api/status', requireAuth, (_req, res) => {
    const guilds = botClient?.guilds.cache.size ?? 0;
    const ping = botClient?.ws.ping ?? -1;
    const ready = !!botClient?.isReady();
    res.json({
      bot: {
        ready,
        tag: botClient?.user?.tag ?? null,
        ping,
        guilds,
        uptimeSec: Math.floor((Date.now() - bootTime) / 1000),
      },
      dashboard: { sessions: sessions.count(), time: new Date().toISOString() },
      env: {
        token: maskToken(config.token),
        clientId: config.clientId ? `set (…${config.clientId.slice(-4)})` : 'not set',
        guildId: config.guildId || 'not set',
        port,
      },
    });
  });

  app.get('/api/guilds', requireAuth, async (_req, res) => {
    const all = await readAllGuilds();
    const list = Object.values(all) as Array<Record<string, unknown>>;
    res.json({
      guilds: list.map((g) => ({
        guildId: g['guildId'],
        roles: Object.keys((g['roles'] as Record<string, string>) ?? {}).length,
        channels: Object.keys((g['channels'] as Record<string, string>) ?? {}).length,
        updatedAt: g['updatedAt'] ?? null,
        liveName: botClient?.guilds.cache.get(g['guildId'] as string)?.name ?? null,
      })),
    });
  });

  app.get('/api/guilds/:id', requireAuth, async (req, res) => {
    const setup = await getGuildSetup(req.params.id).catch(() => null);
    if (!setup) return res.status(404).json({ error: 'Guild not synced yet. Bot auto-syncs on startup — retry in a minute.' });
    res.json({ guild: setup });
  });

  app.put('/api/guilds/:id', requireAuth, requireCsrf, async (req, res) => {
    const setup = await getGuildSetup(req.params.id).catch(() => null);
    if (!setup) return res.status(404).json({ error: 'Guild not found.' });
    const b = req.body as Partial<{ welcomeChannelId: string; logChannelId: string; ticketCategoryId: string; autoRoleId: string }>;
    const channelIds = new Set(Object.values(setup.channels));
    const roleIds = new Set(Object.values(setup.roles));

    const pick = (v: unknown, allowed: Set<string>, label: string, optional = true): string | undefined => {
      if (v === undefined || v === null || v === '') {
        if (optional) return undefined;
        throw new Error(`${label} is required.`);
      }
      if (typeof v !== 'string' || !allowed.has(v)) throw new Error(`${label}: unknown ID for this server.`);
      return v;
    };

    try {
      const welcomeChannelId = pick(b.welcomeChannelId ?? setup.welcomeChannelId, channelIds, 'Welcome channel') ?? setup.welcomeChannelId;
      const logChannelId = pick(b.logChannelId ?? setup.logChannelId, channelIds, 'Log channel') ?? setup.logChannelId;
      const ticketCategoryId = b.ticketCategoryId === undefined || b.ticketCategoryId === '' ? setup.ticketCategoryId : b.ticketCategoryId;
      if (typeof ticketCategoryId !== 'string' || ticketCategoryId.length > 32) throw new Error('Ticket category: invalid ID.');
      const autoRoleId = pick(b.autoRoleId ?? setup.autoRoleId, roleIds, 'Auto-role') ?? setup.autoRoleId;
      const updated = { ...setup, welcomeChannelId, logChannelId, ticketCategoryId, autoRoleId, updatedAt: new Date().toISOString() };
      await saveGuildSetup(updated);
      res.json({ ok: true, guild: updated });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid input.' });
    }
  });

  app.get('/api/template', requireAuth, async (_req, res) => {
    const t = await getTemplate();
    res.json({ template: t });
  });

  app.put('/api/template', requireAuth, requireCsrf, async (req, res) => {
    const t = (req.body as { template?: BotTemplate }).template ?? req.body;
    const v = validateTemplate(t);
    if (!v.ok) return res.status(400).json({ error: v.error });
    await saveTemplate(t as BotTemplate);
    const sync = botClient
      ? await requestTemplateSync(botClient, 'dashboard template save')
      : { queued: true, applied: [], failed: [] };
    res.json({ ok: true, sync });
  });

  app.get('/api/template/defaults', requireAuth, (_req, res) => {
    res.json({ template: DEFAULT_TEMPLATE });
  });

  app.post('/api/change-password', requireAuth, requireCsrf, async (req, res) => {
    const b = req.body as { currentPassword?: string; newUsername?: string; newPassword?: string };
    const creds = await resolveAdminCredentials();
    if (!creds) return res.status(503).json({ error: 'No admin credentials configured.' });
    if (creds.source === 'env') {
      return res.status(400).json({ error: 'Admin login comes from environment variables. Update DASHBOARD_USER / DASHBOARD_PASS_HASH where the bot is hosted.' });
    }
    if (typeof b.currentPassword !== 'string' || !verifyPassword(b.currentPassword, creds.passHash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    const newUsername = typeof b.newUsername === 'string' && b.newUsername.trim() ? b.newUsername.trim().slice(0, 64) : creds.username;
    if (typeof b.newPassword !== 'string' || b.newPassword.length < 10 || b.newPassword.length > 200) {
      return res.status(400).json({ error: 'New password must be 10-200 characters.' });
    }
    try {
      const h = hashPassword(b.newPassword);
      await saveAdminFile(newUsername, h);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : 'Could not update password.' });
    }
  });

  // Auth-gated SPA entry. Must come before static so / never leaks without login.
  app.get('/', requireAuth, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'), (err) => {
      if (err) res.status(500).send('Dashboard page missing. Check dashboard/public/index.html.');
    });
  });

  // Static files (login page needs styles without auth; API + / stay gated).
  // index:false ensures index.html is only served via the auth-gated GET / above.
  app.use(express.static(publicDir, { maxAge: '1h', index: false }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  app.listen(port, () => {
    console.log(`[dashboard] http://localhost:${port} (login with DASHBOARD_USER)`);
  });
}

function crypto_tsafeEqual(a: string, b: string): boolean {
  // Constant-time username compare to avoid leaking which field failed.
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  const len = Math.max(ab.length, bb.length, 1);
  const aPad = Buffer.alloc(len, 0);
  const bPad = Buffer.alloc(len, 0);
  ab.copy(aPad);
  bb.copy(bPad);
  try {
    return crypto.timingSafeEqual(aPad, bPad) && ab.length === bb.length;
  } catch {
    return a === b;
  }
}
