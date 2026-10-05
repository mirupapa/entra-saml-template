import { SessionNotice } from './SessionNotice';
import { useEffect, useRef, useState } from 'react';
type Role = { appId: string; roleId: string };
type User = { id: string; name: string | null; email: string | null; nameId: string; objectId: string; enabled: number; lastLogin: string; departmentIds: string[]; roles: Role[] };
type Context = { common: boolean; graphEnabled: boolean; csrf: string; apps: { id: string; name: string }[]; departments: { id: string; code: string; name: string }[]; roles: { appId: string; id: string; name: string }[] };
export function Admin() {
  const editDialog = useRef<HTMLDialogElement>(null);
  const [context, setContext] = useState<Context>();
  const [rows, setRows] = useState<User[]>([]);
  const [selected, setSelected] = useState<User>();
  const [query, setQuery] = useState(''); const [offset, setOffset] = useState(0); const [more, setMore] = useState(false);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState({ email: '', name: '', company: '' });
  const [confirmInvite, setConfirmInvite] = useState(false);
  const [invitations, setInvitations] = useState<{ id: string; email: string; name: string; company: string; status: string; loggedIn: number }[]>([]);
  const [code, setCode] = useState(''); const [name, setName] = useState('');
  const [audit, setAudit] = useState<{ id: number; actor: string; targetId: string; action: string; details: string; createdAt: string }[]>([]);
  async function api(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(`/api/admin/${path}`, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': context?.csrf || '' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || '操作に失敗しました。'); return data;
  }
  async function load(q = query, start = offset) {
    const ctx = await api('context'); setContext(ctx);
    const result = await api(`users?q=${encodeURIComponent(q)}&offset=${start}`); setRows(result.users); setMore(result.hasMore); setSelected(undefined);
    if (ctx.common) { setAudit(await api('audit')); setInvitations(await api('invitations')); }
  }
  useEffect(() => { void load('', 0).catch(e => setError(e.message)); }, []);
  const editing = !!selected;
  useEffect(() => {
    if (!editing) return;
    const dialog = editDialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [editing]);
  async function perform(work: () => Promise<void>) {
    setBusy(true); setError(''); setMessage(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : '操作に失敗しました。'); } finally { setBusy(false); }
  }
  return <main className="admin"><p className="eyebrow">SHARED USER DIRECTORY</p><div className="toolbar"><h1>ユーザー管理</h1><a href="/">ログイン情報へ</a></div>
    <p className="intro">初回ログインで登録されたユーザーの部署とアプリ別権限を設定します。</p>
    {context && !selected && <SessionNotice />}{error && <p className="error" role="alert">{error}</p>}{message && <p className="status success" role="status">{message}</p>}
    {!context ? <section><p>{error ? 'ログイン済みの管理者で開いてください。' : '管理権限を確認しています…'}</p><a className="button" href="/auth/login">Entra IDでログイン</a><button onClick={() => void perform(() => load())}>再読み込み</button></section> : <>
      <p className="status">{context.common ? '共通管理者' : `アプリ管理者：${context.apps.map(a => a.name).join('、')}`}</p>
      <section><form className="toolbar" onSubmit={e => { e.preventDefault(); setOffset(0); void perform(() => load(query, 0)); }}><label>ユーザーを検索<input value={query} onChange={e => setQuery(e.target.value)} placeholder="氏名・メール・NameID" /></label><button disabled={busy}>検索</button></form>
      <div className="table-scroll"><table><thead><tr><th>ユーザー</th><th>部署</th><th>アプリ別権限</th><th>利用状態</th><th>操作</th></tr></thead><tbody>{rows.map(u => <tr key={u.id}><td><strong>{u.name || '氏名未設定'}</strong><small>{u.email || u.nameId}</small></td><td>{context.departments.filter(d => u.departmentIds.includes(d.id)).map(d => d.name).join('、') || '未所属'}</td><td>{u.roles.map(r => `${r.appId}: ${context.roles.find(x => x.appId === r.appId && x.id === r.roleId)?.name || r.roleId}`).join('、') || '未付与'}</td><td>{u.enabled ? '有効' : '無効'}</td><td><button disabled={busy} onClick={() => { setSelected(structuredClone(u)); setMessage(''); setError(''); }}>編集</button></td></tr>)}</tbody></table></div>{!rows.length && <p>該当するユーザーはいません。</p>}
      <div className="toolbar"><button disabled={busy || !offset} onClick={() => { const n = Math.max(0, offset - 50); setOffset(n); void perform(() => load(query, n)); }}>前へ</button><span>{offset + 1}件目から表示</span><button disabled={busy || !more} onClick={() => { const n = offset + 50; setOffset(n); void perform(() => load(query, n)); }}>次へ</button></div></section>
      {selected && <dialog ref={editDialog} className="edit-modal" aria-labelledby="edit-user-title" aria-busy={busy} onCancel={e => { e.preventDefault(); if (!busy) setSelected(undefined); }}><section><SessionNotice /><div className="toolbar"><h2 id="edit-user-title">{selected.name || selected.nameId} の設定</h2><button type="button" className="secondary" aria-label="編集画面を閉じる" disabled={busy} onClick={() => setSelected(undefined)}>閉じる</button></div>{error && <p role="alert" className="error">{error}</p>}<p className="note">Object ID: {selected.objectId}<br />最終ログイン: {selected.lastLogin} UTC</p><form onSubmit={e => { e.preventDefault(); void perform(async () => { await api(`users/${selected.id}`, 'PUT', { roles: selected.roles, ...(context.common ? { departmentIds: selected.departmentIds, enabled: !!selected.enabled } : {}) }); await load(); setMessage('ユーザー設定を保存しました。次のAPIアクセスから反映されます。'); }); }}>
        {context.common && <><label className="check"><input type="checkbox" checked={!!selected.enabled} onChange={e => setSelected({ ...selected, enabled: e.target.checked ? 1 : 0 })} />アプリを利用できる状態にする</label><fieldset><legend>所属部署（複数選択可）</legend>{context.departments.map(d => <label className="check" key={d.id}><input type="checkbox" checked={selected.departmentIds.includes(d.id)} onChange={e => setSelected({ ...selected, departmentIds: e.target.checked ? [...selected.departmentIds, d.id] : selected.departmentIds.filter(x => x !== d.id) })} />{d.name}（{d.code}）</label>)}{!context.departments.length && <p>下のフォームから部署を作成してください。</p>}</fieldset></>}
        {context.apps.map(a => <fieldset key={a.id}><legend>{a.name}</legend><p className="note">未選択の場合、このアプリの利用権限はありません。</p>{context.roles.filter(r => r.appId === a.id).map(r => <label className="check" key={r.id}><input type="checkbox" checked={selected.roles.some(x => x.appId === a.id && x.roleId === r.id)} onChange={e => setSelected({ ...selected, roles: e.target.checked ? [...selected.roles, { appId: a.id, roleId: r.id }] : selected.roles.filter(x => !(x.appId === a.id && x.roleId === r.id)) })} />{r.name}</label>)}</fieldset>)}
        <div className="toolbar"><button disabled={busy}>設定を保存</button><button type="button" className="secondary" disabled={busy} onClick={() => setSelected(undefined)}>キャンセル</button></div></form></section></dialog>}
      {context.common && <><section><h2>協力会社ユーザーを招待</h2><p>招待メールを送り、SAMLアプリへ割り当てます。初回ログイン後に部署・アプリ別権限を設定してください。</p>
{!context.graphEnabled ? <p>BackendにGraphの設定が必要です。</p> : <><button disabled={busy} onClick={() => void perform(async () => { const r = await api('graph/status'); setMessage(`Graph接続確認：${r.targetName}。招待・割り当ての書き込み権限は実行時に確認します。`); })}>Graph接続を確認</button>
<form onSubmit={e => { e.preventDefault(); setConfirmInvite(true); }}><div className="toolbar"><label>メールアドレス<input required type="email" maxLength={254} value={invite.email} onChange={e => { setConfirmInvite(false); setInvite({ ...invite, email: e.target.value }); }} /></label><label>氏名<input required maxLength={100} value={invite.name} onChange={e => { setConfirmInvite(false); setInvite({ ...invite, name: e.target.value }); }} /></label><label>所属会社<input required maxLength={100} value={invite.company} onChange={e => { setConfirmInvite(false); setInvite({ ...invite, company: e.target.value }); }} /></label><button disabled={busy}>招待内容を確認</button></div></form>
{confirmInvite && <div><p><strong>{invite.name}（{invite.company}）</strong><br />{invite.email} に招待メールを送り、SAMLアプリへのログインを許可します。業務アプリの権限はまだ付与されません。</p><button disabled={busy} onClick={() => void perform(async () => { try { await api('invitations', 'POST', invite); setInvite({ email: '', name: '', company: '' }); setMessage('招待メール送信・SAMLアプリへの割り当てが完了しました。'); } finally { setConfirmInvite(false); await load(); } })}>招待メールを送信</button><button disabled={busy} className="secondary" onClick={() => setConfirmInvite(false)}>戻る</button></div>}</>}
<h3>招待履歴（直近100件）</h3><div className="table-scroll"><table><thead><tr><th>ユーザー</th><th>所属会社</th><th>状態</th><th>操作</th></tr></thead><tbody>{invitations.map(i => <tr key={i.id}><td>{i.name}<small>{i.email}</small></td><td>{i.company}</td><td>{i.loggedIn ? '初回ログイン済み' : ({ assigned: '招待送信・割り当て済み', assignment_failed: '招待済み・割り当て要確認', sending: '処理中（長時間続く場合はEntraで確認）', unknown: '送信結果不明・Entraで確認' } as Record<string, string>)[i.status]}</td><td>{i.status === 'assignment_failed' && <button disabled={busy} onClick={() => void perform(async () => { await api(`invitations/${i.id}/assign`, 'POST', {}); await load(); setMessage('割り当て完了。招待メールは再送していません。'); })}>割り当てを再試行</button>}</td></tr>)}</tbody></table></div>{!invitations.length && <p>招待履歴はありません。</p>}</section><section><h2>部署を作成</h2><form className="toolbar" onSubmit={e => { e.preventDefault(); void perform(async () => { await api('departments', 'POST', { code, name }); setCode(''); setName(''); await load(); setMessage('部署を作成しました。'); }); }}><label>部署コード<input required maxLength={40} pattern="[A-Za-z0-9_-]+" placeholder="ENG" value={code} onChange={e => setCode(e.target.value)} /></label><label>部署名<input required maxLength={100} placeholder="開発部" value={name} onChange={e => setName(e.target.value)} /></label><button disabled={busy}>作成</button></form></section>
      <section><h2>変更履歴</h2><p className="note">直近100件 / UTC</p>{!audit.length && <p>変更履歴はありません。</p>}{audit.map(a => <details key={a.id}><summary>{a.createdAt} · {a.actor} · {({ 'user.update': 'ユーザー設定変更', 'department.create': '部署作成', 'guest.invite': 'ゲスト招待', 'guest.assign': 'ゲスト割り当て' } as Record<string, string>)[a.action] || a.action}</summary><p className="note">対象ID: {a.targetId}</p><pre>{JSON.stringify(JSON.parse(a.details), null, 2)}</pre></details>)}</section></>}
    </>}
  </main>;
}
