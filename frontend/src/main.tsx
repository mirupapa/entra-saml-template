import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { SessionNotice } from './SessionNotice';
import { Admin } from './Admin';
type Me = { authenticated: boolean; user: { id: string; tenantId: string | null; departments: { code: string; name: string }[]; roles: { appId: string; roleId: string; name: string }[]; nameId: string; objectId: string | null; name: string | null; email: string | null } | null };
function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(new URLSearchParams(location.search).has('error') ? '認証に失敗しました。設定を確認し、もう一度ログインしてください。' : '');
  const refresh = async () => {
    try { const res = await fetch('/api/me', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error(); setMe(await res.json());
    } catch { setError('Backendに接続できません。起動状態を確認してください。'); }
  };
  useEffect(() => { void refresh(); if (location.search) history.replaceState(null, '', '/'); }, []);
  const logout = async () => {
    setBusy(true); setError('');
    try { const res = await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error(); await refresh();
    } catch { setError('ログアウトに失敗しました。もう一度お試しください。'); }
    finally { setBusy(false); }
  };
  return <main><p className="eyebrow">MICROSOFT ENTRA ID / SAML 2.0</p><h1>SAML Login Sample</h1>
    <p className="intro">ブラウザで認証し、Backendのセッションでログイン状態を確認します。</p>
    {me?.authenticated && <SessionNotice />}<section aria-busy={busy}><span className={`status ${me?.authenticated ? 'success' : ''}`}>{me?.authenticated ? '認証済み' : '未認証'}</span>
      <h2>{me?.authenticated ? 'Login Success' : 'Entra IDでログイン'}</h2>
      {error && <p role="alert" className="error">{error}</p>}
      {!me ? <><p>接続を確認しています…</p>{error && <button onClick={() => void refresh()}>再試行</button>}</> : me.authenticated && me.user ? <>
        <dl><dt>Name</dt><dd>{me.user.name || 'Claim未設定'}</dd><dt>Email</dt><dd>{me.user.email || 'Claim未設定'}</dd><dt>NameID</dt><dd>{me.user.nameId}</dd><dt>Object ID</dt><dd>{me.user.objectId || 'Claim未設定'}</dd><dt>User ID</dt><dd>{me.user.id}</dd><dt>Tenant ID</dt><dd>{me.user.tenantId}</dd><dt>部署</dt><dd>{me.user.departments?.map(d => d.name).join('、') || '未所属'}</dd><dt>権限</dt><dd>{me.user.roles?.map(r => `${r.appId}: ${r.name}`).join('、') || '未付与'}</dd></dl>
        <p><a href="/admin">ユーザー管理画面へ</a></p>
        <button disabled={busy} onClick={() => void logout()}>{busy ? 'ログアウト中…' : 'ログアウト'}</button>
        <p className="note">このアプリのセッションを終了します。</p>
      </> : <><p>Microsoftの認証画面へ移動します。</p><a className="button" href="/auth/login">Entra IDでログイン <span aria-hidden="true">→</span></a></>}
    </section><aside><h3>認証の流れ</h3><p>React → Backend → Entra ID → Backend ACS → Session → React</p><p>SAML Responseの検証とCookieの発行はBackendが担当します。</p></aside>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode>{location.pathname === '/admin' ? <Admin /> : <App />}</React.StrictMode>);
