import { SessionNotice } from '../../frontend/src/SessionNotice';
import { cookies } from 'next/headers';
import { auth, cookieName } from '../lib/auth';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const service = auth(), user = service.current((await cookies()).get(cookieName)?.value);
  const permissions = user ? service.users.permissions(user.id, 'web-b') : [];
  const error = (await searchParams).error;
  return <main><p className="eyebrow">NEXT.JS / ENTRA ID / SAML 2.0</p><h1>Next.js SAML Login</h1><p className="intro">画面・認証・APIをNext.jsで実行。React版・Expo版と共通のユーザーDBを使います。</p>{user && <SessionNotice />}<section>
    <span className={`status ${user ? 'success' : ''}`}>{user ? '認証済み' : '未認証'}</span><h2>{user ? 'Login Success' : 'Entra IDでログイン'}</h2>
    {error && <p className="error" role="alert">認証に失敗しました。Entraの応答URL・署名設定とログインアカウントを確認してください。</p>}
    {user ? <><dl>{[['Name', user.name], ['Email', user.email], ['NameID', user.nameId], ['Object ID', user.objectId], ['User ID', user.id], ['Tenant ID', user.tenantId], ['部署', user.departments.map(d => d.name).join('、') || '未所属'], ['アプリ別権限', user.roles.map(r => `${r.appId}: ${r.name}`).join('、') || '未付与']].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || 'Claim未設定'}</dd></div>)}</dl>
    <p className={permissions.includes('content:read') ? 'allowed' : 'note'}>{permissions.includes('content:read') ? 'Web App Bの利用権限があります。' : 'Web App Bの権限は未付与です。管理者が設定後、このページを再読み込みしてください。'}</p><a href="/api/access">保護APIの結果を確認</a><form action="/auth/logout" method="post"><button>ログアウト</button></form></> : <><p>Microsoftの認証画面へ移動します。</p><a className="button" href="/auth/login">Entra IDでログイン →</a></>}
  </section><aside><h3>認証の流れ</h3><p>Next.js → Entra ID → Next.js ACS → Cookieセッション → SSR / API</p><p>アプリID：web-b。ログインとアプリ利用権限は別に確認します。</p></aside></main>;
}
