import express from 'express';
import { IDLE_MS, ABSOLUTE_MS, nextExpiry } from './session-policy.js';
import { loadGraph, type GraphClient } from './graph.js';
import { installAdmin } from './admin.js';
import { UserDatabase } from './database.js';
import { createMobileAuth, type MobileLogin } from './mobile.js';
import session from 'express-session';
import helmet from 'helmet';
import { randomBytes, createHash } from 'node:crypto';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import type { loadConfig } from './config.js';
import { validateEnvelope, userFromProfile, type User } from './validation.js';

declare module 'express-session' {
  interface SessionData { user?: User; pending?: string; csrf?: string; expiresAt?: number; absoluteExpiresAt?: number }
}
type Config = ReturnType<typeof loadConfig>;
const ttl = 5 * 60 * 1000;
const token = () => randomBytes(32).toString('hex');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function createApp(config: Config, users = new UserDatabase(process.env.DATABASE_PATH), graph: GraphClient | undefined = loadGraph()) {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(session({ name: 'saml.sid', secret: config.secret, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure: config.secure, sameSite: 'lax', maxAge: 60 * 60 * 1000 } }));
  app.use((req, res, next) => {
    if (req.session.user) {
      const now = Date.now();
      if (!req.session.expiresAt || !req.session.absoluteExpiresAt || req.session.expiresAt <= now || req.session.absoluteExpiresAt <= now) {
        delete req.session.user; delete req.session.csrf;
      } else if (req.path.startsWith('/api/') && req.path !== '/api/session') {
        req.session.expiresAt = nextExpiry(now, req.session.absoluteExpiresAt);
        req.session.cookie.maxAge = req.session.absoluteExpiresAt - now;
      }
    }
    next();
  });
  app.get('/api/session', (req, res) => {
    const user = req.session.user ? users.lookup(req.session.user) : null;
    res.json({ authenticated: !!user, expiresAt: user ? req.session.expiresAt : null, absoluteExpiresAt: user ? req.session.absoluteExpiresAt : null });
  });
  installAdmin(app, users, config.frontendUrl, graph);
  const mobileAuth = createMobileAuth(app, new URL(config.callbackUrl).origin, users);
  const makeSaml = () => new SAML({ entryPoint: config.entryPoint, issuer: config.issuer,
    idpIssuer: config.idpIssuer, callbackUrl: config.callbackUrl, idpCert: config.cert,
    audience: config.issuer, wantAssertionsSigned: true, wantAuthnResponseSigned: true,
    validateInResponseTo: ValidateInResponseTo.always, requestIdExpirationPeriodMs: ttl,
    acceptedClockSkewMs: 0, maxAssertionAgeMs: ttl, disableRequestedAuthnContext: true,
    identifierFormat: null, signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256' });
  const transactions = new Map<string, { expires: number; browser: string; saml: SAML; processing?: boolean; user?: User; mobile?: MobileLogin }>();
  const clean = () => { for (const [key, value] of transactions) if (value.expires <= Date.now()) transactions.delete(key); };
  const timer = setInterval(clean, 30_000); timer.unref();
  const failure = (res: express.Response) => res.redirect(303, `${config.frontendUrl}/?error=authentication_failed`);
  app.get('/auth/login', async (req, res) => {
    clean();
    if (transactions.size >= 1000) { res.status(503).send('Please try again later'); return; }
    if (req.session.pending) transactions.delete(req.session.pending);
    const mobile = req.query.mobile === undefined ? undefined : mobileAuth.takeStart(req.query.mobile);
    if (req.query.mobile !== undefined && !mobile) { failure(res); return; }
    const state = token();
    const saml = makeSaml();
    try {
      console.info('[SAML] Login started');
      const url = await saml.getAuthorizeUrlAsync(state, undefined, {});
      req.session.pending = state;
      transactions.set(state, { expires: Date.now() + ttl, browser: hash(req.sessionID), saml, mobile });
      req.session.save((err) => {
        if (err) { transactions.delete(state); failure(res); return; }
        console.info('[SAML] Redirecting to Entra ID'); res.redirect(url);
      });
    } catch { transactions.delete(state); console.warn('[SAML] Login failed'); failure(res); }
  });
  app.post('/auth/saml/callback', express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 5 }), async (req, res) => {
    console.info('[SAML] Response received');
    clean();
    const state: unknown = req.body?.RelayState;
    const response: unknown = req.body?.SAMLResponse;
    const tx = typeof state === 'string' ? transactions.get(state) : undefined;
    if (!tx || tx.processing || tx.user || typeof response !== 'string') { failure(res); return; }
    tx.processing = true; // Prevent concurrent validation/replay of this transaction.
    try {
      const { profile, loggedOut } = await tx.saml.validatePostResponseAsync({ SAMLResponse: response });
      if (!profile || loggedOut) throw new Error('No authentication assertion');
      validateEnvelope(Buffer.from(response, 'base64').toString('utf8'), config.callbackUrl, config.idpIssuer);
      console.info('[SAML] Assertion validated');
      const identity = userFromProfile(profile);
      if (!identity.tenantId || config.idpIssuer.toLowerCase() !== `https://sts.windows.net/${identity.tenantId.toLowerCase()}/`) throw new Error('Tenant claim does not match verified Issuer');
      tx.user = identity;
      // A top-level GET restores SameSite=Lax cookie access after the cross-site POST.
      res.set('Referrer-Policy', 'no-referrer');
      res.redirect(303, `/auth/complete?state=${encodeURIComponent(String(state))}`);
    } catch {
      transactions.delete(String(state));
      console.warn('[SAML] Authentication rejected'); failure(res);
    }
  });
  app.get('/auth/complete', (req, res) => {
    clean();
    const state = req.query.state;
    const tx = typeof state === 'string' ? transactions.get(state) : undefined;
    if (!tx?.user || req.session.pending !== state || tx.browser !== hash(req.sessionID)) { failure(res); return; }
    transactions.delete(String(state));
    let user: User;
    try { user = users.register(tx.user); }
    catch { console.warn('[DB] User registration rejected'); failure(res); return; }
    if (tx.mobile) {
      try {
        const redirect = mobileAuth.complete(tx.mobile, user);
        delete req.session.pending;
        req.session.save((err) => {
          if (err) { failure(res); return; }
          res.set('Referrer-Policy', 'no-referrer');
          res.redirect(303, redirect);
        });
      } catch { failure(res); }
      return;
    }
    req.session.regenerate((err) => {
      if (err) { failure(res); return; }
      req.session.user = user;
      req.session.absoluteExpiresAt = Date.now() + ABSOLUTE_MS;
      req.session.expiresAt = Date.now() + IDLE_MS;
      req.session.cookie.maxAge = ABSOLUTE_MS;
      req.session.save((err) => {
        if (err) { failure(res); return; }
        console.info('[SAML] User authenticated'); console.info('[SESSION] Session created');
        res.redirect(303, config.frontendUrl);
      });
    });
  });
  app.get('/api/me', (req, res) => {
    const user = req.session.user ? users.lookup(req.session.user) : null;
    res.json(user ? { authenticated: true, user } : { authenticated: false, user: null });
  });
  app.get('/api/apps/:appId/access', (req, res) => {
    const user = req.session.user ? users.lookup(req.session.user) : null;
    if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
    const permissions = users.permissions(user.id, String(req.params.appId));
    if (!permissions.includes('content:read')) { res.status(403).json({ error: 'forbidden' }); return; }
    res.json({ appId: req.params.appId, permissions });
  });
  app.post('/auth/logout', (req, res) => {
    // Browser requests must come from the configured UI; no permissive CORS.
    if (req.get('origin') !== config.frontendUrl) { res.status(403).json({ error: 'forbidden' }); return; }
    if (req.session.pending) transactions.delete(req.session.pending);
    req.session.destroy((err) => {
      if (err) { res.status(500).json({ error: 'logout_failed' }); return; }
      res.clearCookie('saml.sid', { httpOnly: true, sameSite: 'lax', secure: config.secure });
      console.info('[SESSION] Session destroyed'); res.status(204).end();
    });
  });
  app.get('/saml/metadata', (_req, res) => res.type('application/xml').send(makeSaml().generateServiceProviderMetadata(null, null)));
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.warn('[HTTP] Request rejected'); res.status(400).json({ error: 'request_rejected' });
  });
  return app;
}
