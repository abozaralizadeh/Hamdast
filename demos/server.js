// Server for recording the demo video, not for real use.
//   node demos/server.js [seed]
// It starts a throwaway server (temporary database, short timers), seats five bot
// players in a room, prints "JOIN <url>" and waits. When the recorded browser joins
// as the sixth player, the bot host starts the game. The seed makes the dealing and
// the bots' choices repeat, so the same demo can be recorded again after a UI change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server/index.js';
import { seededRng } from '../src/engine/simulate.js';
import { Client, sleep } from '../test/helpers.js';

const seed = Number(process.argv[2] ?? 7);
const port = Number(process.env.DEMO_PORT ?? 3300);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamdast-demo-'));
const config = loadConfig({
  LOG_STDOUT: 'false', MIN_PHASE_MS: '1000', INTRO_MS: '6000', DAY_MS: '24000', VOTE_MS: '14000', NIGHT_MS: '12000',
  DATA_DIR: path.join(dir, 'data'), LOG_DIR: path.join(dir, 'logs'),
});
const app = buildServer(config);
app.limiter.allow = () => true;
app.manager.rng = seededRng(seed);

// The recorder draws its cursor and captions with inline styles, which the app's strict
// content policy blocks on purpose. For this recording server only, allow them. The app
// and its screens are not changed.
const handlers = app.server.listeners('request');
app.server.removeAllListeners('request');
app.server.on('request', (req, res) => {
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (status, headers) => {
    const csp = headers?.['Content-Security-Policy'];
    return writeHead(status, csp ? { ...headers, 'Content-Security-Policy': csp.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'") } : headers);
  };
  for (const handler of handlers) handler.call(app.server, req, res);
});
await new Promise((resolve) => app.server.listen(port, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${port}`;

const names = ['Sara', 'Reza', 'Nima', 'Dana', 'Kian'];
const bots = names.map((n) => new Client(base, n));
await bots[0].create();
for (const b of bots.slice(1)) await b.join(bots[0].code);
for (const b of bots) await b.connect();
console.log(`JOIN ${base}/#/join/${bots[0].code}`);

// Friends talk a little during the first day, so the chat is not empty.
const lines = [
  [1500, 1, 'I was quiet all night, so was everyone.'],
  [5000, 3, 'Reza, you were very calm. Too calm?'],
  [9000, 1, 'Calm is not a crime. Dana, what did you see?'],
];
let spoke = false;
const hostView = () => bots[0].view;
for (;;) {
  if (hostView()?.players.length === 6) break;
  await sleep(100);
}
await sleep(12000); // the recording shows the lobby for a moment
console.log('START');
await bots[0].post('/api/start');
bots.forEach((b, i) => b.autoplay(seededRng(seed * 10 + i)).catch(() => {}));
for (;;) {
  const v = hostView();
  if (v?.game?.phase === 'day' && !spoke) {
    spoke = true;
    for (const [at, who, text] of lines) setTimeout(() => bots[who].post('/api/chat', { channel: 'public', text }), at);
  }
  if (v?.game?.phase === 'over') break;
  await sleep(200);
}

const stop = () => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
await sleep(60000);
stop();
