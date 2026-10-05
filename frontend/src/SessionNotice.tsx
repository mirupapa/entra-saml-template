'use client';
import { useEffect, useState } from 'react';
type Status = { authenticated: boolean; expiresAt: number | null; absoluteExpiresAt: number | null };
export function SessionNotice() {
  const [status, setStatus] = useState<Status>(); const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const check = async () => { const r = await fetch('/api/session', { cache: 'no-store', credentials: 'include' }); if (r.ok) setStatus(await r.json()); setNow(Date.now()); };
  useEffect(() => { void check().catch(() => {}); const timer = setInterval(() => void check().catch(() => setNow(Date.now())), 30000); return () => clearInterval(timer); }, []);
  if (!status) return null;
  const expired = !status.authenticated || (status.expiresAt || 0) <= now;
  if (!expired && status.expiresAt! - now > 5 * 60000) return null;
  const absolute = (status.absoluteExpiresAt || 0) - now <= 5 * 60000;
  return <div className="error" role="alert"><p>{expired ? 'セッションが終了しました。入力内容を控えてから再ログインしてください。' : absolute ? 'ログインから8時間の上限が近づいています。作業を保存して再ログインしてください。' : '無操作によるセッション終了まで5分以内です。作業を続ける場合は延長してください。'}</p>{error && <p>{error}</p>}{!expired && !absolute && <button type="button" onClick={() => { void fetch('/api/me', { credentials: 'include', cache: 'no-store' }).then(check).catch(() => setError('通信できません。再試行してください。')); }}>セッションを延長</button>}{(expired || absolute) && <a href="/auth/login">再ログイン</a>}</div>;
}
