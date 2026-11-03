import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, lobbyOf, Client, sleep } from './helpers.js';
import { seededRng } from '../src/engine/simulate.js';
import { isMafiaTeam } from '../src/engine/rules.js';

async function withServer(extra, fn) {
  if (typeof extra === 'function') [fn, extra] = [extra, {}];
  const s = await startServer(extra);
  try {
    await fn(s);
  } finally {
    await s.stop();
  }
}

test('a full 6 player game over the real stream ends, and no secret reaches the wrong player', async () => {
  await withServer(async (s) => {
    const clients = await lobbyOf(s.base, 6);
    const host = clients[0];
    assert.equal((await host.post('/api/start')).ok, true);
    await Promise.all(clients.map((c, i) => c.autoplay(seededRng(100 + i))));
    await sleep(30);

    const final = host.view;
    assert.equal(final.game.phase, 'over');
    assert.ok(['citizens', 'mafia'].includes(final.game.winner));
    for (const p of final.players) assert.ok(p.role, 'every role is shown at the end');
    assert.equal(final.room.status, 'over');

    const roleOf = Object.fromEntries(final.players.map((p) => [p.seatId, p.role]));
    const tokens = clients.map((c) => c.token);

    for (const c of clients) {
      const myRole = roleOf[c.seatId];
      assert.ok(c.views.length > 3);
      for (const [i, v] of c.views.entries()) {
        const over = v.game?.phase === 'over';
        assert.equal(v.you.seatId, c.seatId);
        for (const p of v.players) {
          if (!p.role || over) continue;
          const allowed = p.seatId === c.seatId || (isMafiaTeam(myRole) && isMafiaTeam(p.role));
          assert.ok(allowed, `${c.name} saw ${p.role} on someone else in view ${i}`);
        }
        if (!isMafiaTeam(myRole) && !over) assert.ok(!v.chat.some((m) => m.channel === 'mafia'), 'mafia chat leaked');
        for (const forbidden of ['killVotes', 'tokenHash', 'state_json', 'doctorSelfUsed', '"night":{', '"votes":{']) {
          assert.ok(!c.raw[i].includes(forbidden), `${forbidden} found in a payload for ${c.name}`);
        }
        assert.ok(v.you.checks.every((x) => x.by === c.seatId));
      }
      for (const other of tokens.filter((t) => t !== c.token)) {
        assert.ok(!c.raw.some((r) => r.includes(other)), 'another player token leaked');
      }
    }
    for (const c of clients) c.disconnect();
  });
});

test('the detective gets a private answer and nobody else does', async () => {
  await withServer({ DAY_MS: '150', VOTE_MS: '150' }, async (s) => {
    const clients = await lobbyOf(s.base, 6);
    await clients[0].post('/api/start');
    const detective = await Promise.any(clients.map((c) => c.waitFor((v) => v.you.role === 'detective' && c)));
    await detective.waitFor((v) => v.you.action?.kind === 'check');
    const target = detective.view.you.action.options[0];
    assert.equal((await detective.post('/api/action', { type: 'night', target })).ok, true);
    await detective.waitFor((v) => v.you.checks.length === 1);
    assert.equal(detective.view.you.checks[0].target, target);
    for (const c of clients.filter((x) => x !== detective)) assert.equal(c.view.you.checks.length, 0);
    for (const c of clients) c.disconnect();
  });
});

test('without any actions the timers still move the game along, and a missed night kills nobody', async () => {
  await withServer({ DAY_MS: '150', VOTE_MS: '150' }, async (s) => {
    const clients = await lobbyOf(s.base, 6);
    await clients[0].post('/api/start');
    const host = clients[0];
    await host.waitFor((v) => v.game);
    const seen = new Set();
    const reachedDay2 = (v) => v.game.day >= 2 && v.game.phase === 'day';
    const start = Date.now();
    while (Date.now() - start < 4000 && !reachedDay2(host.view)) {
      seen.add(`${host.view.game.phase}${host.view.game.intro ? '-intro' : ''}`);
      await sleep(10);
    }
    assert.ok(seen.has('night-intro'));
    assert.ok(host.view.game.day >= 2, 'reached day 2 only through timers');
    assert.ok(host.view.players.every((p) => p.alive));
    for (const c of clients) c.disconnect();
  });
});

