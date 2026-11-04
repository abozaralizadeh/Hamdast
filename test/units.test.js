import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, scrub } from '../src/server/logger.js';
import { checkNickname, loadBlockedWords } from '../src/server/nickname.js';
import { speakingState, voicePolicy } from '../src/voice/policy.js';
import { FakeVoice, NoVoice, createVoice } from '../src/voice/provider.js';
import { createLimiter } from '../src/server/ratelimit.js';
import { openStore } from '../src/server/store.js';
import { loadConfig } from '../src/config.js';
import { RoomManager } from '../src/server/rooms.js';
import { seededRng } from '../src/engine/simulate.js';
import { buildView } from '../src/server/view.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hamdast-unit-'));
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ---------- logger ----------

test('logger rotates by size and keeps a fixed number of old files', () => {
  const dir = tmp();
  const log = createLogger({ dir, maxBytes: 400, keep: 3, stdout: false });
  for (let i = 0; i < 60; i++) log.info('line', { n: i, pad: 'x'.repeat(30) });
  log.close();
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['app.log', 'app.log.1', 'app.log.2', 'app.log.3']);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 400 + 150, `${f} too big`);
  const newest = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(newest.at(-1).n, 59, 'newest line is in the live file');
  fs.rmSync(dir, { recursive: true });
});

test('logger keeps chat text, roles, nicknames and tokens out', () => {
  const dir = tmp();
  const log = createLogger({ dir, stdout: false });
  log.info('event', { roomId: 'r1', text: 'secret chat', body: 'x', role: 'godfather', nickname: 'Ali', token: 'abc', nested: { Token: 'zzz', ok: 1 }, ip: '1.2.3.4' });
  log.close();
  const out = fs.readFileSync(path.join(dir, 'app.log'), 'utf8');
  for (const s of ['secret chat', 'godfather', 'Ali', 'abc', 'zzz', '1.2.3.4']) assert.ok(!out.includes(s), `${s} was logged`);
  assert.ok(out.includes('"roomId":"r1"') && out.includes('"ok":1'));
  assert.deepEqual(scrub({ a: 1, TOKEN: 2 }), { a: 1 });
  fs.rmSync(dir, { recursive: true });
});

test('logger never throws when the folder cannot be written', () => {
  const log = createLogger({ dir: '/proc/definitely/not/writable', stdout: false });
  assert.doesNotThrow(() => log.info('still fine'));
});

// ---------- nicknames ----------

test('nickname rules', () => {
  const ok = (n, o) => checkNickname(n, o);
  assert.equal(ok('Sara').ok, true);
  assert.equal(ok('  Sara   K ').nickname, 'Sara K');
  assert.equal(ok('علی رضا').ok, true);
  assert.equal(ok('نیما‌').ok, true, 'half-space allowed');
  assert.equal(ok('a').error, 'bad_nickname');
  assert.equal(ok('x'.repeat(21)).error, 'bad_nickname');
  assert.equal(ok('<b>hi</b>').error, 'bad_nickname');
  assert.equal(ok('hi\nthere').nickname, 'hi there');
  assert.equal(ok(42).error, 'bad_nickname');
  assert.equal(ok('A d_m.i-n').error, 'reserved_nickname');
  assert.equal(ok('ادمین').error, 'reserved_nickname');
  assert.equal(ok('sara', { taken: ['SARA'] }).error, 'nickname_taken');
  assert.equal(ok('s.a.r.a', { taken: ['sara'] }).error, 'nickname_taken');
  assert.equal(ok('uglyword99', { blockedWords: ['uglyword'] }).error, 'blocked_nickname');
});

test('the shipped blocked word list loads and ignores comments', () => {
  const words = loadBlockedWords(path.resolve(import.meta.dirname, '../config/blocked-words.txt'));
  assert.deepEqual(words, []);
  assert.deepEqual(loadBlockedWords('/no/such/file'), []);
});

// ---------- voice ----------

test('speaking turns: one speaker at a time, then open discussion', () => {
  const base = { aliveIds: ['a', 'b', 'c'], startedAt: 1000, dayMs: 10000, speakMs: 1000 };
  assert.deepEqual(speakingState({ ...base, now: 1000 }), { mode: 'turn', speakerId: 'a', turnEndsAt: 2000 });
  assert.equal(speakingState({ ...base, now: 2500 }).speakerId, 'b');
  assert.equal(speakingState({ ...base, now: 3999 }).speakerId, 'c');
  assert.equal(speakingState({ ...base, now: 4000 }).mode, 'open');
  assert.equal(speakingState({ ...base, aliveIds: [], now: 1000 }).mode, 'open');
});

