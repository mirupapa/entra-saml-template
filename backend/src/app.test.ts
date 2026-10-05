import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { UserDatabase } from './database.js';
import { loadCertificates } from './certificates.js';
import { createApp } from './app.js';

const dir = mkdtempSync(join(tmpdir(), 'saml-test-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=Test IdP'], { stdio: 'ignore' });
const key = readFileSync(join(dir, 'key.pem'), 'utf8');
const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
rmSync(dir, { recursive: true, force: true });
const rotationDir = mkdtempSync(join(tmpdir(), 'saml-rotation-'));
function pair(name: string) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(rotationDir, name + '.key'), '-out', join(rotationDir, name + '.pem'), '-days', '1', '-subj', '/CN=' + name], { stdio: 'ignore' });
  return { key: readFileSync(join(rotationDir, name + '.key'), 'utf8'), cert: readFileSync(join(rotationDir, name + '.pem'), 'utf8') };
}
const newer = pair('new'), untrusted = pair('untrusted');
const issuer = 'https://sp.example/metadata';
const tenant = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const idp = `https://sts.windows.net/${tenant}/`;
const acs = 'http://localhost:3000/auth/saml/callback';
function signed(xml: string, element: string, signer = { key, cert }) {
  const sig = new SignedXml({ privateKey: signer.key, publicCert: signer.cert, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: `//*[local-name()='${element}']`, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: `//*[local-name()='${element}']/*[local-name()='Issuer']`, action: 'after' } });
  return sig.getSignedXml();
}
function response(id: string, change: Record<string, string | undefined> = {}, signer = { key, cert }) {
  const now = new Date().toISOString();
  const expires = change.expires || new Date(Date.now() + 120000).toISOString();
  const before = change.before || new Date(Date.now() - 10000).toISOString();
  const xml = `<p:Response xmlns:p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:a="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${now}" Destination="${change.destination || acs}" InResponseTo="${change.request || id}"><a:Issuer>${change.idp || idp}</a:Issuer><p:Status><p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></p:Status><a:Assertion ID="_${randomUUID()}" Version="2.0" IssueInstant="${now}"><a:Issuer>${change.idp || idp}</a:Issuer><a:Subject><a:NameID>test-user</a:NameID><a:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><a:SubjectConfirmationData Recipient="${change.recipient || acs}" InResponseTo="${change.request || id}" NotOnOrAfter="${expires}"/></a:SubjectConfirmation></a:Subject><a:Conditions NotBefore="${before}" NotOnOrAfter="${expires}"><a:AudienceRestriction><a:Audience>${change.audience || issuer}</a:Audience></a:AudienceRestriction></a:Conditions><a:AuthnStatement AuthnInstant="${now}" SessionIndex="test"><a:AuthnContext><a:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</a:AuthnContextClassRef></a:AuthnContext></a:AuthnStatement><a:AttributeStatement><a:Attribute Name="email"><a:AttributeValue>test@example.com</a:AttributeValue></a:Attribute><a:Attribute Name="http://schemas.microsoft.com/identity/claims/objectidentifier"><a:AttributeValue>12345678-1234-1234-1234-123456789abc</a:AttributeValue></a:Attribute><a:Attribute Name="http://schemas.microsoft.com/identity/claims/tenantid"><a:AttributeValue>${change.tenant || tenant}</a:AttributeValue></a:Attribute></a:AttributeStatement></a:Assertion></p:Response>`;
  return signed(signed(xml, 'Assertion', signer), 'Response', signer);
}