test('joining rules: nickname, confirmation, duplicates, full room, started game', async () => {
  await withServer(async (s) => {
    const host = new Client(s.base, 'Host One');
    assert.equal((await host.post('/api/rooms', { nickname: 'Host One' }, null)).error, 'not_confirmed');
    assert.equal((await host.post('/api/rooms', { nickname: 'x', confirmed: true }, null)).error, 'bad_nickname');
    assert.equal((await host.post('/api/rooms', { nickname: '<script>', confirmed: true }, null)).error, 'bad_nickname');
    assert.equal((await host.post('/api/rooms', { nickname: 'Admin', confirmed: true }, null)).error, 'reserved_nickname');
    await host.create();

    assert.equal((await new Client(s.base, 'host one').join(host.code)).error, 'nickname_taken');
    assert.equal((await new Client(s.base, 'Sara').join('ZZZZZZ')).error, 'room_not_found');
    assert.equal((await new Client(s.base, 'Sara').join(host.code, { confirmed: false })).error, 'not_confirmed');
    assert.equal((await new Client(s.base, 'سارا').join(host.code)).ok, true, 'Farsi nicknames work');

    for (let i = 3; i <= 12; i++) assert.equal((await new Client(s.base, `Player ${i}`).join(host.code)).ok, true);
    assert.equal((await new Client(s.base, 'Late').join(host.code)).error, 'room_full');
    await host.connect();
    assert.equal(host.view.players.length, 12);
    assert.equal((await host.post('/api/start')).ok, true);
    assert.equal((await new Client(s.base, 'Later').join(host.code)).error, 'game_started');
    host.disconnect();
  });
});

test('only the host starts, and not with too few players', async () => {
  await withServer(async (s) => {
    const host = new Client(s.base, 'Nima');
    await host.create();
    const guests = [];
    for (let i = 0; i < 4; i++) {
      const g = new Client(s.base, `Guest ${i}`);
      await g.join(host.code);
      guests.push(g);
    }
    assert.equal((await host.post('/api/start')).error, 'bad_player_count');
    await new Client(s.base, 'Guest 5').join(host.code);
    assert.equal((await guests[0].post('/api/start')).status, 403);
    assert.equal((await host.post('/api/start')).ok, true);
  });
});

test('auth: no token, bad token, and removed players all get 401', async () => {
  await withServer(async (s) => {
    const host = new Client(s.base, 'Nima');
    await host.create();
    const guest = new Client(s.base, 'Guest');
    await guest.join(host.code);
    assert.equal((await host.post('/api/chat', { text: 'hi' }, null)).status, 401);
    assert.equal((await host.post('/api/chat', { text: 'hi' }, 'x'.repeat(40))).status, 401);
    assert.equal((await (await fetch(s.base + '/api/view')).status), 401);
    assert.equal((await host.post('/api/kick', { seatId: guest.seatId })).ok, true);
    assert.equal((await guest.post('/api/chat', { text: 'hi' })).status, 401, 'a kicked token stops working');
    assert.equal((await guest.post('/api/kick', { seatId: host.seatId })).status, 401);
  });
});

test('leaving the lobby passes host, and an empty room is deleted', async () => {
  await withServer(async (s) => {
    const host = new Client(s.base, 'Nima');
    await host.create();
    const guest = new Client(s.base, 'Guest');
    await guest.join(host.code);
    await guest.connect();
    await host.post('/api/leave');
    await guest.waitFor((v) => v.room.hostSeatId === guest.seatId);
    assert.equal(guest.view.players.length, 1);
    await guest.post('/api/leave');
    assert.equal(s.store.countRows('rooms'), 0);
    assert.equal(s.store.countRows('seats'), 0);
    guest.disconnect();
  });
});

test('chat: public only by day for the living, mafia only at night, limits apply', async () => {
  await withServer({ NIGHT_MS: '400', INTRO_MS: '400' }, async (s) => {
    const clients = await lobbyOf(s.base, 6);
    const [host] = clients;
    assert.equal((await host.post('/api/chat', { text: 'hello lobby' })).ok, true);
    await clients[1].waitFor((v) => v.chat.length === 1);
    assert.equal((await host.post('/api/chat', { text: 'x'.repeat(301) })).error, 'bad_message');
    assert.equal((await host.post('/api/chat', { text: '   ' })).error, 'bad_message');

    await host.post('/api/start');
    await host.waitFor((v) => v.game);
    const mafia = clients.find((c) => isMafiaTeam(c.view.you.role));
    const citizen = clients.find((c) => !isMafiaTeam(c.view.you.role));
    assert.equal((await citizen.post('/api/chat', { text: 'night talk' })).error, 'chat_closed');
    assert.equal((await citizen.post('/api/chat', { text: 'night talk' }, citizen.token)).ok, false);
    assert.equal((await mafia.post('/api/chat', { channel: 'mafia', text: 'plan' })).ok, true);
    const other = clients.find((c) => isMafiaTeam(c.view.you.role) && c !== mafia);
    await other.waitFor((v) => v.chat.some((m) => m.channel === 'mafia'));
    for (const c of clients.filter((x) => !isMafiaTeam(x.view.you.role))) {
      assert.ok(!c.view.chat.some((m) => m.channel === 'mafia'));
      assert.equal((await c.post('/api/chat', { channel: 'mafia', text: 'sneaky' })).error, 'chat_closed');
    }
    await host.waitFor((v) => v.game.phase === 'day');
    assert.equal((await citizen.post('/api/chat', { text: 'day talk' })).ok, true);
    assert.equal((await mafia.post('/api/chat', { channel: 'mafia', text: 'plan' })).error, 'chat_closed');
    for (const c of clients) c.disconnect();
  });
});

