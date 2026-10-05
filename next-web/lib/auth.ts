import { IDLE_MS, ABSOLUTE_MS, nextExpiry } from '../../backend/src/session-policy';
import { randomBytes, createHash } from 'node:crypto';
import { certificateProvider } from '../../backend/src/metadata-certificates';
import { resolve } from 'node:path';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { UserDatabase } from '../../backend/src/database';
import { validateEnvelope, userFromProfile, type User } from '../../backend/src/validation';
const ttl = 300000;
export const cookieName = 'next.saml.sid';
export const bindingName = 'next.saml.binding';
const token = () => randomBytes(32).toString('hex');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export class NextAuth {
  readonly origin: string;
  readonly callbackUrl: string;
  readonly secure: boolean;
  readonly users: UserDatabase;
  readonly saml: SAML;
  private idp: string;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    const required = (key: string) => { if (!env[key]) throw new Error(`${key} is required`); return env[key]!; };
    const url = new URL(required('NEXT_APP_URL'));
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) throw new Error('Invalid NEXT_APP_URL');
    this.origin = url.origin; this.secure = url.protocol === 'https:'; this.callbackUrl = `${this.origin}/auth/callback`;
    this.idp = required('SAML_IDP_ISSUER');
    const cert = certificateProvider(env);
    const entry = new URL(required('SAML_ENTRY_POINT')); if (entry.protocol !== 'https:') throw new Error('HTTPS IdP required');
    this.users = new UserDatabase(required('DATABASE_PATH'), resolve(env.SHARED_SCHEMA_PATH || '../backend/db'));
    this.users.db.exec(`CREATE TABLE IF NOT EXISTS next_saml_cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS next_saml_transactions(state TEXT PRIMARY KEY,binding TEXT NOT NULL,expires INTEGER NOT NULL,processing INTEGER NOT NULL DEFAULT 0,identity TEXT);
      CREATE TABLE IF NOT EXISTS next_saml_sessions(hash TEXT PRIMARY KEY,identity TEXT NOT NULL,expires INTEGER NOT NULL);`);
    if (!(this.users.db.prepare('PRAGMA table_info(next_saml_sessions)').all() as { name: string }[]).some(c => c.name === 'absolute')) {
      this.users.db.exec('ALTER TABLE next_saml_sessions ADD COLUMN absolute INTEGER');
      // Invalidate sessions created under the old policy rather than guessing login time.
      this.users.db.exec('DELETE FROM next_saml_sessions');
    }
    const db = this.users.db;
    this.saml = new SAML({ entryPoint: entry.href, issuer: required('SAML_ISSUER'), audience: required('SAML_ISSUER'), idpIssuer: this.idp, callbackUrl: this.callbackUrl, idpCert: cert,
      wantAssertionsSigned: true, wantAuthnResponseSigned: true, validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: ttl, acceptedClockSkewMs: 0, maxAssertionAgeMs: ttl, disableRequestedAuthnContext: true, identifierFormat: null,
      signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256', cacheProvider: {
        saveAsync: async (key, value) => { const createdAt = Date.now(); db.prepare('INSERT INTO next_saml_cache VALUES(?,?,?)').run(key, value, createdAt); return { value, createdAt }; },
        getAsync: async key => (db.prepare('SELECT value FROM next_saml_cache WHERE key=? AND created>?').get(key, Date.now() - ttl) as { value: string } | undefined)?.value || null,
        removeAsync: async key => { if (!key) return null; const row = db.prepare('DELETE FROM next_saml_cache WHERE key=? RETURNING value').get(key) as { value: string } | undefined; return row?.value || null; }
      } });
  }
  async begin() {
    const db = this.users.db;
    db.prepare('DELETE FROM next_saml_transactions WHERE expires<=?').run(Date.now());
    db.prepare('DELETE FROM next_saml_sessions WHERE expires<=?').run(Date.now());
    db.prepare('DELETE FROM next_saml_cache WHERE created<=?').run(Date.now() - ttl);
    if ((db.prepare('SELECT COUNT(*) AS count FROM next_saml_transactions').get() as { count: number }).count >= 1000) throw new Error('Too many pending logins');
    const state = token(), binding = token();
    const url = await this.saml.getAuthorizeUrlAsync(state, undefined, {});
    db.prepare('INSERT INTO next_saml_transactions(state,binding,expires) VALUES(?,?,?)').run(state, hash(binding), Date.now() + ttl);
    return { url, binding };
  }
  async callback(state: string, response: string) {
    const db = this.users.db;
    const claim = db.prepare('UPDATE next_saml_transactions SET processing=1 WHERE state=? AND expires>? AND processing=0 RETURNING state').get(state, Date.now());
    if (!claim) throw new Error('Unknown or replayed login');
    try {
      const { profile, loggedOut } = await this.saml.validatePostResponseAsync({ SAMLResponse: response });
      if (!profile || loggedOut) throw new Error('Missing assertion');
      validateEnvelope(Buffer.from(response, 'base64').toString('utf8'), this.callbackUrl, this.idp);
      const identity = userFromProfile(profile);
      if (!identity.tenantId || this.idp.toLowerCase() !== `https://sts.windows.net/${identity.tenantId.toLowerCase()}/`) throw new Error('Tenant mismatch');
      db.prepare('UPDATE next_saml_transactions SET identity=? WHERE state=?').run(JSON.stringify(identity), state);
    } catch (e) { db.prepare('DELETE FROM next_saml_transactions WHERE state=?').run(state); throw e; }
  }
  complete(state: string, binding: string, previous?: string) {
    return this.users.db.transaction(() => {
      const row = this.users.db.prepare('SELECT identity FROM next_saml_transactions WHERE state=? AND binding=? AND expires>? AND identity IS NOT NULL').get(state, hash(binding), Date.now()) as { identity: string } | undefined;
      if (!row) throw new Error('Browser binding mismatch');
      const identity = JSON.parse(row.identity) as User;
      this.users.register(identity);
      this.users.db.prepare('DELETE FROM next_saml_transactions WHERE state=?').run(state);
      if (previous) this.logout(previous);
      const session = token();
      this.users.db.prepare('INSERT INTO next_saml_sessions VALUES(?,?,?,?)').run(hash(session), JSON.stringify(identity), Date.now() + IDLE_MS, Date.now() + ABSOLUTE_MS);
      return session;
    })();
  }
  current(session?: string, renew = true) {
    if (!session || !/^[a-f0-9]{64}$/.test(session)) return null;
    const row = this.users.db.prepare('SELECT identity FROM next_saml_sessions WHERE hash=? AND expires>? AND absolute>?').get(hash(session), Date.now(), Date.now()) as { identity: string } | undefined;
    const user = row ? this.users.lookup(JSON.parse(row.identity)) : null;
    if (user && renew) this.users.db.prepare('UPDATE next_saml_sessions SET expires=min(?,absolute) WHERE hash=?').run(Date.now() + IDLE_MS, hash(session));
    return user;
  }
  status(session?: string) {
    if (!this.current(session, false)) return { authenticated: false, expiresAt: null, absoluteExpiresAt: null };
    const row = this.users.db.prepare('SELECT expires,absolute FROM next_saml_sessions WHERE hash=?').get(hash(session!)) as { expires: number; absolute: number };
    return { authenticated: true, expiresAt: row.expires, absoluteExpiresAt: row.absolute };
  }
  logout(session: string) { this.users.db.prepare('DELETE FROM next_saml_sessions WHERE hash=?').run(hash(session)); }
}
const shared = globalThis as typeof globalThis & { nextSamlAuthV4?: NextAuth };
export function auth() { return shared.nextSamlAuthV4 ||= new NextAuth(); }
