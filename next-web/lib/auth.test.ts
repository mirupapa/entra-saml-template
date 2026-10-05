import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { NextAuth } from './auth';


const dir = mkdtempSync(join(tmpdir(), 'saml-test-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=Test IdP'], { stdio: 'ignore' });
const key = readFileSync(join(dir, 'key.pem'), 'utf8');
const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');

const rotationDir = mkdtempSync(join(tmpdir(), 'saml-rotation-'));
function pair(name: string) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(rotationDir, name + '.key'), '-out', join(rotationDir, name + '.pem'), '-days', '1', '-subj', '/CN=' + name], { stdio: 'ignore' });
  return { key: readFileSync(join(rotationDir, name + '.key'), 'utf8'), cert: readFileSync(join(rotationDir, name + '.pem'), 'utf8') };
}
const newer = pair('new'), untrusted = pair('untrusted');
const issuer = 'https://sp.example/metadata';
const tenant = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const idp = `https://sts.windows.net/${tenant}/`;
const acs = 'http://localhost:3100/auth/callback';
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


test('Next.js SAML binding, replay, signatures, shared identity and DB permission changes', async () => {
  const service = new NextAuth({ NODE_ENV: 'test', NEXT_APP_URL: 'http://localhost:3100', SAML_ENTRY_POINT: 'https://idp.example/saml', SAML_ISSUER: issuer, SAML_IDP_ISSUER: idp, SAML_CERT_PATHS: JSON.stringify([join(dir, 'cert.pem'), join(rotationDir, 'new.pem')]), DATABASE_PATH: ':memory:', SHARED_SCHEMA_PATH: join(process.cwd(), '../backend/db') });
  const begin = async () => {
    const start = await service.begin();
    const xml = inflateRawSync(Buffer.from(new URL(start.url).searchParams.get('SAMLRequest')!, 'base64')).toString();
    return { ...start, id: /ID="([^"]+)"/.exec(xml)![1], state: new URL(start.url).searchParams.get('RelayState')! };
  };
  try {
    for (const signer of [newer, untrusted]) {
      const rotate = await begin();
      if (signer === newer) await service.callback(rotate.state, Buffer.from(response(rotate.id, {}, signer)).toString('base64'));
      else await assert.rejects(() => service.callback(rotate.state, Buffer.from(response(rotate.id, {}, signer)).toString('base64')));
    }
    rmSync(rotationDir, { recursive: true, force: true });
    const tx = await begin();
    await service.callback(tx.state, Buffer.from(response(tx.id)).toString('base64'));
    assert.throws(() => service.complete(tx.state, 'wrong'));
    const session = service.complete(tx.state, tx.binding);
    const user = service.current(session)!; assert.ok(user); assert.equal(user.tenantId, tenant);
    assert.throws(() => service.complete(tx.state, tx.binding));
    await assert.rejects(() => service.callback(tx.state, Buffer.from(response(tx.id)).toString('base64')));
    assert.deepEqual(service.users.permissions(user.id, 'web-b'), []);
    service.users.grant(user.id, 'web-b', 'viewer');
    assert.deepEqual(service.users.permissions(user.id, 'web-b'), ['content:read']);
    const again = await begin(); await service.callback(again.state, Buffer.from(response(again.id)).toString('base64'));
    const replacement = service.complete(again.state, again.binding, session);
    assert.equal(service.current(replacement)?.id, user.id); assert.equal(service.current(session), null);
    const initialStatus = service.status(replacement);
    service.users.db.prepare('UPDATE next_saml_sessions SET expires=expires-600000').run();
    const reduced = service.status(replacement).expiresAt!;
    service.status(replacement); assert.equal(service.status(replacement).expiresAt, reduced);
    assert.ok(service.current(replacement)); assert.ok(service.status(replacement).expiresAt! > reduced);
    assert.equal(service.status(replacement).absoluteExpiresAt, initialStatus.absoluteExpiresAt);
    service.users.db.prepare('UPDATE next_saml_sessions SET absolute=?').run(Date.now() - 1);
    assert.equal(service.current(replacement), null);
    service.users.db.prepare('UPDATE next_saml_sessions SET absolute=?,expires=?').run(Date.now() + 100000, Date.now() + 100000);
    service.users.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(user.id); assert.equal(service.current(replacement), null);
    for (const change of [{ audience: 'wrong' }, { destination: 'wrong' }, { recipient: 'wrong' }, { tenant: '11111111-2222-3333-4444-555555555555' }, { request: 'wrong' }, { expires: new Date(Date.now() - 1000).toISOString() }]) {
      const invalid = await begin(); await assert.rejects(() => service.callback(invalid.state, Buffer.from(response(invalid.id, change)).toString('base64')));
    }
    const tamper = await begin(); await assert.rejects(() => service.callback(tamper.state, Buffer.from(response(tamper.id).replace('test@example.com', 'attacker@example.com')).toString('base64')));
  } finally { service.users.close(); rmSync(dir, { recursive: true, force: true }); }
});
