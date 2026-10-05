import { NextRequest, NextResponse } from 'next/server';
import { auth, cookieName } from '../../../lib/auth';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export function GET(req: NextRequest) { return NextResponse.json(auth().status(req.cookies.get(cookieName)?.value)); }
