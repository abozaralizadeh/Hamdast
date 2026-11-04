// The app served under a path prefix (/hamdast/) behind a proxy, the way a shared VM
// runs it. Every file the browser loads must resolve inside the prefix, a whole game
// must work through it, and the room caps must count the right address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { startServer, startPrefixProxy, Client } from './helpers.js';

async function withProxy(extra, fn) {
  const s = await startServer(extra);
  const p = await startPrefixProxy(s.base);
  try {
    await fn(p, s);
  } finally {
    await p.stop();
    await s.stop();
  }
}

const get = (url, init) => fetch(url, { redirect: 'manual', ...init });

test('every file the page, manifest, stylesheet and service worker load stays under the prefix', async () => {
  await withProxy({}, async (p) => {
    const bare = await get(p.base);
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get('location'), '/hamdast/');

    const pageUrl = `${p.base}/`;
    const page = await (await get(pageUrl)).text();
    const refs = [...page.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => new URL(m[1], pageUrl));
    assert.ok(refs.length >= 5);

    const manifestUrl = new URL('manifest.webmanifest', pageUrl);
    const manifest = await (await get(manifestUrl)).json();
    for (const key of ['start_url', 'scope']) refs.push(new URL(manifest[key], manifestUrl));
    for (const icon of manifest.icons) refs.push(new URL(icon.src, manifestUrl));

    const cssUrl = new URL('style.css', pageUrl);
    const css = await (await get(cssUrl)).text();
    for (const [, u] of css.matchAll(/url\('([^']+)'\)/g)) refs.push(new URL(u, cssUrl));

    const swUrl = new URL('sw.js', pageUrl);
    const sw = await (await get(swUrl)).text();
    const shell = JSON.parse(sw.match(/const SHELL = (\[[^\]]+\]);/)[1].replaceAll("'", '"'));
    for (const u of shell) refs.push(new URL(u, swUrl));

    for (const url of refs) {
      assert.ok(url.pathname.startsWith('/hamdast/'), `${url.pathname} is outside the prefix`);
      assert.equal((await get(url)).status, 200, `${url.pathname} did not load`);
    }
    assert.deepEqual(p.strays, []);
  });
});

test('a whole game plays through the prefix, live stream included', async () => {
  await withProxy({}, async (p) => {
    const clients = Array.from({ length: 6 }, (_, i) => new Client(p.base, `Prefix${i + 1}`));
    assert.ok((await clients[0].create()).ok);
    for (const c of clients.slice(1)) assert.ok((await c.join(clients[0].code)).ok);
    for (const c of clients) assert.equal(await c.connect(), 200);
    assert.ok((await clients[0].post('/api/start')).ok);
    await Promise.all(clients.map((c) => c.autoplay()));
    for (const c of clients) {
      assert.equal(c.view.game.phase, 'over');
      c.disconnect();
    }
    assert.deepEqual(p.strays, []);
  }).catch((err) => { throw err; });
});

async function create(p, client) {
  const res = await fetch(`${p.base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-client': client },
    body: JSON.stringify({ nickname: `Host${client.replace(/\W/g, '')}`, confirmed: true }),
  });
  return { status: res.status, ...(await res.json()) };
}

test('open rooms are capped in total and per address, using the address the proxy saw', async () => {
  await withProxy({ TRUST_PROXY: '127.0.0.1', MAX_ROOMS_PER_IP: '1', MAX_OPEN_ROOMS: '2' }, async (p) => {
    assert.equal((await create(p, '203.0.113.1')).ok, true);
    const again = await create(p, '203.0.113.1');
    assert.equal(again.status, 429);
    assert.equal(again.error, 'too_many_rooms');
    assert.equal((await create(p, '203.0.113.2')).ok, true);
    const full = await create(p, '203.0.113.3');
    assert.equal(full.status, 503);
    assert.equal(full.error, 'server_busy');
  });
});

test('a forwarded address is ignored unless it comes from a trusted proxy', async () => {
  await withProxy({ TRUST_PROXY: '10.9.9.9', MAX_ROOMS_PER_IP: '1' }, async (p) => {
    // The proxy here is 127.0.0.1, which is not trusted, so both look like the same person.
    assert.equal((await create(p, '203.0.113.1')).ok, true);
    assert.equal((await create(p, '203.0.113.2')).error, 'too_many_rooms');
  });
});

test('TRUST_PROXY takes false, true or a list of proxy addresses', () => {
  assert.equal(loadConfig({}).trustProxy, false);
  assert.equal(loadConfig({ TRUST_PROXY: 'false' }).trustProxy, false);
  assert.equal(loadConfig({ TRUST_PROXY: 'true' }).trustProxy, true);
  assert.deepEqual(loadConfig({ TRUST_PROXY: '127.0.0.1, ::1' }).trustProxy, ['127.0.0.1', '::1']);
});
