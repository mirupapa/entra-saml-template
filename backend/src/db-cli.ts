import 'dotenv/config';
import { UserDatabase } from './database.js';
const users = new UserDatabase(process.env.DATABASE_PATH);
const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case 'common-admin': {
      const id = args[0];
      if (!id) throw new Error('common-admin <user-id>');
      users.db.prepare('INSERT OR IGNORE INTO common_admins(user_id) VALUES(?)').run(id);
      console.log('Common administrator assigned'); break;
    }
    case 'init': console.log('Shared database initialized'); break;
    case 'users': console.table(users.db.prepare(`SELECT u.id,u.name,u.email,u.enabled,e.tenant_id,e.object_id FROM users u JOIN external_identities e ON e.user_id=u.id`).all()); break;
    case 'department': {
      const [id, tenant, code, name] = args;
      if (!id || !tenant || !code || !name) throw new Error('department <user-id> <tenant-id> <department-code> <department-name>');
      users.assignDepartment(id, tenant, code, name); console.log('Department assigned'); break;
    }
    case 'grant': {
      const [id, app, role] = args;
      if (!id || !app || !role) throw new Error('grant <user-id> <app-id> <viewer|editor|admin>');
      users.grant(id, app, role); console.log('Role assigned'); break;
    }
    case 'revoke': {
      const [id, app, role] = args;
      if (!id || !app || !role) throw new Error('revoke <user-id> <app-id> <role>');
      users.db.prepare('DELETE FROM user_roles WHERE user_id=? AND app_id=? AND role_id=?').run(id, app, role); console.log('Role revoked'); break;
    }
    case 'unassign-department': {
      const [id, department] = args;
      if (!id || !department) throw new Error('unassign-department <user-id> <department-id>');
      users.db.prepare('DELETE FROM user_departments WHERE user_id=? AND department_id=?').run(id, department); console.log('Department unassigned'); break;
    }
    case 'disable': case 'enable': {
      if (!args[0]) throw new Error(`${command} <user-id>`);
      const result = users.db.prepare('UPDATE users SET enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(command === 'enable' ? 1 : 0, args[0]);
      if (!result.changes) throw new Error('User not found'); console.log('Account status updated'); break;
    }
    default: throw new Error('Commands: init, users, department, unassign-department, grant, revoke, disable, enable');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Database operation failed'); process.exitCode = 1;
} finally { users.close(); }
