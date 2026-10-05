CREATE TABLE invitations(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL,company TEXT NOT NULL,object_id TEXT,status TEXT NOT NULL CHECK(status IN ('sending','assigned','assignment_failed','unknown')),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(tenant_id,email));
INSERT INTO schema_migrations(version) VALUES(3);