test('speaking turns never use more than 70% of the day', () => {
  const s = { aliveIds: ['a', 'b', 'c', 'd'], startedAt: 0, dayMs: 1000, speakMs: 30000 };
  assert.equal(speakingState({ ...s, now: 699 }).mode, 'turn');
  assert.equal(speakingState({ ...s, now: 700 }).mode, 'open');
});

test('voice policy: muted at night and during votes, only the living talk by day, everyone after', () => {
  const players = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({ id, alive: i !== 5 }));
  const state = (phase) => ({ phase, settings: { dayMs: 6000 }, players });
  const input = (phase, now) => ({ state: state(phase), activeSeatIds: players.map((p) => p.id), startedAt: 0, speakMs: 500, now });
  assert.deepEqual(voicePolicy(input('night', 0)).allowed, []);
  assert.deepEqual(voicePolicy(input('vote', 0)).allowed, []);
  assert.deepEqual(voicePolicy(input('day', 100)).allowed, ['a']);
  assert.deepEqual(voicePolicy(input('day', 5000)).allowed, ['a', 'b', 'c', 'd', 'e'], 'dead player f stays silent');
  assert.equal(voicePolicy(input('over', 0)).allowed.length, 6);
  assert.equal(voicePolicy({ state: null, activeSeatIds: ['a'], startedAt: 0, speakMs: 1, now: 0 }).mode, 'open');
});

test('voice providers: fake records calls and carries no credentials, off does nothing', () => {
  const v = new FakeVoice();
  v.openRoom('r');
  v.setSpeakers('r', ['a']);
  assert.deepEqual(v.speakersOf('r'), ['a']);
  const t = v.tokenFor('r', 'a');
  assert.equal(t.provider, 'fake');
  assert.equal(t.url, null);
  v.closeRoom('r');
  assert.deepEqual(v.speakersOf('r'), []);
  assert.equal(createVoice({ voiceProvider: 'off' }), NoVoice);
  assert.equal(createVoice({ voiceProvider: 'whatever' }), NoVoice);
  assert.ok(createVoice({ voiceProvider: 'fake' }) instanceof FakeVoice);
  assert.equal(NoVoice.tokenFor(), null);
});

// ---------- rate limiter ----------

test('rate limiter refills over time and keys are independent', () => {
  let t = 0;
  const l = createLimiter({ now: () => t });
  const rule = { capacity: 2, perSecond: 1 };
  assert.ok(l.allow('a', rule) && l.allow('a', rule));
  assert.equal(l.allow('a', rule), false);
  assert.ok(l.allow('b', rule));
  t = 1000;
  assert.ok(l.allow('a', rule));
  assert.equal(l.allow('a', rule), false);
  t = 20 * 60 * 1000;
  l.sweep();
  assert.equal(l.size(), 0);
});

// ---------- config ----------

test('config reads the environment, applies defaults, and clamps player counts', () => {
  const d = loadConfig({});
  assert.deepEqual([d.minPlayers, d.maxPlayers, d.minAge, d.defaultLanguage, d.voiceProvider, d.adminToken], [6, 12, 16, 'fa', 'off', '']);
  assert.equal(d.timers.nightEarlyEnd, false);
  const c = loadConfig({ MIN_PLAYERS: '2', MAX_PLAYERS: '99', MIN_AGE: '18', DEFAULT_LANGUAGE: 'en', NIGHT_EARLY_END: 'true', DAY_MS: 'abc' });
  assert.deepEqual([c.minPlayers, c.maxPlayers, c.minAge, c.defaultLanguage, c.timers.nightEarlyEnd, c.timers.dayMs], [6, 12, 18, 'en', true, 180000]);
});

// ---------- manager harness with a fake clock ----------

