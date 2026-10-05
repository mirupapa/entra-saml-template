import type { GraphClient } from './graph.js';
import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import type { UserDatabase } from './database.js';
export function installAdmin(app: express.Express, users: UserDatabase, origin: string, graph?: GraphClient) {
  const router = express.Router();
  router.use((req, res, next) => {
    const account = req.session.user ? users.lookup(req.session.user) : null;
    if (!account) { res.status(401).json({ error: 'ログインしてください。' }); return; }
    const common = !!users.db.prepare('SELECT 1 FROM common_admins WHERE user_id=?').get(account.id);
    const apps = (users.db.prepare('SELECT id,name FROM applications ORDER BY id').all() as { id: string; name: string }[]).filter(a => common || users.permissions(account.id, a.id).includes('users:manage'));
    if (!common && !apps.length) { res.status(403).json({ error: '管理権限がありません。' }); return; }
    res.locals.admin = { account, common, apps };
    if (!req.session.csrf) req.session.csrf = randomBytes(32).toString('hex');
    if (req.method !== 'GET' && (req.get('origin') !== origin || req.get('x-csrf-token') !== req.session.csrf)) { res.status(403).json({ error: '画面を再読み込みしてください。' }); return; }
    next();
  });
  router.use(express.json({ limit: '16kb' }));
  router.get('/context', (req, res) => {
    const { account, common, apps } = res.locals.admin;
    const departments = users.db.prepare('SELECT id,code,name FROM departments WHERE tenant_id=? ORDER BY code').all(account.tenantId);
    const roles = users.db.prepare('SELECT app_id AS appId,id,name FROM roles ORDER BY app_id,id').all() as { appId: string }[];
    res.json({ common, graphEnabled: !!graph, apps, departments, roles: roles.filter(r => apps.some((a: { id: string }) => a.id === r.appId)), csrf: req.session.csrf });
  });
  router.get('/users', (req, res) => {
    const { account, apps } = res.locals.admin;
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
    const offset = Math.max(0, Math.min(1000000, Number(req.query.offset) || 0));
    const rows = users.db.prepare(`SELECT u.id,u.name,u.email,u.enabled,e.name_id AS nameId,e.object_id AS objectId,e.last_login_at AS lastLogin FROM users u JOIN external_identities e ON e.user_id=u.id WHERE e.tenant_id=? AND (instr(lower(coalesce(u.name,'')),lower(?))>0 OR instr(lower(e.name_id),lower(?))>0 OR instr(lower(coalesce(u.email,'')),lower(?))>0) ORDER BY u.created_at DESC,u.id LIMIT 51 OFFSET ?`).all(account.tenantId, q, q, q, Math.floor(offset)) as { id: string }[];
    res.json({ hasMore: rows.length > 50, users: rows.slice(0, 50).map(u => ({ ...u,
      departmentIds: (users.db.prepare('SELECT department_id AS id FROM user_departments WHERE user_id=?').all(u.id) as { id: string }[]).map(d => d.id),
      roles: (users.db.prepare('SELECT app_id AS appId,role_id AS roleId FROM user_roles WHERE user_id=?').all(u.id) as { appId: string }[]).filter(r => apps.some((a: { id: string }) => a.id === r.appId)) })) });
  });
  router.post('/departments', (req, res) => {
    const { account, common } = res.locals.admin;
    if (!common) { res.status(403).json({ error: '共通管理者のみ操作できます。' }); return; }
    const { code, name } = req.body || {};
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(code) || typeof name !== 'string' || !name.trim() || name.length > 100) { res.status(400).json({ error: '部署コードと部署名を確認してください。' }); return; }
    if (users.db.prepare('SELECT 1 FROM departments WHERE tenant_id=? AND code=?').get(account.tenantId, code)) { res.status(409).json({ error: '部署コードは登録済みです。' }); return; }
    users.db.transaction(() => {
      const id = randomUUID();
      users.db.prepare('INSERT INTO departments VALUES(?,?,?,?)').run(id, account.tenantId, code, name.trim());
      users.db.prepare('INSERT INTO audit_log(tenant_id,actor_id,target_id,action,details) VALUES(?,?,?,?,?)').run(account.tenantId, account.id, id, 'department.create', JSON.stringify({ code, name: name.trim() }));
    })(); res.status(201).json({ ok: true });
  });
  router.put('/users/:id', (req, res) => {
    const { account, common, apps } = res.locals.admin;
    const id = String(req.params.id);
    if (!users.db.prepare('SELECT 1 FROM external_identities WHERE user_id=? AND tenant_id=?').get(id, account.tenantId)) { res.status(404).json({ error: 'ユーザーが見つかりません。' }); return; }
    const body = req.body || {};
    if (!Array.isArray(body.roles) || body.roles.length > 30 || body.roles.some((r: any) => !r || typeof r.appId !== 'string' || typeof r.roleId !== 'string' || !apps.some((a: { id: string }) => a.id === r.appId) || !users.db.prepare('SELECT 1 FROM roles WHERE app_id=? AND id=?').get(r.appId, r.roleId))) { res.status(400).json({ error: '指定できない権限が含まれています。' }); return; }
    if (!common && ('enabled' in body || 'departmentIds' in body)) { res.status(403).json({ error: '共通管理者のみ操作できます。' }); return; }
    if (common && (typeof body.enabled !== 'boolean' || !Array.isArray(body.departmentIds) || body.departmentIds.length > 50 || body.departmentIds.some((d: unknown) => typeof d !== 'string' || !users.db.prepare('SELECT 1 FROM departments WHERE id=? AND tenant_id=?').get(d, account.tenantId)))) { res.status(400).json({ error: '部署・利用状態を確認してください。' }); return; }
    if (common && !body.enabled && users.db.prepare('SELECT 1 FROM common_admins WHERE user_id=?').get(id)) { res.status(409).json({ error: '共通管理者はこの画面から無効化できません。' }); return; }
    users.db.transaction(() => {
      const before = {
        enabled: (users.db.prepare('SELECT enabled FROM users WHERE id=?').get(id) as { enabled: number }).enabled,
        departments: users.db.prepare('SELECT department_id FROM user_departments WHERE user_id=?').all(id),
        roles: users.db.prepare('SELECT app_id,role_id FROM user_roles WHERE user_id=?').all(id)
      };
      for (const a of apps) users.db.prepare('DELETE FROM user_roles WHERE user_id=? AND app_id=?').run(id, a.id);
      for (const r of body.roles) users.grant(id, r.appId, r.roleId);
      if (common) {
        users.db.prepare('UPDATE users SET enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(body.enabled ? 1 : 0, id);
        users.db.prepare('DELETE FROM user_departments WHERE user_id=?').run(id);
        for (const d of new Set(body.departmentIds)) users.db.prepare('INSERT INTO user_departments VALUES(?,?)').run(id, d);
      }
      users.db.prepare('INSERT INTO audit_log(tenant_id,actor_id,target_id,action,details) VALUES(?,?,?,?,?)').run(account.tenantId, account.id, id, 'user.update', JSON.stringify({ before, after: { roles: body.roles, ...(common ? { enabled: body.enabled, departmentIds: body.departmentIds } : {}) } }));
    })(); res.json({ ok: true });
  });
  router.get('/graph/status', async (_req, res) => {
    const { account, common } = res.locals.admin;
    if (!common) { res.status(403).json({ error: '共通管理者のみ操作できます。' }); return; }
    if (!graph || graph.tenant !== account.tenantId) { res.status(503).json({ error: 'Graphが設定されていません。' }); return; }
    try { const result = await graph.check(); res.json({ ok: true, targetName: result.name }); }
    catch (e) { res.status(502).json({ error: e instanceof Error ? e.message : 'Graph接続に失敗しました。' }); }
  });
  router.get('/invitations', (_req, res) => {
    const { account, common } = res.locals.admin;
    if (!common) { res.status(403).json({ error: '共通管理者のみ閲覧できます。' }); return; }
    res.json(users.db.prepare(`SELECT i.id,i.email,i.name,i.company,i.status,i.object_id AS objectId,i.created_at AS createdAt,EXISTS(SELECT 1 FROM external_identities e WHERE e.tenant_id=i.tenant_id AND e.object_id=i.object_id) AS loggedIn FROM invitations i WHERE i.tenant_id=? ORDER BY i.created_at DESC LIMIT 100`).all(account.tenantId));
  });
  router.post('/invitations', async (req, res) => {
    const { account, common } = res.locals.admin;
    if (!common) { res.status(403).json({ error: '共通管理者のみ操作できます。' }); return; }
    if (!graph || graph.tenant !== account.tenantId) { res.status(503).json({ error: 'Graphが設定されていません。' }); return; }
    const { email, name, company } = req.body || {};
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof name !== 'string' || !name.trim() || name.length > 100 || typeof company !== 'string' || !company.trim() || company.length > 100) { res.status(400).json({ error: 'メール・氏名・所属会社を確認してください。' }); return; }
    const normalized = email.toLowerCase();
    if (users.db.prepare('SELECT 1 FROM invitations WHERE tenant_id=? AND email=?').get(account.tenantId, normalized)) { res.status(409).json({ error: '招待履歴があります。二重送信を避けるため一覧を確認してください。' }); return; }
    const id = randomUUID();
    let objectId: string | undefined;
    try {
      const target = await graph.check();
      // Reserve the address before external side effects; concurrent submissions cannot send twice.
      if (users.db.prepare('SELECT 1 FROM invitations WHERE tenant_id=? AND email=?').get(account.tenantId, normalized)) { res.status(409).json({ error: '招待処理中または招待済みです。' }); return; }
      users.db.prepare('INSERT INTO invitations(id,tenant_id,email,name,company,status) VALUES(?,?,?,?,?,?)').run(id, account.tenantId, normalized, name.trim(), company.trim(), 'sending');
      objectId = await graph.invite(normalized, name.trim());
      users.db.prepare("UPDATE invitations SET object_id=?,status='assignment_failed' WHERE id=?").run(objectId, id);
      await graph.assign(objectId, target.roleId);
      users.db.transaction(() => {
        users.db.prepare("UPDATE invitations SET status='assigned' WHERE id=?").run(id);
        users.db.prepare('INSERT INTO audit_log(tenant_id,actor_id,target_id,action,details) VALUES(?,?,?,?,?)').run(account.tenantId, account.id, objectId, 'guest.invite', JSON.stringify({ email: normalized, company: company.trim() }));
      })();
      res.status(201).json({ ok: true });
    } catch (e) {
      if (!objectId) users.db.prepare("UPDATE invitations SET status='unknown' WHERE id=?").run(id);
      res.status(502).json({ error: `${e instanceof Error ? e.message : 'Graph処理に失敗しました。'} 招待一覧を確認してください。結果不明の場合は再送しないでください。` });
    }
  });
  router.post('/invitations/:id/assign', async (req, res) => {
    const { account, common } = res.locals.admin;
    if (!common) { res.status(403).json({ error: '共通管理者のみ操作できます。' }); return; }
    if (!graph || graph.tenant !== account.tenantId) { res.status(503).json({ error: 'Graphが設定されていません。' }); return; }
    const row = users.db.prepare("SELECT object_id FROM invitations WHERE id=? AND tenant_id=? AND status='assignment_failed'").get(String(req.params.id), account.tenantId) as { object_id: string } | undefined;
    if (!row?.object_id) { res.status(409).json({ error: '再試行できる割り当てはありません。' }); return; }
    try {
      const target = await graph.check(); await graph.assign(row.object_id, target.roleId);
      users.db.transaction(() => {
        users.db.prepare("UPDATE invitations SET status='assigned' WHERE id=?").run(String(req.params.id));
        users.db.prepare('INSERT INTO audit_log(tenant_id,actor_id,target_id,action,details) VALUES(?,?,?,?,?)').run(account.tenantId, account.id, row.object_id, 'guest.assign', '{}');
      })(); res.json({ ok: true });
    } catch (e) { res.status(502).json({ error: e instanceof Error ? e.message : '割り当てに失敗しました。' }); }
  });
  router.get('/audit', (_req, res) => {
    const { account, common } = res.locals.admin;
    if (!common) { res.status(403).json({ error: '共通管理者のみ閲覧できます。' }); return; }
    res.json(users.db.prepare('SELECT l.id,u.name AS actor,l.target_id AS targetId,l.action,l.details,l.created_at AS createdAt FROM audit_log l JOIN users u ON u.id=l.actor_id WHERE l.tenant_id=? ORDER BY l.id DESC LIMIT 100').all(account.tenantId));
  });
  app.use('/api/admin', router);
}
