import { NextRequest, NextResponse } from 'next/server';
import { auth, cookieName } from '../../../lib/auth';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export function GET(req: NextRequest) {
  const service = auth(), user = service.current(req.cookies.get(cookieName)?.value);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const permissions = service.users.permissions(user.id, 'web-b');
  if (!permissions.includes('content:read')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  return NextResponse.json({ appId: 'web-b', permissions });
}