test('signed SAML login, browser binding, replay rejection, logout and validation failures', async (t) => {
  const users = new UserDatabase(':memory:');
  t.after(() => users.close());
  const app = createApp({ port: 3000, frontendUrl: 'http://localhost:5173', callbackUrl: acs, entryPoint: 'https://idp.example/saml', issuer, idpIssuer: idp, cert: loadCertificates({ SAML_CERT: cert + '\n' + newer.cert }), secret: 's'.repeat(64), secure: false, trustProxy: false }, users);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, redirect: 'manual' });
  const begin = async () => {
    const res = await request('/auth/login'); assert.equal(res.status, 302);
    const url = new URL(res.headers.get('location')!);
    const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString();
    return { id: /ID="([^"]+)"/.exec(xml)![1], state: url.searchParams.get('RelayState')!, cookie: res.headers.get('set-cookie')!.split(';')[0] };
  };
  const callback = (state: string, xml: string) => request('/auth/saml/callback', { method: 'POST', body: new URLSearchParams({ RelayState: state, SAMLResponse: Buffer.from(xml).toString('base64') }) });
  assert.deepEqual(await (await request('/api/me')).json(), { authenticated: false, user: null });
  for (const signer of [newer, untrusted]) {
    const rotate = await begin();
    const result = await callback(rotate.state, response(rotate.id, {}, signer));
    if (signer === newer) assert.equal(result.status, 303);
    else assert.ok(result.headers.get('location')!.includes('error='));
  }
  rmSync(rotationDir, { recursive: true, force: true });
  const tx = await begin();
  const xml = response(tx.id);
  const result = await callback(tx.state, xml); assert.equal(result.status, 303);
  const complete = result.headers.get('location')!; assert.ok(complete.startsWith('/auth/complete'));
  assert.ok((await request(complete)).headers.get('location')!.includes('error='));
  const login = await request(complete, { headers: { Cookie: tx.cookie } });
  assert.equal(login.headers.get('location'), 'http://localhost:5173');
  const cookieHeader = login.headers.get('set-cookie')!;
  assert.match(cookieHeader, /HttpOnly/); assert.match(cookieHeader, /SameSite=Lax/);
  const cookie = cookieHeader.split(';')[0]; assert.notEqual(cookie, tx.cookie);
  const me = await (await request('/api/me', { headers: { Cookie: cookie } })).json();
  assert.equal(me.authenticated, true); assert.equal(me.user.email, 'test@example.com');
  assert.equal(me.user.objectId, '12345678-1234-1234-1234-123456789abc');
  assert.equal(me.user.tenantId, tenant);
  assert.deepEqual(me.user.roles, []);
  assert.equal((await request('/api/apps/web-a/access', { headers: { Cookie: cookie } })).status, 403);
  users.grant(me.user.id, 'web-a', 'viewer');
  assert.equal((await request('/api/apps/web-a/access', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await request('/api/apps/web-b/access', { headers: { Cookie: cookie } })).status, 403);
  users.assignDepartment(me.user.id, tenant, 'ENG', '開発部');
  const deadline = await (await request('/api/session', { headers: { Cookie: cookie } })).json();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 30 * 60000;
    const peek = await (await request('/api/session', { headers: { Cookie: cookie } })).json();
    assert.equal(peek.expiresAt, deadline.expiresAt);
    await request('/api/me', { headers: { Cookie: cookie } });
    const renewed = await (await request('/api/session', { headers: { Cookie: cookie } })).json();
    assert.ok(renewed.expiresAt > deadline.expiresAt);
    assert.equal(renewed.absoluteExpiresAt, deadline.absoluteExpiresAt);
  } finally { Date.now = realNow; }

  assert.ok((await callback(tx.state, xml)).headers.get('location')!.includes('error='));
  assert.equal((await request('/api/admin/context')).status, 401);
  assert.equal((await request('/api/admin/context', { headers: { Cookie: cookie } })).status, 403);
  users.db.prepare('INSERT INTO common_admins VALUES(?)').run(me.user.id);
  const ctx = await (await request('/api/admin/context', { headers: { Cookie: cookie } })).json();
  const headers = { Cookie: cookie, Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'X-CSRF-Token': ctx.csrf };
  const target = users.register({ ...me.user, objectId: '22222222-3333-4444-5555-666666666666', name: 'New user' });
  const foreign = users.register({ ...me.user, tenantId: '11111111-2222-3333-4444-555555555555' });
  const update = { enabled: true, departmentIds: [], roles: [{ appId: 'web-b', roleId: 'viewer' }] };
  assert.equal((await request(`/api/admin/users/${target.id}`, { method: 'PUT', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify(update) })).status, 403);
  assert.equal((await request(`/api/admin/users/${target.id}`, { method: 'PUT', headers: { ...headers, 'X-CSRF-Token': 'wrong' }, body: JSON.stringify(update) })).status, 403);
  assert.equal((await request(`/api/admin/users/${foreign.id}`, { method: 'PUT', headers, body: JSON.stringify(update) })).status, 404);
  assert.equal((await request('/api/admin/departments', { method: 'POST', headers, body: JSON.stringify({ code: 'SALES', name: '営業部' }) })).status, 201);
  const dept = (users.db.prepare("SELECT id FROM departments WHERE code='SALES'").get() as { id: string }).id;
  assert.equal((await request(`/api/admin/users/${target.id}`, { method: 'PUT', headers, body: JSON.stringify({ ...update, departmentIds: [dept] }) })).status, 200);
  assert.deepEqual(users.permissions(target.id, 'web-b'), ['content:read']);
  assert.equal(users.lookup(target)?.departments[0].code, 'SALES');
  assert.equal((await request(`/api/admin/users/${me.user.id}`, { method: 'PUT', headers, body: JSON.stringify({ ...update, enabled: false }) })).status, 409);
  const listed = await (await request('/api/admin/users', { headers: { Cookie: cookie } })).json();
  assert.ok(!listed.users.some((u: { id: string }) => u.id === foreign.id));
  assert.equal((await (await request('/api/admin/audit', { headers: { Cookie: cookie } })).json()).length, 2);
  users.db.prepare('DELETE FROM common_admins WHERE user_id=?').run(me.user.id);
  users.grant(me.user.id, 'web-a', 'admin');
  assert.equal((await request('/api/admin/context', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await request('/api/admin/departments', { method: 'POST', headers, body: JSON.stringify({ code: 'OTHER', name: 'Other' }) })).status, 403);
  assert.equal((await request(`/api/admin/users/${target.id}`, { method: 'PUT', headers, body: JSON.stringify({ roles: [{ appId: 'web-b', roleId: 'admin' }] }) })).status, 400);
  assert.equal((await request(`/api/admin/users/${target.id}`, { method: 'PUT', headers, body: JSON.stringify({ roles: [{ appId: 'web-a', roleId: 'editor' }] }) })).status, 200);
  assert.deepEqual(users.permissions(target.id, 'web-b'), ['content:read']);
  assert.equal((await request(`/api/admin/users/${target.id}`, { method: 'PUT', headers, body: JSON.stringify({ roles: [], enabled: false }) })).status, 403);
  users.db.prepare('DELETE FROM user_roles WHERE user_id=? AND role_id=?').run(me.user.id, 'admin');
  assert.equal((await request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'http://localhost:5173' } })).status, 204);
  assert.equal((await (await request('/api/me', { headers: { Cookie: cookie } })).json()).authenticated, false);
  assert.match(await (await request('/saml/metadata')).text(), /WantAssertionsSigned="true"/);
  // Mobile uses the same validated SAML flow, then a PKCE-bound single-use code.
  const verifier = 'a'.repeat(64), appState = 'b'.repeat(64);
  const challenge = (await import('node:crypto')).createHash('sha256').update(verifier).digest('hex');
  const postJson = (path: string, body: unknown) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const prepare = await postJson('/auth/mobile/start', { challenge, state: appState });
  assert.equal(prepare.status, 200);
  const mobileUrl = new URL((await prepare.json()).loginUrl);
  const mobileStart = await request(mobileUrl.pathname + mobileUrl.search);
  const idpUrl = new URL(mobileStart.headers.get('location')!);
  const mobileCookie = mobileStart.headers.get('set-cookie')!.split(';')[0];
  const mobileXml = inflateRawSync(Buffer.from(idpUrl.searchParams.get('SAMLRequest')!, 'base64')).toString();
  const mobileId = /ID="([^"]+)"/.exec(mobileXml)![1];
  const mobileCallback = await callback(idpUrl.searchParams.get('RelayState')!, response(mobileId));
  const mobileComplete = mobileCallback.headers.get('location')!;
  assert.ok((await request(mobileComplete)).headers.get('location')!.includes('error='));
  const mobileResult = await request(mobileComplete, { headers: { Cookie: mobileCookie } });
  const deepLink = new URL(mobileResult.headers.get('location')!);
  assert.equal(deepLink.protocol, 'samlsample:'); assert.equal(deepLink.searchParams.get('state'), appState);
  const code = deepLink.searchParams.get('code');
  assert.equal((await postJson('/auth/mobile/exchange', { code, verifier: 'c'.repeat(64) })).status, 400);
  const exchange = await postJson('/auth/mobile/exchange', { code, verifier }); assert.equal(exchange.status, 200);
  const mobileSession = await exchange.json();
  assert.equal(mobileSession.user.id, me.user.id);
  assert.equal(mobileSession.user.departments[0].code, 'ENG'); assert.equal(mobileSession.user.objectId, '12345678-1234-1234-1234-123456789abc');
  assert.equal((await postJson('/auth/mobile/exchange', { code, verifier })).status, 400);
  assert.equal((await request('/api/mobile/me')).status, 401);
  const authHeaders = { Authorization: `Bearer ${mobileSession.sessionToken}` };
  assert.equal((await request('/api/mobile/me', { headers: authHeaders })).status, 200);
  assert.equal((await request('/api/mobile/apps/mobile/access', { headers: authHeaders })).status, 403);
  users.grant(me.user.id, 'mobile', 'editor');
  assert.equal((await request('/api/mobile/apps/mobile/access', { headers: authHeaders })).status, 200);
  users.db.prepare('DELETE FROM user_roles WHERE user_id=? AND app_id=?').run(me.user.id, 'mobile');
  assert.equal((await request('/api/mobile/apps/mobile/access', { headers: authHeaders })).status, 403);
  users.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(me.user.id);
  assert.equal((await request('/api/mobile/me', { headers: authHeaders })).status, 401);
  users.db.prepare('UPDATE users SET enabled=1 WHERE id=?').run(me.user.id);
  assert.equal((await request('/auth/mobile/logout', { method: 'POST', headers: authHeaders })).status, 204);
  assert.equal((await request('/api/mobile/me', { headers: authHeaders })).status, 401);
  assert.ok((await request(mobileUrl.pathname + mobileUrl.search)).headers.get('location')!.includes('error='));

  for (const change of [{ tenant: '11111111-2222-3333-4444-555555555555' }, { audience: 'wrong' }, { idp: 'wrong' }, { destination: 'https://evil.example' }, { recipient: 'https://evil.example' }, { request: '_wrong' }, { expires: new Date(Date.now() - 10000).toISOString() }, { before: new Date(Date.now() + 60000).toISOString() }]) {
    const fresh = await begin();
    const res = await callback(fresh.state, response(fresh.id, change));
    assert.ok(res.headers.get('location')!.includes('error='), JSON.stringify(change));
  }
  const fresh = await begin();
  assert.ok((await callback(fresh.state, response(fresh.id).replace('test@example.com', 'attacker@example.com'))).headers.get('location')!.includes('error='));
});
