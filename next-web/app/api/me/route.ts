import { NextRequest, NextResponse } from 'next/server';
import { auth, cookieName } from '../../../lib/auth';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export function GET(req: NextRequest) { const user = auth().current(req.cookies.get(cookieName)?.value); return NextResponse.json({ authenticated: !!user, user }); }