function harness({ now = { t: 1_000_000 }, voice = new FakeVoice(), file, extra = {} } = {}) {
  const config = loadConfig({ MIN_PHASE_MS: '1', INTRO_MS: '40', DAY_MS: '5000', VOTE_MS: '5000', NIGHT_MS: '5000', LOG_STDOUT: 'false', ...extra });
  const store = openStore(file ?? ':memory:');
  const manager = new RoomManager({
    config, store, voice, limiter: createLimiter(), logger: createLogger({ stdout: false }),
    rng: seededRng(5), now: () => now.t,
  });
  return { manager, store, config, now, voice };
}

function fillRoom(manager, n = 6) {
  const first = manager.createRoom({ nickname: 'Dealer', confirmed: true });
  const seats = [first];
  for (let i = 2; i <= n; i++) seats.push(manager.joinRoom(first.code, { nickname: `P${i}`, confirmed: true }));
  return seats;
}

test('retention: rooms go 24 hours after the game ends, chat and events with them', () => {
  const h = harness();
  const [host] = fillRoom(h.manager);
  h.manager.startGame(host.seatId);
  h.manager.sendChat(host.seatId, 'mafia', 'x');
  const room = h.manager.rooms.values().next().value;
  assert.equal(h.manager.rematch(host.seatId).error, 'not_over', 'a running game cannot be reset');
  assert.equal(h.store.countRows('rooms'), 1);

  // Mark the game as ended now, then check the retention window.
  room.status = 'over';
  room.endedAt = h.now.t;
  h.store.saveRoom(room, h.now.t);
  h.store.addChat(room.id, { seatId: host.seatId, channel: 'public', body: 'gg', day: 1, at: h.now.t });

  h.now.t += 23 * HOUR;
  assert.deepEqual(h.manager.maintenance().rooms, [], 'still kept at 23 hours');
  assert.equal(h.store.countRows('chat_messages') > 0, true);

  h.now.t += 2 * HOUR;
  const out = h.manager.maintenance();
  assert.equal(out.rooms.length, 1);
  for (const table of ['rooms', 'seats', 'games', 'game_events', 'chat_messages']) assert.equal(h.store.countRows(table), 0, `${table} not empty`);
  assert.equal(h.manager.authenticate(host.token), null, 'tokens stop working');
  assert.equal(h.manager.rooms.size, 0);
  h.manager.shutdown();
});

test('retention: abandoned rooms that never ended also expire', () => {
  const h = harness();
  fillRoom(h.manager, 2);
  h.now.t += 25 * HOUR;
  assert.equal(h.manager.maintenance().rooms.length, 1);
  assert.equal(h.store.countRows('rooms'), 0);
});

test('retention: reports go 30 days after review, open ones after 60 days, totals stay', () => {
  const h = harness();
  const [a, b] = fillRoom(h.manager, 3);
  h.manager.report(b.seatId, a.seatId, 'abuse');
  h.manager.report(a.seatId, b.seatId, 'spam');
  const [first] = h.manager.listReports();
  h.manager.resolveReport(first.id, 'dismiss');
  h.store.bumpTotals('mafia', 8);
  h.now.t += 29 * DAY;
  assert.equal(h.manager.maintenance().reports, 0);
  h.now.t += 2 * DAY;
  assert.equal(h.manager.maintenance().reports, 1, 'reviewed report removed at 31 days');
  assert.equal(h.manager.listReports().length, 1, 'open report still waiting');
  h.now.t += 40 * DAY;
  h.manager.maintenance();
  assert.equal(h.store.listReports('open').length, 0, 'open report removed after 60 days');
  assert.deepEqual(h.store.totals(), { games_played: 1, wins_mafia: 1, players_total: 8 });
});

test('retention: a ban record is dropped after 90 days', () => {
  const h = harness();
  const [a, b] = fillRoom(h.manager, 3);
  h.manager.report(b.seatId, a.seatId, 'abuse');
  const [report] = h.manager.listReports();
  h.manager.resolveReport(report.id, 'ban');
  assert.equal(h.store.countRows('bans'), 1);
  h.now.t += 89 * DAY;
  h.manager.maintenance();
  assert.equal(h.store.countRows('bans'), 1, 'still there at 89 days');
  h.now.t += 2 * DAY;
  assert.equal(h.manager.maintenance().bans, 1);
  assert.equal(h.store.countRows('bans'), 0);
});

