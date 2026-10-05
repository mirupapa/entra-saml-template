import 'dotenv/config';
import { certificateProvider } from './metadata-certificates.js';

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${key} is required`);
    return value;
  };
  const secure = env.COOKIE_SECURE === 'true';
  const frontendUrl = new URL(required('FRONTEND_URL'));
  const callbackUrl = new URL(required('SAML_CALLBACK_URL'));
  const entryPoint = new URL(required('SAML_ENTRY_POINT'));
  for (const url of [frontendUrl, callbackUrl]) {
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))
      throw new Error('HTTPS is required except on localhost');
    if (url.username || url.password || url.search || url.hash) throw new Error('Invalid URL');
  }
  if (frontendUrl.pathname !== '/' || callbackUrl.pathname !== '/auth/saml/callback') throw new Error('Invalid application URL path');
  if (entryPoint.protocol !== 'https:') throw new Error('SAML_ENTRY_POINT must use HTTPS');
  if (callbackUrl.protocol === 'https:' && !secure) throw new Error('HTTPS requires COOKIE_SECURE=true');
  if (secure && callbackUrl.protocol !== 'https:') throw new Error('Secure cookies require HTTPS');
  const secret = required('SESSION_SECRET');
  if (secret.length < 32) throw new Error('SESSION_SECRET must have at least 32 characters');
  const cert = certificateProvider(env);
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return { port, frontendUrl: frontendUrl.origin, callbackUrl: callbackUrl.href,
    entryPoint: entryPoint.href, issuer: required('SAML_ISSUER'), idpIssuer: required('SAML_IDP_ISSUER'),
    cert: cert as string | typeof cert, secret, secure, trustProxy: env.TRUST_PROXY === 'true' };
}
