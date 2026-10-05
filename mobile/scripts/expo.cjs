const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');

function supported(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return (major === 22 && minor >= 13) || (major === 24 && minor >= 3) || major >= 25;
}
const bundledNode = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node');
let executable = process.execPath;
if (!supported(process.version)) {
  if (existsSync(bundledNode)) {
    const result = spawnSync(bundledNode, ['--version'], { encoding: 'utf8' });
    if (result.status === 0 && supported(result.stdout.trim())) {
      executable = bundledNode;
      console.info(`[Expo] Using Node ${result.stdout.trim()} bundled with Codex`);
    }
  }
  if (executable === process.execPath) {
    console.error('[Expo] Node 22.13+ or Node 24.3+ is required. Update Node.js and try again.');
    process.exit(1);
  }
}
const project = path.resolve(__dirname, '..');
const cli = path.join(project, 'node_modules/expo/bin/cli');
// Native build subprocesses must also find the selected Node executable.
const result = spawnSync(executable, [cli, ...process.argv.slice(2)], {
  cwd: project,
  stdio: 'inherit',
  env: { ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH || ''}` },
});
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
