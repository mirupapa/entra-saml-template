import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { loadCertificates } from './certificates.js';

test('certificate rollover removes expired keys, retains valid keys and rejects bad configuration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cert-policy-'));
  const realNow = Date.now;
  try {
    for (const days of [1, 3]) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, days + '.key'), '-out', join(dir, days + '.pem'), '-days', String(days), '-subj', '/CN=Test'], { stdio: 'ignore' });
    const old = readFileSync(join(dir, '1.pem'), 'utf8'), newer = readFileSync(join(dir, '3.pem'), 'utf8');
    const trust = loadCertificates({ SAML_CERT_PATHS: JSON.stringify([join(dir, '1.pem'), join(dir, '3.pem'), join(dir, '1.pem')]) });
    const get = () => new Promise<string[]>((resolve, reject) => trust((error, certs) => error ? reject(error) : resolve(certs!)));
    assert.equal((await get()).length, 2);
    assert.throws(() => loadCertificates({ SAML_CERT_PATHS: '[]' }));
    assert.throws(() => loadCertificates({ SAML_CERT: 'invalid' }));
    const escaped = loadCertificates({ SAML_CERT: newer.replace(/\n/g, '\\n') });
    escaped((error, certs) => { assert.equal(error, null); assert.equal(certs?.length, 1); });
    Date.now = () => Date.parse(new X509Certificate(old).validTo) + 1000;
    assert.equal((await get()).length, 1);
    assert.equal(new X509Certificate((await get())[0]).fingerprint256, new X509Certificate(newer).fingerprint256);
    Date.now = () => Date.parse(new X509Certificate(newer).validTo) + 1000;
    await assert.rejects(get);
    assert.throws(() => loadCertificates({ SAML_CERT: old }));
  } finally { Date.now = realNow; rmSync(dir, { recursive: true, force: true }); }
});
