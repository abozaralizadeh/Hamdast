import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../src/engine/rules.js';
import { seededRng, simulateGame } from '../src/engine/simulate.js';

const { ROLES } = engine;

// Builds a game with fixed roles so each rule can be tested on its own.
function fixedGame(roles, settings = {}) {
  const state = engine.createGame({ playerIds: roles.map((_, i) => `p${i + 1}`), rng: seededRng(1), settings });
  roles.forEach((role, i) => { state.players[i].role = role; });
  return state;
}
const BASE = [ROLES.GODFATHER, ROLES.MAFIA, ROLES.DOCTOR, ROLES.DETECTIVE, ROLES.CITIZEN, ROLES.CITIZEN, ROLES.CITIZEN];
const skipIntro = (s) => engine.advance(s).state;
const mustAct = (s, id, a) => {
  const r = engine.act(s, id, a);
  assert.ok(r.ok, `expected ${id} ${JSON.stringify(a)} to work, got ${r.error}`);
  return r.state;
};

test('role table matches the design for every player count', () => {
  const expected = { 6: [2, 2], 7: [2, 3], 8: [2, 4], 9: [3, 4], 10: [3, 5], 11: [3, 6], 12: [4, 6] };
  for (const [n, [mafia, citizens]] of Object.entries(expected)) {
    const roles = engine.roleList(Number(n));
    assert.equal(roles.length, Number(n));
    assert.equal(roles.filter(engine.isMafiaTeam).length, mafia, `mafia side at ${n}`);
    assert.equal(roles.filter((r) => r === ROLES.GODFATHER).length, 1);
    assert.equal(roles.filter((r) => r === ROLES.DOCTOR).length, 1);
    assert.equal(roles.filter((r) => r === ROLES.DETECTIVE).length, 1);
    assert.equal(roles.filter((r) => r === ROLES.CITIZEN).length, citizens, `citizens at ${n}`);
  }
});

test('player counts outside 6 to 12 are refused', () => {
  assert.throws(() => engine.roleList(5), RangeError);
  assert.throws(() => engine.roleList(13), RangeError);
});

test('same seed deals the same roles, different seeds can differ', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const roles = (seed) => engine.createGame({ playerIds: ids, rng: seededRng(seed) }).players.map((p) => p.role).join();
  assert.equal(roles(7), roles(7));
  assert.ok(new Set([1, 2, 3, 4, 5].map(roles)).size > 1);
});

test('intro night: nobody acts, nobody dies, then day 1', () => {
  const s = fixedGame(BASE);
  assert.equal(s.phase, 'night');
  assert.equal(s.intro, true);
  assert.equal(engine.act(s, 'p1', { type: 'night', target: 'p5' }).error, 'intro_night');
  const { state } = engine.advance(s);
  assert.equal(state.phase, 'day');
  assert.equal(state.day, 1);
  assert.ok(state.players.every((p) => p.alive));
});

test('godfather kill works when the doctor saves someone else', () => {
  let s = skipIntro(fixedGame(BASE));
  s = engine.advance(engine.advance(s).state).state; // day -> vote -> night
  assert.equal(s.phase, 'night');
  s = mustAct(s, 'p1', { type: 'night', target: 'p5' });
  s = mustAct(s, 'p3', { type: 'night', target: 'p6' });
  const { state, events } = engine.advance(s);
  assert.equal(state.players[4].alive, false);
  assert.equal(events[0].killed, 'p5');
  assert.equal(state.phase, 'day');
  assert.equal(state.day, 2);
});

test('doctor save cancels the kill and nothing reveals who was saved', () => {
  let s = skipIntro(fixedGame(BASE));
  s = engine.advance(engine.advance(s).state).state;
  s = mustAct(s, 'p1', { type: 'night', target: 'p5' });
  s = mustAct(s, 'p3', { type: 'night', target: 'p5' });
  const { state, events } = engine.advance(s);
  assert.ok(state.players.every((p) => p.alive));
  assert.deepEqual(events[0], { type: 'night_result', day: 2, killed: null });
});

test('doctor may save themselves only once', () => {
  let s = skipIntro(fixedGame(BASE));
  const night = (st) => engine.advance(engine.advance(st).state).state;
  s = night(s);
  s = mustAct(s, 'p3', { type: 'night', target: 'p3' });
  s = engine.advance(s).state; // day 2
  assert.equal(s.doctorSelfUsed, true);
  s = night(s);
  assert.equal(engine.act(s, 'p3', { type: 'night', target: 'p3' }).error, 'self_save_used');
  assert.ok(engine.act(s, 'p3', { type: 'night', target: 'p4' }).ok);
});

