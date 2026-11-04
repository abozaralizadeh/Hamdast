import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { startServer, lobbyOf } from './helpers.js';
import { openStore } from '../src/server/store.js';

const run = promisify(execFile);
const base = path.resolve(import.meta.dirname, '..');
const node = (script, args = [], env = {}) => run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(base, script), ...args], { env: { PATH: process.env.PATH, ...env } });
const nodeFails = (script, args, env) => node(script, args, env).then(() => assert.fail('expected a failure'), (e) => e);

test('report review tool lists, dismisses and refuses without a token', async () => {
  const s = await startServer({ ADMIN_TOKEN: 'local-test-admin-token' });
  try {
    const [a, b] = await lobbyOf(s.base, 2);
    await a.post('/api/chat', { text: 'something rude' });
    await b.waitFor((v) => v.chat.length === 1);
    await b.post('/api/report', { seatId: a.seatId, reason: 'abuse' });
    const env = { REPORTS_URL: s.base, ADMIN_TOKEN: 'local-test-admin-token' };

    const list = await node('scripts/reports.js', ['list'], env);
    assert.match(list.stdout, /abuse/);
    assert.match(list.stdout, /something rude/);
    const id = list.stdout.match(/^([0-9a-f-]{36})/m)[1];

    const failed = await nodeFails('scripts/reports.js', ['dismiss', 'no-such-id'], env);
    assert.match(failed.stdout, /Failed \(404\)/);
    assert.match((await node('scripts/reports.js', ['dismiss', id], env)).stdout, /Done: dismiss/);
    assert.match((await node('scripts/reports.js', ['list'], env)).stdout, /No open reports/);

    const noToken = await nodeFails('scripts/reports.js', ['list'], { REPORTS_URL: s.base });
    assert.match(noToken.stderr, /ADMIN_TOKEN is not set/);
    a.disconnect();
    b.disconnect();
  } finally {
    await s.stop();
  }
});

test('backup copies the database, the copy opens, and old copies are pruned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamdast-backup-'));
  const store = openStore(path.join(dir, 'hamdast.db'));
  store.addBan('abc');
  store.close();
  const env = { DATA_DIR: dir, BACKUP_KEEP: '2' };
  for (let i = 0; i < 4; i++) {
    await node('scripts/backup.js', [], env);
    await new Promise((r) => setTimeout(r, 15));
  }
  const files = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.db'));
  assert.equal(files.length, 2);
  const copy = new DatabaseSync(path.join(dir, 'backups', files[0]), { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM bans').get().n, 1);
  copy.close();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hamdast-nodb-'));
  assert.match((await node('scripts/backup.js', [], { DATA_DIR: empty })).stdout, /nothing to back up/);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(empty, { recursive: true });
});

test('.env.example lists every setting the code reads, and holds no secret', () => {
  const config = fs.readFileSync(path.join(base, 'src/config.js'), 'utf8');
  const example = fs.readFileSync(path.join(base, '.env.example'), 'utf8');
  const names = new Set([...config.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]));
  assert.ok(names.size > 20);
  for (const name of names) assert.match(example, new RegExp(`^${name}=`, 'm'), `${name} missing from .env.example`);
  assert.match(example, /^ADMIN_TOKEN=$/m, 'admin token must be empty in the example');
  assert.ok(!/(sk-|AKIA|BEGIN [A-Z ]*PRIVATE KEY)/.test(example));
});

test('the project has no npm dependencies to download', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('setup script is valid bash, idempotent in design, and holds no secrets', () => {
  const file = path.join(base, 'setup_service.sh');
  assert.equal(spawnSync('bash', ['-n', file]).status, 0);
  assert.ok(fs.statSync(file).mode & 0o111, 'script is executable');
  const text = fs.readFileSync(file, 'utf8');
  for (const needle of ['journalctl -u hamdast.service', 'systemctl restart', "--exclude '.env'", "--exclude 'data'", 'EnvironmentFile', 'backup.timer']) {
    assert.ok(text.includes(needle), `setup script lacks ${needle}`);
  }
  assert.ok(!/(password|secret|api[_-]?key)\s*=\s*\S+/i.test(text));
});

test('VS Code debug and task files are valid JSON and cover backend and frontend', () => {
  const launch = JSON.parse(fs.readFileSync(path.join(base, '.vscode/launch.json'), 'utf8'));
  const tasks = JSON.parse(fs.readFileSync(path.join(base, '.vscode/tasks.json'), 'utf8'));
  const names = launch.configurations.map((c) => c.name);
  assert.ok(names.some((n) => n.startsWith('Backend')) && names.some((n) => n.startsWith('Frontend')));
  assert.ok(launch.compounds.some((c) => c.configurations.length === 2));
  assert.ok(tasks.tasks.length >= 2);
});

test('the bots script fills a room, so one person can try a game alone', async () => {
  const s = await startServer();
  let child;
  try {
    const [host] = await lobbyOf(s.base, 1);
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(base, 'scripts/bots.js'), host.code, '5'], {
      env: { PATH: process.env.PATH, BOTS_URL: s.base },
      stdio: 'ignore',
    });
    await host.waitFor((v) => v.players.length === 6);
    assert.equal((await host.post('/api/start')).ok, true);
    await host.waitFor((v) => v.game && v.game.phase !== 'over');
    host.disconnect();
  } finally {
    child?.kill();
    await s.stop();
  }
});

test('health check passes against a running server and fails when nothing answers', async () => {
  const s = await startServer();
  try {
    const ok = await node('scripts/healthcheck.js', [], { HEALTH_URL: s.base });
    assert.match(ok.stdout, /^ok in \d+ ms/);
  } finally {
    await s.stop();
  }
  const err = await nodeFails('scripts/healthcheck.js', [], { HEALTH_URL: 'http://127.0.0.1:1' });
  assert.equal(err.code, 1);
  assert.match(err.stderr, /health check failed/);
});

test('the load script plays a few rooms at once and reports no failures', async () => {
  const out = await node('scripts/load.js', ['3', '6']);
  assert.match(out.stdout, /3 rooms x 6 players/);
  assert.match(out.stdout, /finished: 3\/3, failed: 0/);
});

test('setup_service.sh installs the health check timer next to the backup timer', () => {
  const sh = fs.readFileSync(path.join(base, 'setup_service.sh'), 'utf8');
  assert.match(sh, /-health\.timer/);
  assert.match(sh, /scripts\/healthcheck\.js/);
});
