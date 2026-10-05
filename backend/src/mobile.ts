import { IDLE_MS, ABSOLUTE_MS, nextExpiry } from './session-policy.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import express from 'express';
import type { UserDatabase } from './database.js';
import type { User } from './validation.js';
const random = () => randomBytes(32).toString('hex');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export type MobileLogin = { challenge: string; state: string };
export function createMobileAuth(app: Express, backendOrigin: string, users: UserDatabase) {
  const starts = new Map<string, MobileLogin & { expires: number }>();
  const codes = new Map<string, MobileLogin & { user: User; expires: number }>();
  const sessions = new Map<string, { user: User; expires: number; absolute: number }>();
  const clean = () => {
    for (const map of [starts, codes, sessions]) for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key);
  };
  const timer = setInterval(clean, 30000); timer.unref();
  app.post('/auth/mobile/start', express.json({ limit: '2kb' }), (req, res) => {
    clean();
    if (!valid(req.body?.challenge) || !valid(req.body?.state)) { res.status(400).json({ error: 'invalid_request' }); return; }
    if (starts.size + codes.size + sessions.size >= 1000) { res.status(503).json({ error: 'try_later' }); return; }
    const ticket = random();
    starts.set(digest(ticket), { challenge: req.body.challenge, state: req.body.state, expires: Date.now() + 300000 });
    res.json({ loginUrl: `${backendOrigin}/auth/login?mobile=${ticket}` });
  });
  app.post('/auth/mobile/exchange', express.json({ limit: '2kb' }), (req, res) => {
    clean();
    const { code, verifier } = req.body || {};
    if (!valid(code) || !valid(verifier)) { res.status(400).json({ error: 'invalid_code' }); return; }
    const entry = codes.get(digest(code));
    if (!entry || entry.challenge !== digest(verifier)) { res.status(400).json({ error: 'invalid_code' }); return; }
    codes.delete(digest(code)); // Atomic one-time consumption before creating a session.
    const user = users.lookup(entry.user);
    if (!user) { res.status(403).json({ error: 'account_disabled' }); return; }
    const sessionToken = random();
    const expires = Date.now() + IDLE_MS;
    const absolute = Date.now() + ABSOLUTE_MS;
    sessions.set(digest(sessionToken), { user, expires, absolute });
    res.json({ sessionToken, expiresAt: new Date(expires).toISOString(), absoluteExpiresAt: absolute, user });
  });
  app.get('/api/mobile/me', (req, res) => {
    clean();
    const bearer = req.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const entry = bearer ? sessions.get(digest(bearer)) : undefined;
    const user = entry ? users.lookup(entry.user) : null;
    if (!user) { res.status(401).json({ authenticated: false, user: null }); return; }
    if (req.query.peek !== '1') entry!.expires = nextExpiry(Date.now(), entry!.absolute);
    res.json({ authenticated: true, user, expiresAt: entry!.expires, absoluteExpiresAt: entry!.absolute });
  });
  app.get('/api/mobile/apps/:appId/access', (req, res) => {
    clean();
    const bearer = req.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const entry = bearer ? sessions.get(digest(bearer)) : undefined;
    const user = entry ? users.lookup(entry.user) : null;
    if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
    entry!.expires = nextExpiry(Date.now(), entry!.absolute);
    const permissions = users.permissions(user.id, String(req.params.appId));
    if (!permissions.includes('content:read')) { res.status(403).json({ error: 'forbidden' }); return; }
    res.json({ appId: req.params.appId, permissions });
  });
  app.post('/auth/mobile/logout', (req, res) => {
    const bearer = req.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (bearer) sessions.delete(digest(bearer));
    res.status(204).end();
  });
  return {
    takeStart(ticket: unknown): MobileLogin | undefined {
      clean();
      if (!valid(ticket)) return;
      const key = digest(ticket), value = starts.get(key); starts.delete(key); return value;
    },
    complete(login: MobileLogin, user: User) {
      clean();
      if (codes.size + sessions.size >= 1000) throw new Error('Mobile session capacity reached');
      const code = random();
      codes.set(digest(code), { ...login, user, expires: Date.now() + 60000 });
      // Only this registered redirect is allowed; no client-supplied redirect URL.
      return `samlsample://auth/callback?code=${code}&state=${login.state}`;
    },
  };
}
