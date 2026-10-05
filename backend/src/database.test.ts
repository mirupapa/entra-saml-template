import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { UserDatabase } from './database.js';
const identity = { nameId: 'user@old.example', tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', objectId: '12345678-1234-1234-1234-123456789abc', name: 'Test', email: 'old@example.com' };
test('persistent shared identity, tenant separation, role integrity and disabled accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-db-'));
  const file = join(dir, 'shared.sqlite');
  const db = new UserDatabase(file);
  try {
    const first = db.register(identity);
    const again = db.register({ ...identity, nameId: 'user@new.example', email: 'new@example.com' });
    assert.equal(first.id, again.id);
    assert.equal(again.email, 'new@example.com');
    assert.equal(db.register({ ...identity, tenantId: '11111111-2222-3333-4444-555555555555' }).id === first.id, false);
    assert.throws(() => db.register({ ...identity, objectId: null }));
    assert.throws(() => db.grant(first.id, 'unknown', 'admin'));
    assert.throws(() => db.assignDepartment(first.id, '11111111-2222-3333-4444-555555555555', 'ENG', 'Other tenant'));
    db.assignDepartment(first.id, identity.tenantId, 'ENG', '開発部');
    db.grant(first.id, 'web-a', 'editor');
    assert.deepEqual(db.permissions(first.id, 'web-a'), ['content:read', 'content:write']);
    assert.deepEqual(db.permissions(first.id, 'web-b'), []);
    db.close();
    const reopened = new UserDatabase(file);
    try {
      assert.equal(reopened.lookup(identity)?.id, first.id);
      assert.equal(reopened.lookup(identity)?.departments[0].code, 'ENG');
      assert.equal(reopened.lookup(identity)?.roles[0].appId, 'web-a');
      reopened.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(first.id);
      assert.equal(reopened.lookup(identity), null);
      assert.throws(() => reopened.register(identity));
      assert.deepEqual(reopened.permissions(first.id, 'web-a'), []);
    } finally { reopened.close(); }
  } finally { if (db.db.open) db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('version 1 migration preserves existing users and applies admin schema once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-migration-'));
  const file = join(dir, 'shared.sqlite');
  const initial = new Database(file);
  initial.exec(readFileSync(new URL('../db/001-initial.sql', import.meta.url), 'utf8'));
  initial.prepare('INSERT INTO users(id,name) VALUES(?,?)').run('existing', 'Existing User');
  initial.close();
  try {
    for (let i = 0; i < 2; i++) {
      const migrated = new UserDatabase(file);
      try {
        assert.equal((migrated.db.prepare('SELECT name FROM users WHERE id=?').get('existing') as { name: string }).name, 'Existing User');
        assert.equal((migrated.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version, 3);
        assert.equal(migrated.db.prepare('SELECT * FROM common_admins').all().length, 0);
      } finally { migrated.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
