import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { certificateProvider, parseMetadata } from './metadata-certificates.js';

test('metadata rollover, offline cache, issuer validation and failure retention', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'metadata-test-'));
  for (const name of ['old', 'new']) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, name + '.key'), '-out', join(dir, name + '.pem'), '-days', '2', '-subj', '/CN=' + name], { stdio: 'ignore' });
  const old = readFileSync(join(dir, 'old.pem'), 'utf8'), newer = readFileSync(join(dir, 'new.pem'), 'utf8');
  const tenant = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', issuer = `https://sts.windows.net/${tenant}/`;
  const xml = (certs: string[]) => `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${issuer}"><IDPSSODescriptor>${certs.map(c => `<KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${c.replace(/-----[^\n]+-----|\s/g, '')}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>`).join('')}</IDPSSODescriptor></EntityDescriptor>`;
  const env = { SAML_IDP_ISSUER: issuer, SAML_CERT: old, SAML_METADATA_URL: `https://login.microsoftonline.com/${tenant}/federationmetadata/2007-06/federationmetadata.xml?appid=11111111-2222-3333-4444-555555555555`, SAML_METADATA_CACHE_PATH: join(dir, 'cache.xml') };
  let body = '\uFEFF' + xml([old, newer]), fail = false;
  const fetcher = (async () => { if (fail) throw new Error('offline'); return new Response(body); }) as typeof fetch;
  const provider = certificateProvider(env, fetcher) as ReturnType<typeof certificateProvider> & { refresh: () => Promise<void>; close: () => void };
  const get = (p = provider) => new Promise<string[]>((resolve, reject) => p((error, certs) => error ? reject(error) : resolve(certs!)));
  try {
    assert.equal((await get()).length, 2);
    body = xml([newer]); await provider.refresh(); assert.deepEqual(await get(), [newer]);
    fail = true; await provider.refresh(); assert.deepEqual(await get(), [newer]);
    const cached = certificateProvider({ ...env, SAML_CERT: undefined }, fetcher) as typeof provider;
    try { assert.deepEqual(await get(cached), [newer]); } finally { cached.close(); }
    fail = false; body = xml([old]).replace(issuer, 'wrong'); await provider.refresh(); assert.deepEqual(await get(), [newer]);
    assert.throws(() => parseMetadata('<!DOCTYPE test>' + xml([old]), issuer));
    assert.throws(() => certificateProvider({ ...env, SAML_METADATA_URL: 'https://evil.example/metadata' }, fetcher));
  } finally { provider.close(); rmSync(dir, { recursive: true, force: true }); }
});
