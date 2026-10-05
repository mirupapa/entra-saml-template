import { NextRequest, NextResponse } from 'next/server';
import { auth, cookieName, bindingName } from '../../../lib/auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params; const service = auth();
  try {
    if (action === 'login') {
      const start = await service.begin(); const res = NextResponse.redirect(start.url, 302);
      res.cookies.set(bindingName, start.binding, { httpOnly: true, secure: service.secure, sameSite: 'lax', path: '/', maxAge: 300 }); return res;
    }
    if (action === 'complete') {
      const session = service.complete(req.nextUrl.searchParams.get('state') || '', req.cookies.get(bindingName)?.value || '', req.cookies.get(cookieName)?.value);
      const res = NextResponse.redirect(service.origin, 303);
      res.cookies.set(cookieName, session, { httpOnly: true, secure: service.secure, sameSite: 'lax', path: '/', maxAge: 8 * 3600 });
      res.cookies.delete(bindingName); return res;
    }
    if (action === 'metadata') return new NextResponse(service.saml.generateServiceProviderMetadata(null, null), { headers: { 'Content-Type': 'application/xml' } });
    return new NextResponse('Not found', { status: 404 });
  } catch { return NextResponse.redirect(`${service.origin}/?error=authentication_failed`, 303); }
}
export async function POST(req: NextRequest, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params; const service = auth();
  if (action === 'logout') {
    if (req.headers.get('origin') !== service.origin) return new NextResponse('Forbidden', { status: 403 });
    const session = req.cookies.get(cookieName)?.value; if (session) service.logout(session);
    const res = NextResponse.redirect(service.origin, 303); res.cookies.delete(cookieName); res.cookies.delete(bindingName); return res;
  }
  if (action !== 'callback') return new NextResponse('Not found', { status: 404 });
  try {
    if (!req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new Error('Invalid type');
    // Enforce the body limit while reading, including chunked requests.
    const reader = req.body?.getReader(); if (!reader) throw new Error('Missing body');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1048576) { await reader.cancel(); throw new Error('Too large'); } chunks.push(part.value); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (form.getAll('RelayState').length !== 1 || form.getAll('SAMLResponse').length !== 1) throw new Error('Invalid form');
    const state = form.get('RelayState')!; await service.callback(state, form.get('SAMLResponse')!);
    return NextResponse.redirect(`${service.origin}/auth/complete?state=${encodeURIComponent(state)}`, 303);
  } catch { return NextResponse.redirect(`${service.origin}/?error=authentication_failed`, 303); }
}
