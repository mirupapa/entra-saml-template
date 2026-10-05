import { X509Certificate } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { loadCertificates } from './certificates.js';

const md = 'urn:oasis:names:tc:SAML:2.0:metadata', ds = 'http://www.w3.org/2000/09/xmldsig#';
export function parseMetadata(xml: string, issuer: string): string[] {
  xml = xml.replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsafe metadata');
  const doc = new DOMParser({ onError: () => { throw new Error('Invalid metadata XML'); } }).parseFromString(xml, 'text/xml');
  const entity = doc.documentElement;
  if (!entity || entity.namespaceURI !== md || entity.localName !== 'EntityDescriptor' || entity.getAttribute('entityID') !== issuer) throw new Error('Metadata issuer mismatch');
  const certs: string[] = [];
  for (const descriptor of Array.from(entity.childNodes)) {
    if (descriptor.nodeType !== 1) continue;
    const idp = descriptor as Element;
    if (idp.namespaceURI !== md || idp.localName !== 'IDPSSODescriptor') continue;
    for (const child of Array.from(idp.childNodes)) {
      if (child.nodeType !== 1) continue;
      const key = child as Element;
      if (key.namespaceURI !== md || key.localName !== 'KeyDescriptor' || (key.getAttribute('use') && key.getAttribute('use') !== 'signing')) continue;
      for (const certificate of Array.from(key.getElementsByTagNameNS(ds, 'X509Certificate'))) {
        const data = (certificate.textContent || '').replace(/\s/g, '');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Invalid metadata certificate');
        certs.push(new X509Certificate(`-----BEGIN CERTIFICATE-----\n${data}\n-----END CERTIFICATE-----`).toString());
      }
    }
  }
  if (!certs.length || certs.length > 20) throw new Error('Invalid metadata signing keys');
  return [...new Set(certs)];
}

export function certificateProvider(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch) {
  if (!env.SAML_METADATA_URL) return loadCertificates(env);
  const url = new URL(env.SAML_METADATA_URL);
  const tenant = /^https:\/\/sts\.windows\.net\/([a-f0-9-]{36})\/$/i.exec(env.SAML_IDP_ISSUER || '')?.[1];
  if (!tenant || url.origin !== 'https://login.microsoftonline.com' || url.pathname.toLowerCase() !== `/${tenant.toLowerCase()}/federationmetadata/2007-06/federationmetadata.xml` || url.username || url.password || url.hash || !/^[a-f0-9-]{36}$/i.test(url.searchParams.get('appid') || '') || [...url.searchParams.keys()].length !== 1) throw new Error('Expected tenant/application-specific Entra metadata URL');
  const interval = Number(env.SAML_METADATA_REFRESH_MS || 86400000);
  if (!Number.isFinite(interval) || interval < 60000 || interval > 86400000) throw new Error('Metadata refresh must be between 1 minute and 24 hours');
  const cache = env.SAML_METADATA_CACHE_PATH;
  let current: ReturnType<typeof loadCertificates> | undefined;
  if (cache) {
    try { current = loadCertificates({ SAML_CERT: parseMetadata(readFileSync(cache, 'utf8'), env.SAML_IDP_ISSUER!).join('\n') }); } catch { /* Fall back to configured bootstrap certificate. */ }
  }
  if (!current) {
    try { current = loadCertificates(env); } catch (error) {
      if (env.SAML_CERT || env.SAML_CERT_PATH || env.SAML_CERT_PATHS) throw error;
    }
  }
  let pending: Promise<void> | undefined, lastAttempt = 0;
  const refresh = () => {
    if (pending) return pending;
    lastAttempt = Date.now();
    pending = (async () => {
      try {
        const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok || !response.body) throw new Error('Metadata HTTP failure');
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 1048576) throw new Error('Metadata too large'); chunks.push(item.value); }
        } finally { await reader.cancel(); }
        const xml = Buffer.concat(chunks).toString('utf8');
        const next = loadCertificates({ SAML_CERT: parseMetadata(xml, env.SAML_IDP_ISSUER!).join('\n') });
        if (cache) {
          try { mkdirSync(dirname(cache), { recursive: true }); const temp = `${cache}.${process.pid}.tmp`; writeFileSync(temp, xml, { mode: 0o600 }); renameSync(temp, cache); }
          catch { console.warn('[SAML] Metadata cache could not be saved'); }
        }
        current = next;
        console.info('[SAML] Metadata certificates refreshed');
      } catch { console.warn('[SAML] Metadata refresh failed; retaining last valid certificate configuration'); }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  // Timers are best effort in serverless environments; verification also checks freshness.
  const timer = setInterval(() => { void refresh(); }, interval); timer.unref();
  void refresh();
  const provider = (callback: (error: Error | null, certs?: string[]) => void) => {
    void (async () => {
      if (pending) await pending;
      else if (Date.now() - lastAttempt >= interval) await refresh();
      if (!current) { callback(new Error('No trusted IdP certificates available')); return; }
      current(callback);
    })().catch(() => callback(new Error('Certificate refresh failed')));
  };
  return Object.assign(provider, { refresh, close: () => clearInterval(timer) });
}