test('detective reads the godfather as not mafia and a plain mafia as mafia', () => {
  let s = skipIntro(fixedGame(BASE));
  s = engine.advance(engine.advance(s).state).state;
  s = mustAct(s, 'p4', { type: 'night', target: 'p1' });
  s = engine.advance(s).state;
  assert.deepEqual(s.checks.at(-1), { by: 'p4', target: 'p1', isMafia: false, day: 1 });
  s = engine.advance(engine.advance(s).state).state;
  s = mustAct(s, 'p4', { type: 'night', target: 'p2' });
  s = engine.advance(s).state;
  assert.equal(s.checks.at(-1).isMafia, true);
});

test('night action rules: no mafia targets, no detective self check, citizens have no action', () => {
  let s = skipIntro(fixedGame(BASE));
  s = engine.advance(engine.advance(s).state).state;
  assert.equal(engine.act(s, 'p1', { type: 'night', target: 'p2' }).error, 'bad_target');
  assert.equal(engine.act(s, 'p4', { type: 'night', target: 'p4' }).error, 'bad_target');
  assert.equal(engine.act(s, 'p5', { type: 'night', target: 'p1' }).error, 'no_action');
  assert.equal(engine.act(s, 'p2', { type: 'night', target: 'p5' }).error, 'no_action', 'plain mafia is idle while the godfather lives');
  assert.equal(engine.act(s, 'p1', { type: 'night', target: 'nobody' }).error, 'bad_target');
});

test('when the godfather is dead the remaining mafia picks the target', () => {
  let s = skipIntro(fixedGame(BASE));
  s.players[0].alive = false;
  s = engine.advance(engine.advance(s).state).state;
  s = mustAct(s, 'p2', { type: 'night', target: 'p6' });
  const { state } = engine.advance(s);
  assert.equal(state.players[5].alive, false);
});

test('a missed godfather action means nobody dies', () => {
  let s = skipIntro(fixedGame(BASE));
  s = engine.advance(engine.advance(s).state).state;
  const { state, events } = engine.advance(s);
  assert.equal(events[0].killed, null);
  assert.ok(state.players.every((p) => p.alive));
});

test('actions are refused in the wrong phase and for dead players', () => {
  const s = skipIntro(fixedGame(BASE));
  assert.equal(engine.act(s, 'p1', { type: 'night', target: 'p5' }).error, 'wrong_phase');
  assert.equal(engine.act(s, 'p1', { type: 'vote', target: 'p5' }).error, 'wrong_phase');
  s.players[4].alive = false;
  assert.equal(engine.act(s, 'p5', { type: 'ready' }).error, 'dead');
  assert.equal(engine.act(s, 'zzz', { type: 'ready' }).error, 'not_in_game');
  assert.equal(engine.act(s, 'p1', { type: 'dance' }).error, 'bad_action');
});

function toVote(s) {
  return engine.advance(s).state;
}

test('vote: most votes is eliminated, role is not announced by the engine as an event field', () => {
  let s = toVote(skipIntro(fixedGame(BASE)));
  for (const id of ['p1', 'p2', 'p3', 'p4']) s = mustAct(s, id, { type: 'vote', target: 'p5' });
  for (const id of ['p5', 'p6', 'p7']) s = mustAct(s, id, { type: 'vote', target: null });
  assert.ok(engine.isComplete(s));
  const { state, events } = engine.advance(s);
  assert.equal(events[0].eliminated, 'p5');
  assert.equal(state.players[4].alive, false);
  assert.equal(state.phase, 'night');
  assert.ok(!('role' in events[0]));
});

test('vote: tie means nobody goes, skip with the most votes means nobody goes', () => {
  let s = toVote(skipIntro(fixedGame(BASE)));
  s = mustAct(s, 'p1', { type: 'vote', target: 'p5' });
  s = mustAct(s, 'p2', { type: 'vote', target: 'p6' });
  assert.equal(engine.advance(s).events[0].eliminated, null);

  let t = toVote(skipIntro(fixedGame(BASE)));
  t = mustAct(t, 'p1', { type: 'vote', target: 'p5' });
  t = mustAct(t, 'p2', { type: 'vote', target: null });
  t = mustAct(t, 'p3', { type: 'vote', target: null });
  assert.equal(engine.advance(t).events[0].eliminated, null);
});

test('vote: final once cast, no self vote, no dead target', () => {
  let s = toVote(skipIntro(fixedGame(BASE)));
  assert.equal(engine.act(s, 'p1', { type: 'vote', target: 'p1' }).error, 'bad_target');
  s = mustAct(s, 'p1', { type: 'vote', target: 'p5' });
  assert.equal(engine.act(s, 'p1', { type: 'vote', target: 'p6' }).error, 'already_voted');
});

