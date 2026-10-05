import type { NextConfig } from 'next';
const config: NextConfig = { webpack(config) { config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.ts', '.js'] }; return config; }, serverExternalPackages: ['better-sqlite3', '@node-saml/node-saml'], async headers() { return [{ source: '/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }, { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'X-Frame-Options', value: 'DENY' }] }]; } };
export default config;
