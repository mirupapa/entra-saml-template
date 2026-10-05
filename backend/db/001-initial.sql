CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, name TEXT, email TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS external_identities(
  tenant_id TEXT NOT NULL, object_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  name_id TEXT NOT NULL, last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(tenant_id,object_id), UNIQUE(user_id)
);
CREATE TABLE IF NOT EXISTS departments(
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
  UNIQUE(tenant_id,code)
);
CREATE TABLE IF NOT EXISTS user_departments(
  user_id TEXT NOT NULL REFERENCES users(id), department_id TEXT NOT NULL REFERENCES departments(id),
  PRIMARY KEY(user_id,department_id)
);
CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roles(
  app_id TEXT NOT NULL REFERENCES applications(id), id TEXT NOT NULL, name TEXT NOT NULL,
  PRIMARY KEY(app_id,id)
);
CREATE TABLE IF NOT EXISTS role_permissions(
  app_id TEXT NOT NULL, role_id TEXT NOT NULL, permission TEXT NOT NULL,
  PRIMARY KEY(app_id,role_id,permission),
  FOREIGN KEY(app_id,role_id) REFERENCES roles(app_id,id)
);
CREATE TABLE IF NOT EXISTS user_roles(
  user_id TEXT NOT NULL REFERENCES users(id), app_id TEXT NOT NULL, role_id TEXT NOT NULL,
  PRIMARY KEY(user_id,app_id,role_id),
  FOREIGN KEY(app_id,role_id) REFERENCES roles(app_id,id)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
INSERT OR IGNORE INTO applications VALUES('web-a','Web App A'),('web-b','Web App B'),('mobile','Expo App');
INSERT OR IGNORE INTO roles SELECT id,'viewer','閲覧者' FROM applications;
INSERT OR IGNORE INTO roles SELECT id,'editor','編集者' FROM applications;
INSERT OR IGNORE INTO roles SELECT id,'admin','管理者' FROM applications;
INSERT OR IGNORE INTO role_permissions SELECT app_id,id,'content:read' FROM roles;
INSERT OR IGNORE INTO role_permissions SELECT app_id,id,'content:write' FROM roles WHERE id IN ('editor','admin');
INSERT OR IGNORE INTO role_permissions SELECT app_id,id,'users:manage' FROM roles WHERE id='admin';
INSERT OR IGNORE INTO schema_migrations(version) VALUES(1);
