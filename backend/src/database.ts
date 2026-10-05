import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { User } from './validation.js';
export type Account = User & {
  id: string;
  departments: { id: string; code: string; name: string }[];
  roles: { appId: string; roleId: string; name: string }[];
};
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class UserDatabase {
  readonly db: Database.Database;
  constructor(filename = resolve('data/shared.sqlite'), schemaDirectory?: string) {
    if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    const readSchema = (file: string) => readFileSync(schemaDirectory ? resolve(schemaDirectory, file) : new URL(`../db/${file}`, import.meta.url), 'utf8');
    const schema = readSchema('001-initial.sql');
    this.db.transaction(() => {
      const exists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
      const version = exists ? (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version : null;
      if (version && version > 3) throw new Error('Database schema is newer than this backend');
      if (!version) this.db.exec(schema);
      if (!version || version < 2) this.db.exec(readSchema('002-admin.sql'));
      if (!version || version < 3) this.db.exec(readSchema('003-invitations.sql'));
    })();
  }
  register(identity: User): Account {
    if (!identity.tenantId || !identity.objectId || !guid.test(identity.tenantId) || !guid.test(identity.objectId)) throw new Error('Verified tenant and object ID are required');
    const tenant = identity.tenantId.toLowerCase(), object = identity.objectId.toLowerCase();
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT user_id AS id FROM external_identities WHERE tenant_id=? AND object_id=?').get(tenant, object) as { id: string } | undefined;
      const id = previous?.id || randomUUID();
      if (!previous) {
        this.db.prepare('INSERT INTO users(id,name,email) VALUES(?,?,?)').run(id, identity.name, identity.email);
        this.db.prepare('INSERT INTO external_identities(tenant_id,object_id,user_id,name_id) VALUES(?,?,?,?)').run(tenant, object, id, identity.nameId);
      } else {
        this.db.prepare('UPDATE users SET name=?,email=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(identity.name, identity.email, id);
        this.db.prepare('UPDATE external_identities SET name_id=?,last_login_at=CURRENT_TIMESTAMP WHERE user_id=?').run(identity.nameId, id);
      }
      const account = this.lookup({ ...identity, tenantId: tenant, objectId: object });
      if (!account) throw new Error('Account disabled');
      return account;
    })();
  }
  lookup(identity: User): Account | null {
    if (!identity.tenantId || !identity.objectId) return null;
    const user = this.db.prepare(`SELECT u.id,u.name,u.email,e.name_id AS nameId,e.object_id AS objectId,e.tenant_id AS tenantId
      FROM users u JOIN external_identities e ON e.user_id=u.id WHERE e.tenant_id=? AND e.object_id=? AND u.enabled=1`).get(identity.tenantId.toLowerCase(), identity.objectId.toLowerCase()) as Omit<Account, 'departments' | 'roles'> | undefined;
    if (!user) return null;
    const departments = this.db.prepare(`SELECT d.id,d.code,d.name FROM departments d JOIN user_departments ud ON ud.department_id=d.id WHERE ud.user_id=? ORDER BY d.code`).all(user.id) as Account['departments'];
    const roles = this.db.prepare(`SELECT r.app_id AS appId,r.id AS roleId,r.name FROM roles r JOIN user_roles ur ON ur.app_id=r.app_id AND ur.role_id=r.id WHERE ur.user_id=? ORDER BY r.app_id,r.id`).all(user.id) as Account['roles'];
    return { ...user, departments, roles };
  }
  permissions(userId: string, appId: string): string[] {
    return (this.db.prepare(`SELECT DISTINCT rp.permission FROM role_permissions rp
      JOIN user_roles ur ON ur.app_id=rp.app_id AND ur.role_id=rp.role_id
      JOIN users u ON u.id=ur.user_id WHERE ur.user_id=? AND ur.app_id=? AND u.enabled=1 ORDER BY rp.permission`).all(userId, appId) as { permission: string }[]).map(row => row.permission);
  }
  assignDepartment(userId: string, tenantId: string, code: string, name: string) {
    this.db.transaction(() => {
      const identity = this.db.prepare('SELECT tenant_id FROM external_identities WHERE user_id=?').get(userId) as { tenant_id: string } | undefined;
      if (!identity || identity.tenant_id !== tenantId.toLowerCase()) throw new Error('User/department tenant mismatch');
      this.db.prepare('INSERT INTO departments(id,tenant_id,code,name) VALUES(?,?,?,?) ON CONFLICT(tenant_id,code) DO UPDATE SET name=excluded.name').run(randomUUID(), tenantId.toLowerCase(), code, name);
      this.db.prepare('INSERT OR IGNORE INTO user_departments SELECT ?,id FROM departments WHERE tenant_id=? AND code=?').run(userId, tenantId.toLowerCase(), code);
    })();
  }
  grant(userId: string, appId: string, roleId: string) {
    this.db.prepare('INSERT OR IGNORE INTO user_roles(user_id,app_id,role_id) VALUES(?,?,?)').run(userId, appId, roleId);
  }
  close() { this.db.close(); }
}
