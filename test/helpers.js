// Test helpers: a throwaway server with tiny timers, and a client that talks to
// it the same way the browser does (JSON posts plus the live stream).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server/index.js';

export function testConfig(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mafianight-test-'));
  const config = loadConfig({
    LOG_STDOUT: 'false',
    MIN_PHASE_MS: '1',
    INTRO_MS: '30',
    DAY_MS: '3000',
    VOTE_MS: '3000',
    NIGHT_MS: '120',
    DATA_DIR: path.join(dir, 'data'),
    LOG_DIR: path.join(dir, 'logs'),
    ...extra,
  });
  return { config, dir };
}

export async function startServer(extra = {}) {
  const { config, dir } = testConfig(extra);
  const app = buildServer(config);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    ...app,
    base,
    dir,
    async stop() {
      app.manager.shutdown();
      app.server.closeAllConnections?.();
      await new Promise((resolve) => app.server.close(resolve));
      app.store.close();
      app.logger.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Client {
  constructor(base, name) {
    this.base = base;
    this.name = name;
    this.views = [];
    this.raw = [];
    this.view = null;
  }

  async post(url, body = {}, token = this.token) {
    const res = await fetch(this.base + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, ...(await res.json()) };
  }

  async create() {
    const r = await this.post('/api/rooms', { nickname: this.name, confirmed: true });
    Object.assign(this, { token: r.token, seatId: r.seatId, code: r.code });
    return r;
  }

  async join(code, extra = {}) {
    const r = await this.post(`/api/rooms/${code}/join`, { nickname: this.name, confirmed: true, ...extra }, null);
    if (r.ok) Object.assign(this, { token: r.token, seatId: r.seatId, code: r.code });
    return r;
  }

  async connect() {
    this.abort = new AbortController();
    const res = await fetch(this.base + '/api/stream', { headers: { authorization: `Bearer ${this.token}` }, signal: this.abort.signal });
    if (res.status !== 200) return res.status;
    this.reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const data = block.split('\n').find((l) => l.startsWith('data: '));
            if (block.includes('event: view') && data) {
              this.raw.push(data.slice(6));
              this.view = JSON.parse(data.slice(6));
              this.views.push(this.view);
            }
          }
        }
      } catch {
        // aborted
      }
    })();
    await this.waitFor(() => this.view);
    return 200;
  }

  disconnect() {
    this.abort?.abort();
  }

  async waitFor(predicate, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const out = predicate(this.view);
      if (out) return out;
      await sleep(5);
    }
    throw new Error(`${this.name}: timed out. Last phase: ${this.view?.game?.phase}`);
  }

  // Plays whatever the view says is possible, at random.
  async autoplay(rng = Math.random) {
    let lastKey = '';
    while (this.view?.game?.phase !== 'over') {
      const v = this.view;
      const a = v?.you.action;
      const key = `${v?.game?.phase}:${v?.game?.day}:${a?.kind}`;
      if (a && key !== lastKey && a.kind !== 'wait') {
        lastKey = key;
        if (a.kind === 'ready') await this.post('/api/action', { type: 'ready' });
        else if (a.kind === 'vote') {
          const pick = rng() < 0.1 ? null : a.options[Math.floor(rng() * a.options.length)];
          await this.post('/api/action', { type: 'vote', target: pick });
        } else if (a.options.length) {
          await this.post('/api/action', { type: 'night', target: a.options[Math.floor(rng() * a.options.length)] });
        }
      }
      await sleep(5);
    }
  }
}

export async function lobbyOf(base, n, names) {
  const clients = Array.from({ length: n }, (_, i) => new Client(base, names?.[i] ?? `Player${i + 1}`));
  await clients[0].create();
  for (const c of clients.slice(1)) {
    const r = await c.join(clients[0].code);
    if (!r.ok) throw new Error(`join failed: ${r.error}`);
  }
  for (const c of clients) await c.connect();
  return clients;
}