test('chat is rate limited', async () => {
  await withServer(async (s) => {
    const host = new Client(s.base, 'Nima');
    await host.create();
    const results = [];
    for (let i = 0; i < 8; i++) results.push((await host.post('/api/chat', { text: `m${i}` })).status);
    assert.ok(results.includes(429));
    assert.equal(results[0], 200);
  });
});

test('creating rooms is rate limited per address', async () => {
  await withServer(async (s) => {
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await new Client(s.base, `Host ${i}`).post('/api/rooms', { nickname: `Host ${i}`, confirmed: true }, null)).status);
    assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.equal(statuses[5], 429);
  });
});

test('reconnecting restores the same seat and role, and others see away then back', async () => {
  await withServer(async (s) => {
    const clients = await lobbyOf(s.base, 6);
    await clients[0].post('/api/start');
    const [host, guest] = clients;
    await guest.waitFor((v) => v.you.role);
    const role = guest.view.you.role;
    guest.disconnect();
    await host.waitFor((v) => v.players.find((p) => p.seatId === guest.seatId).away);
    const back = new Client(s.base, guest.name);
    Object.assign(back, { token: guest.token, seatId: guest.seatId });
    assert.equal(await back.connect(), 200);
    assert.equal(back.view.you.role, role);
    await host.waitFor((v) => !v.players.find((p) => p.seatId === guest.seatId).away);
    for (const c of clients) c.disconnect();
    back.disconnect();
  });
});

test('a player who leaves mid game stays in the game as absent and the game goes on', async () => {
  await withServer(async (s) => {
    const clients = await lobbyOf(s.base, 6);
    await clients[0].post('/api/start');
    await clients[1].post('/api/leave');
    await clients[0].waitFor((v) => v.players.find((p) => p.seatId === clients[1].seatId).left);
    assert.equal(clients[0].view.players.find((p) => p.seatId === clients[1].seatId).absent, true);
    await clients[0].waitFor((v) => v.game.phase === 'day');
    for (const c of clients) c.disconnect();
  });
});

test('host settings are bounded and only allowed in the lobby', async () => {
  await withServer({ MIN_PHASE_MS: '10000' }, async (s) => {
    const host = new Client(s.base, 'Nima');
    await host.create();
    assert.equal((await host.post('/api/settings', { dayMs: 100 })).error, 'bad_settings');
    assert.equal((await host.post('/api/settings', { dayMs: 99999999 })).error, 'bad_settings');
    assert.equal((await host.post('/api/settings', { dayMs: 'soon' })).error, 'bad_settings');
    assert.equal((await host.post('/api/settings', { dayMs: 60000, voteMs: 30000 })).ok, true);
    await host.connect();
    assert.equal(host.view.room.settings.dayMs, 60000);
    host.disconnect();
  });
});

test('rematch returns the room to the lobby and clears chat', async () => {
  await withServer(async (s) => {
    const clients = await lobbyOf(s.base, 6);
    await clients[0].post('/api/start');
    await Promise.all(clients.map((c, i) => c.autoplay(seededRng(7 + i))));
    assert.equal((await clients[1].post('/api/rematch')).status, 403);
    assert.equal((await clients[0].post('/api/rematch')).ok, true);
    await clients[2].waitFor((v) => v.room.status === 'lobby');
    assert.equal(clients[2].view.game, null);
    assert.equal(clients[2].view.you.role, null);
    assert.equal((await clients[0].post('/api/start')).ok, true);
    for (const c of clients) c.disconnect();
  });
});

