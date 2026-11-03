// Local load check: many rooms playing at the same moment against one server, with
// tiny timers. The server runs in its own process so its memory can be read on its
// own. It measures how this machine copes and nothing more. It says nothing about
// a real VM, a real network or real phones.
//   npm run load                 20 rooms of 8 players
//   npm run load -- 50 12        50 rooms of 12 players
// Per-address rate limits are off in the throwaway server, because every bot shares one address.
import { spawn, execFileSync } from 'node:child_process';
import { Client } from '../test/helpers.js';

const rooms = Number(process.argv[2] ?? 20);
const size = Number(process.argv[3] ?? 8);

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('./load-server.js', import.meta.url).pathname], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => {
    const m = /PORT (\d+)/.exec(String(d));
    if (m) resolve(Number(m[1]));
  });
  child.on('exit', () => reject(new Error('the load server stopped before it was ready')));
});
const base = `http://127.0.0.1:${port}`;
const serverRssMb = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)]).toString().trim()) / 1024;

let peakRss = 0;
const watch = setInterval(() => { peakRss = Math.max(peakRss, serverRssMb()); }, 250);
const all = [];
const trim = setInterval(() => { for (const c of all) { c.raw.length = 0; c.views.length = 0; } }, 500);

const started = Date.now();
const failures = [];

async function playRoom(index) {
  const clients = Array.from({ length: size }, (_, i) => new Client(base, `R${index}P${i + 1}`));
  all.push(...clients);
  await clients[0].create();
  for (const c of clients.slice(1)) {
    const r = await c.join(clients[0].code);
    if (!r.ok) throw new Error(`join failed: ${r.error}`);
  }
  for (const c of clients) await c.connect();
  const begin = Date.now();
  const r = await clients[0].post('/api/start');
  if (!r.ok) throw new Error(`start failed: ${r.error}`);
  await Promise.all(clients.map((c) => c.autoplay()));
  clients.forEach((c) => c.disconnect());
  return { ms: Date.now() - begin };
}

const results = await Promise.allSettled(Array.from({ length: rooms }, (_, i) => playRoom(i + 1)));
clearInterval(watch);
clearInterval(trim);
peakRss = Math.max(peakRss, serverRssMb());
const done = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.ms).sort((a, b) => a - b);
for (const r of results) {
  if (r.status !== 'rejected') continue;
  const cause = r.reason?.cause;
  failures.push(`${r.reason?.message ?? r.reason}${cause ? ` (${cause.code ?? cause.message})` : ''}`);
}

const pct = (p) => done[Math.min(done.length - 1, Math.floor(done.length * p))] ?? 0;
console.log(`${rooms} rooms x ${size} players (${rooms * size} connections) at once`);
console.log(`finished: ${done.length}/${rooms}, failed: ${failures.length}, total time: ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (done.length) console.log(`game time ms: median ${pct(0.5)}, p95 ${pct(0.95)}, max ${done.at(-1)}`);
console.log(`server memory at peak: ${peakRss.toFixed(0)} MB`);
for (const f of new Set(failures)) console.log(`failure: ${f}`);

child.kill('SIGTERM');
process.exit(failures.length ? 1 : 0);
