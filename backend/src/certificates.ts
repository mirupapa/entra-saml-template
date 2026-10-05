import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

// Only explicitly configured certificates are trusted; never trust response KeyInfo.
export function loadCertificates(env: Record<string, string | undefined>) {
  let sources: string[];
  if (env.SAML_CERT_PATHS) {
    const paths: unknown = JSON.parse(env.SAML_CERT_PATHS);
    if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !p.trim()))
      throw new Error('SAML_CERT_PATHS must be a nonempty JSON array of file paths');
    sources = paths.map(p => readFileSync(p, 'utf8'));
  } else if (env.SAML_CERT) {
    sources = [env.SAML_CERT.replace(/\\n/g, '\n')];
  } else {
    if (!env.SAML_CERT_PATH) throw new Error('SAML_CERT_PATH is required');
    sources = [readFileSync(env.SAML_CERT_PATH, 'utf8')];
  }
  const certificates = sources.flatMap(source => {
    const blocks = source.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!blocks?.length || source.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim())
      throw new Error('Expected PEM certificate(s)');
    return blocks.map(pem => new X509Certificate(pem));
  });
  const unique = [...new Map(certificates.map(c => [c.fingerprint256, c])).values()];
  const active = () => {
    const now = Date.now();
    const valid = unique.filter(c => now >= Date.parse(c.validFrom) && now < Date.parse(c.validTo));
    if (!valid.length) throw new Error('No IdP certificate is within its validity period');
    return valid.map(c => c.toString());
  };
  active();
  // Recheck validity on each verification so an expired old certificate is dropped.
  return (callback: (error: Error | null, certs?: string[]) => void) => {
    let certs: string[];
    try { certs = active(); } catch (error) { callback(error as Error); return; }
    callback(null, certs);
  };
}
