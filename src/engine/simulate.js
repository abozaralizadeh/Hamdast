// Plays whole games with random legal moves. Used by the tests and by
// scripts/simulate.js to check that every game ends and nothing breaks.
import * as engine from './rules.js';

// Small seeded random generator so a failing game can be replayed.
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (items, rng) => items[Math.floor(rng() * items.length)];

function randomAction(state, player, rng) {
  const alive = state.players.filter((p) => p.alive);
  if (state.phase === 'day') return { type: 'ready' };
  if (state.phase === 'vote') {
    const others = alive.filter((p) => p.id !== player.id);
    return { type: 'vote', target: rng() < 0.15 ? null : pick(others, rng).id };
  }
  const options = alive.filter((p) => {
    if (player.role === engine.ROLES.DETECTIVE) return p.id !== player.id;
    if (engine.isMafiaTeam(player.role)) return !engine.isMafiaTeam(p.role);
    return true;
  });
  return { type: 'night', target: pick(options, rng).id };
}

// Returns { state, phases, invalidMoves }. skipChance makes players miss phases.
export function simulateGame({ seed, players = 8, skipChance = 0, settings = {}, maxPhases = 400 }) {
  const rng = seededRng(seed);
  const ids = Array.from({ length: players }, (_, i) => `p${i + 1}`);
  let state = engine.createGame({ playerIds: ids, rng, settings });
  let phases = 0;
  let invalidMoves = 0;
  while (state.phase !== 'over') {
    if (++phases > maxPhases) throw new Error(`seed ${seed}: game did not end`);
    for (const p of state.players) {
      if (!p.alive || rng() < skipChance) continue;
      const res = engine.act(state, p.id, randomAction(state, p, rng));
      if (res.ok) state = res.state;
      else if (res.error !== 'no_action' && res.error !== 'intro_night' && res.error !== 'self_save_used') invalidMoves += 1;
    }
    state = engine.advance(state).state;
  }
  return { state, phases, invalidMoves };
}