test('day ends early only when every living player is ready', () => {
  let s = skipIntro(fixedGame(BASE));
  for (const p of s.players.slice(0, 6)) s = mustAct(s, p.id, { type: 'ready' });
  assert.equal(engine.isComplete(s), false);
  s = mustAct(s, 'p7', { type: 'ready' });
  assert.equal(engine.isComplete(s), true);
});

test('night never ends early by default, and does when nightEarlyEnd is on', () => {
  const run = (nightEarlyEnd) => {
    let s = skipIntro(fixedGame(BASE, { nightEarlyEnd }));
    s = engine.advance(engine.advance(s).state).state;
    s = mustAct(s, 'p1', { type: 'night', target: 'p5' });
    s = mustAct(s, 'p3', { type: 'night', target: 'p6' });
    s = mustAct(s, 'p4', { type: 'night', target: 'p7' });
    return engine.isComplete(s);
  };
  assert.equal(run(false), false);
  assert.equal(run(true), true);
});

test('citizens win when the last mafia is voted out', () => {
  let s = fixedGame(BASE);
  s.players[1].alive = false; // plain mafia already gone
  s = toVote(skipIntro(s));
  for (const p of s.players.filter((x) => x.alive && x.id !== 'p1')) s = mustAct(s, p.id, { type: 'vote', target: 'p1' });
  const { state, events } = engine.advance(s);
  assert.equal(state.winner, 'citizens');
  assert.equal(state.phase, 'over');
  assert.equal(events.at(-1).type, 'game_over');
});

test('mafia win when they equal everyone else', () => {
  const roles = [ROLES.GODFATHER, ROLES.MAFIA, ROLES.DOCTOR, ROLES.DETECTIVE, ROLES.CITIZEN, ROLES.CITIZEN];
  let s = skipIntro(fixedGame(roles));
  s.players[5].alive = false; // 2 mafia vs 3 others
  s = engine.advance(engine.advance(s).state).state; // night
  s = mustAct(s, 'p1', { type: 'night', target: 'p5' });
  const { state } = engine.advance(s);
  assert.equal(state.winner, 'mafia'); // 2 mafia vs 2 others
});

test('missing two phases in a row marks a player absent, acting brings them back', () => {
  let s = skipIntro(fixedGame(BASE));
  const nightPass = (st) => engine.advance(engine.advance(st).state).state;
  s = engine.advance(s).state; // day -> vote
  s = engine.advance(s).state; // nobody voted: miss 1 for all
  assert.equal(s.players[0].missed, 1);
  s = engine.advance(s).state; // night ends, godfather misses again
  assert.equal(s.phase, 'day');
  assert.equal(s.players[0].absent, true);
  s = nightPass(s);
  s = mustAct(s, 'p1', { type: 'night', target: 'p5' });
  s = engine.advance(s).state;
  assert.equal(s.players[0].absent, false);
});

test('absent players are not waited for, and an empty wait never completes', () => {
  let s = skipIntro(fixedGame(BASE));
  s = engine.markAbsent(s, 'p7');
  for (const p of s.players.slice(0, 6)) s = mustAct(s, p.id, { type: 'ready' });
  assert.equal(engine.isComplete(s), true);
  for (const p of s.players) s = engine.markAbsent(s, p.id);
  s.ready = {};
  assert.equal(engine.isComplete(s), false);
});

test('engine never mutates the state it is given', () => {
  const s = skipIntro(fixedGame(BASE));
  const frozen = JSON.stringify(s);
  engine.act(s, 'p1', { type: 'ready' });
  engine.advance(s);
  assert.equal(JSON.stringify(s), frozen);
});

test('simulation: 1050 random games at every size end with a winner and no invalid moves', () => {
  let games = 0;
  const wins = { citizens: 0, mafia: 0 };
  for (let players = 6; players <= 12; players++) {
    for (let seed = 1; seed <= 150; seed++) {
      const { state, invalidMoves } = simulateGame({ seed: seed * 31 + players, players });
      assert.ok(state.winner, `seed ${seed} players ${players} had no winner`);
      assert.equal(invalidMoves, 0, `seed ${seed} players ${players}`);
      wins[state.winner] += 1;
      games += 1;
    }
  }
  assert.equal(games, 1050);
  assert.ok(wins.citizens > 0 && wins.mafia > 0, JSON.stringify(wins));
});

test('simulation: games still end when players keep missing phases', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const { state } = simulateGame({ seed, players: 6 + (seed % 7), skipChance: 0.4 });
    assert.ok(state.winner);
  }
});