test('restart: rooms, roles, chat and timers come back from the database', async () => {
  const dir = tmp();
  const file = path.join(dir, 'db.sqlite');
  const now = { t: Date.now() };
  const first = harness({ now, file });
  const seats = fillRoom(first.manager);
  first.manager.sendChat(seats[0].seatId, 'public', 'before restart');
  first.manager.startGame(seats[0].seatId);
  const roles = seats.map((s) => first.manager.viewOf(s.seatId).you.role);
  const code = seats[0].code;
  first.manager.shutdown();
  first.store.close();

  const second = harness({ now, file });
  assert.equal(second.manager.restore(), 1);
  assert.deepEqual(seats.map((s) => second.manager.viewOf(s.seatId).you.role), roles);
  assert.equal(second.manager.authenticate(seats[2].token).seat.id, seats[2].seatId, 'old token still works');
  assert.equal(second.manager.byCode.get(code).status, 'playing');
  assert.equal(second.manager.viewOf(seats[0].seatId).game.phase, 'night');

  // The intro timer was running; after the restart the game still moves on by itself.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(second.manager.viewOf(seats[0].seatId).game.phase, 'day');
  second.manager.shutdown();
  second.store.close();
  fs.rmSync(dir, { recursive: true });
});

test('restart: a phase that ended while the server was down advances right away', async () => {
  const dir = tmp();
  const file = path.join(dir, 'db.sqlite');
  const now = { t: Date.now() };
  const first = harness({ now, file, extra: { INTRO_MS: '60000' } });
  const seats = fillRoom(first.manager);
  first.manager.startGame(seats[0].seatId);
  first.manager.shutdown();
  first.store.close();
  now.t += 2 * 60000;
  const second = harness({ now, file, extra: { INTRO_MS: '60000' } });
  second.manager.restore();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(second.manager.viewOf(seats[0].seatId).game.phase, 'day');
  second.manager.shutdown();
  second.store.close();
  fs.rmSync(dir, { recursive: true });
});

test('view filter: a plain citizen view holds no other role and no night data', () => {
  const h = harness();
  const seats = fillRoom(h.manager);
  h.manager.startGame(seats[0].seatId);
  const room = h.manager.rooms.values().next().value;
  const citizen = room.game.state.players.find((p) => p.role === 'citizen');
  const json = JSON.stringify(buildView(room, citizen.id, { now: 0, config: h.config, voice: h.voice }));
  for (const role of ['godfather', 'doctor', 'detective']) assert.ok(!json.includes(`"role":"${role}"`), `${role} leaked`);
  const shown = [...json.matchAll(/"role":"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(shown, ['citizen', 'citizen'], 'only the own role, in you and in the own player entry');
  for (const key of ['killVotes', 'doctorSelfUsed', 'missed', 'tokenHash']) assert.ok(!json.includes(key), key);
  h.manager.shutdown();
});

test('view filter: mafia see their teammates and nobody else', () => {
  const h = harness();
  const seats = fillRoom(h.manager, 9);
  h.manager.startGame(seats[0].seatId);
  const room = h.manager.rooms.values().next().value;
  const mafia = room.game.state.players.filter((p) => p.role === 'mafia' || p.role === 'godfather');
  assert.equal(mafia.length, 3);
  const view = buildView(room, mafia[0].id, { now: 0, config: h.config, voice: h.voice });
  const shown = view.players.filter((p) => p.role).map((p) => p.seatId).sort();
  assert.deepEqual(shown, mafia.map((p) => p.id).sort());
  h.manager.shutdown();
});

test('tokens are stored only as hashes', () => {
  const h = harness();
  const [host] = fillRoom(h.manager, 2);
  const room = h.manager.rooms.values().next().value;
  const seat = room.seats.get(host.seatId);
  assert.notEqual(seat.tokenHash, host.token);
  assert.match(seat.tokenHash, /^[0-9a-f]{64}$/);
  const rows = JSON.stringify(h.store.loadRooms());
  assert.ok(!rows.includes(host.token));
});

test('a game cannot start twice, and a left player cannot come back with the old token', () => {
  const h = harness();
  const seats = fillRoom(h.manager);
  assert.equal(h.manager.startGame(seats[0].seatId).ok, true);
  assert.equal(h.manager.startGame(seats[0].seatId).error, 'game_started');
  h.manager.leave(seats[3].seatId);
  assert.equal(h.manager.authenticate(seats[3].token), null);
  h.manager.shutdown();
});