test('report, block and admin review', async () => {
  await withServer({ ADMIN_TOKEN: 'local-test-admin-token' }, async (s) => {
    const [a, b, c] = await lobbyOf(s.base, 3);
    await a.post('/api/chat', { text: 'rude words' });
    await b.waitFor((v) => v.chat.length === 1);

    assert.equal((await b.post('/api/report', { seatId: a.seatId, reason: 'abuse' })).ok, true);
    assert.equal((await b.post('/api/report', { seatId: a.seatId, reason: 'because' })).error, 'bad_target');
    assert.equal((await b.post('/api/report', { seatId: b.seatId, reason: 'abuse' })).error, 'bad_target');

    assert.equal((await b.post('/api/block', { seatId: a.seatId })).ok, true);
    await b.waitFor((v) => v.chat.length === 0);
    assert.equal(c.view.chat.length, 1, 'blocking only hides messages for the blocker');

    const adminGet = (token) => fetch(s.base + '/api/admin/reports', { headers: token ? { authorization: `Bearer ${token}` } : {} });
    assert.equal((await adminGet(null)).status, 401);
    assert.equal((await adminGet('wrong-token')).status, 401);
    const list = await (await adminGet('local-test-admin-token')).json();
    assert.equal(list.reports.length, 1);
    assert.equal(list.reports[0].snapshot.recent[0].body, 'rude words');
    assert.equal(list.reports[0].snapshot.reported, 'Player1');

    const ban = await fetch(`${s.base}/api/admin/reports/${list.reports[0].id}`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-test-admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'ban' }),
    });
    assert.equal(ban.status, 200);
    assert.equal((await a.post('/api/chat', { text: 'again' })).status, 401, 'banned session is out');
    assert.equal((await (await adminGet('local-test-admin-token')).json()).reports.length, 0);
    for (const x of [a, b, c]) x.disconnect();
  });
});

test('admin endpoints do not exist when no admin token is set', async () => {
  await withServer(async (s) => {
    assert.equal((await fetch(s.base + '/api/admin/reports', { headers: { authorization: 'Bearer anything' } })).status, 404);
  });
});

test('voice: off by default, and with the fake it follows the turn rules', async () => {
  await withServer(async (s) => {
    const host = new Client(s.base, 'Nima');
    await host.create();
    assert.equal((await fetch(s.base + '/api/voice', { headers: { authorization: `Bearer ${host.token}` } })).status, 404);
  });

  await withServer({ VOICE_PROVIDER: 'fake', SPEAK_MS: '150', DAY_MS: '1200', INTRO_MS: '60', NIGHT_MS: '100' }, async (s) => {
    const clients = await lobbyOf(s.base, 6);
    const [host] = clients;
    const fake = s.manager.voice;
    const v = await (await fetch(s.base + '/api/voice', { headers: { authorization: `Bearer ${host.token}` } })).json();
    assert.equal(v.provider, 'fake');
    await host.post('/api/start');
    await host.waitFor((x) => x.game);
    assert.deepEqual(fake.speakersOf(s.manager.rooms.values().next().value.id), [], 'everyone muted at night');
    await host.waitFor((x) => x.game.phase === 'day');
    const room = s.manager.rooms.values().next().value;
    assert.equal(fake.speakersOf(room.id).length, 1, 'one speaker at a time on day turns');
    assert.equal(host.view.voice.mode, 'turn');
    const first = host.view.voice.speakerSeatId;
    await host.waitFor((x) => x.voice.mode === 'turn' && x.voice.speakerSeatId !== first);
    await host.waitFor((x) => x.voice.mode === 'open');
    assert.equal(fake.speakersOf(room.id).length, 6);
    assert.ok(clients.filter((c) => c.view.voice.canSpeak).length >= 1);
    for (const c of clients) c.disconnect();
  });
});

test('static files are served with security headers, and path tricks fail', async () => {
  await withServer(async (s) => {
    const res = await fetch(s.base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await res.text(), /<html/);
    assert.equal((await fetch(s.base + '/nothing.js')).status, 404);

    const status = await new Promise((resolve, reject) => {
      const url = new URL(s.base);
      http.get({ host: url.hostname, port: url.port, path: '/%2e%2e/package.json' }, (r) => {
        r.resume();
        resolve(r.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 404);
    const rawDots = await new Promise((resolve, reject) => {
      const url = new URL(s.base);
      http.get({ host: url.hostname, port: url.port, path: '/../package.json' }, (r) => {
        r.resume();
        resolve(r.statusCode);
      }).on('error', reject);
    });
    assert.notEqual(rawDots, 200);
  });
});

test('bad JSON and oversized bodies are refused', async () => {
  await withServer(async (s) => {
    const bad = await fetch(s.base + '/api/rooms', { method: 'POST', body: '{nope' });
    assert.equal(bad.status, 400);
    const big = await fetch(s.base + '/api/rooms', { method: 'POST', body: JSON.stringify({ nickname: 'a'.repeat(20000) }) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
  });
});
