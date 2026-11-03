// Pure rules engine. No network, database, clock or randomness of its own:
// the caller passes in a random function, and every call returns a new state.
// Rule numbers here are the v0.1 set described in docs/RULES.md.

export const ROLES = Object.freeze({
  CITIZEN: 'citizen',
  DOCTOR: 'doctor',
  DETECTIVE: 'detective',
  MAFIA: 'mafia',
  GODFATHER: 'godfather',
});

// Mafia side size (Godfather included) by player count.
export const MAFIA_COUNT = Object.freeze({ 6: 2, 7: 2, 8: 2, 9: 3, 10: 3, 11: 3, 12: 4 });
export const MIN_PLAYERS = 6;
export const MAX_PLAYERS = 12;

// A player who misses this many phases in a row is marked absent.
export const MISSED_LIMIT = 2;

export const DEFAULT_SETTINGS = Object.freeze({
  introMs: 20000,
  dayMs: 180000,
  voteMs: 45000,
  nightMs: 45000,
  nightEarlyEnd: false,
});

export const isMafiaTeam = (role) => role === ROLES.MAFIA || role === ROLES.GODFATHER;

export function roleList(count) {
  if (!Number.isInteger(count) || count < MIN_PLAYERS || count > MAX_PLAYERS) {
    throw new RangeError(`Mafia needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players, got ${count}`);
  }
  const mafiaSide = MAFIA_COUNT[count];
  const roles = [ROLES.GODFATHER];
  for (let i = 1; i < mafiaSide; i++) roles.push(ROLES.MAFIA);
  roles.push(ROLES.DOCTOR, ROLES.DETECTIVE);
  while (roles.length < count) roles.push(ROLES.CITIZEN);
  return roles;
}

// Fisher-Yates. rng() returns a number in [0, 1).
export function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const fail = (error) => ({ ok: false, error });
const clone = (state) => structuredClone(state);
const find = (state, id) => state.players.find((p) => p.id === id);
const aliveOf = (state) => state.players.filter((p) => p.alive);
const freshNight = () => ({ killVotes: {}, save: null, check: null });

export function createGame({ playerIds, rng, settings = {} }) {
  if (new Set(playerIds).size !== playerIds.length) throw new Error('duplicate player ids');
  const roles = shuffle(roleList(playerIds.length), rng);
  return {
    phase: 'night',
    intro: true,
    day: 0,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    players: playerIds.map((id, i) => ({ id, role: roles[i], alive: true, missed: 0, absent: false })),
    night: freshNight(),
    ready: {},
    votes: {},
    checks: [],
    doctorSelfUsed: false,
    history: [],
    winner: null,
  };
}

export function phaseMs(state) {
  const s = state.settings;
  if (state.phase === 'night') return state.intro ? s.introMs : s.nightMs;
  if (state.phase === 'day') return s.dayMs;
  if (state.phase === 'vote') return s.voteMs;
  return 0;
}

export function checkWinner(state) {
  const alive = aliveOf(state);
  const mafia = alive.filter((p) => isMafiaTeam(p.role)).length;
  if (mafia === 0) return 'citizens';
  if (mafia >= alive.length - mafia) return 'mafia';
  return null;
}

function godfatherAlive(state) {
  return state.players.some((p) => p.alive && p.role === ROLES.GODFATHER);
}

// Who decides the kill tonight: the Godfather, or the remaining Mafia once he is gone.
function killDeciders(state) {
  const gf = state.players.find((p) => p.alive && p.role === ROLES.GODFATHER);
  if (gf) return [gf];
  return state.players.filter((p) => p.alive && p.role === ROLES.MAFIA);
}

export function act(state, playerId, action) {
  if (state.phase === 'over') return fail('game_over');
  const me = find(state, playerId);
  if (!me) return fail('not_in_game');
  if (!me.alive) return fail('dead');
  const next = clone(state);
  const self = find(next, playerId);

  switch (action?.type) {
    case 'night': {
      if (state.phase !== 'night') return fail('wrong_phase');
      if (state.intro) return fail('intro_night');
      const target = find(next, action.target);
      if (!target || !target.alive) return fail('bad_target');
      switch (self.role) {
        case ROLES.GODFATHER:
        case ROLES.MAFIA:
          if (self.role === ROLES.MAFIA && godfatherAlive(state)) return fail('no_action');
          if (isMafiaTeam(target.role)) return fail('bad_target');
          next.night.killVotes[self.id] = target.id;
          break;
        case ROLES.DOCTOR:
          if (target.id === self.id && state.doctorSelfUsed) return fail('self_save_used');
          next.night.save = target.id;
          break;
        case ROLES.DETECTIVE:
          if (target.id === self.id) return fail('bad_target');
          next.night.check = target.id;
          break;
        default:
          return fail('no_action');
      }
      return { ok: true, state: next };
    }
    case 'vote': {
      if (state.phase !== 'vote') return fail('wrong_phase');
      if (self.id in next.votes) return fail('already_voted');
      if (action.target === null || action.target === undefined) {
        next.votes[self.id] = null;
      } else {
        const target = find(next, action.target);
        if (!target || !target.alive || target.id === self.id) return fail('bad_target');
        next.votes[self.id] = target.id;
      }
      return { ok: true, state: next };
    }
    case 'ready': {
      if (state.phase !== 'day') return fail('wrong_phase');
      next.ready[self.id] = true;
      return { ok: true, state: next };
    }
    default:
      return fail('bad_action');
  }
}

// Players the phase is waiting on. Absent players are never waited for.
function requiredNightActors(state) {
  const need = [];
  for (const p of state.players) {
    if (!p.alive) continue;
    if (p.role === ROLES.DOCTOR || p.role === ROLES.DETECTIVE) need.push(p);
  }
  return need;
}

function nightActed(state, p) {
  if (p.role === ROLES.DOCTOR) return state.night.save !== null;
  if (p.role === ROLES.DETECTIVE) return state.night.check !== null;
  return p.id in state.night.killVotes;
}

// True when every player the phase waits on has acted. A phase with nobody to
// wait for never completes early, so a room of absent players cannot race ahead.
export function isComplete(state) {
  if (state.phase === 'day') {
    const need = aliveOf(state).filter((p) => !p.absent);
    return need.length > 0 && need.every((p) => state.ready[p.id]);
  }
  if (state.phase === 'vote') {
    const need = aliveOf(state).filter((p) => !p.absent);
    return need.length > 0 && need.every((p) => p.id in state.votes);
  }
  if (state.phase === 'night' && !state.intro && state.settings.nightEarlyEnd) {
    const singles = requiredNightActors(state).filter((p) => !p.absent);
    const deciders = killDeciders(state).filter((p) => !p.absent);
    const everyone = [...singles, ...deciders.slice(0, 1)];
    if (everyone.length === 0) return false;
    const killDone = deciders.length === 0 || deciders.some((p) => nightActed(state, p));
    return killDone && singles.every((p) => nightActed(state, p));
  }
  return false;
}

export function markAbsent(state, playerId) {
  const next = clone(state);
  const p = find(next, playerId);
  if (p) p.absent = true;
  return next;
}

function recordAttendance(next, acted, required) {
  for (const p of required) {
    if (acted(p)) {
      p.missed = 0;
      p.absent = false;
    } else if (!p.absent) {
      p.missed += 1;
      if (p.missed >= MISSED_LIMIT) p.absent = true;
    }
  }
}

function finishOrContinue(next, events, onContinue) {
  const winner = checkWinner(next);
  if (winner) {
    next.winner = winner;
    next.phase = 'over';
    const ev = { type: 'game_over', winner };
    next.history.push(ev);
    events.push(ev);
  } else {
    onContinue();
  }
}

// Move to the next phase because the timer ended or everyone has acted.
export function advance(state) {
  if (state.phase === 'over') return { state, events: [] };
  const next = clone(state);
  const events = [];

  if (state.phase === 'night' && state.intro) {
    next.intro = false;
    next.phase = 'day';
    next.day = 1;
    next.ready = {};
    return { state: next, events };
  }

  if (state.phase === 'night') {
    const n = next.night;
    const deciders = killDeciders(next);
    const decider = next.players.find((p) => p.alive && p.role === ROLES.GODFATHER)
      ?? deciders.find((p) => p.id in n.killVotes);
    const killTarget = decider ? n.killVotes[decider.id] ?? null : null;
    const killed = killTarget && killTarget !== n.save ? killTarget : null;

    const doctor = next.players.find((p) => p.alive && p.role === ROLES.DOCTOR);
    if (doctor && n.save === doctor.id) next.doctorSelfUsed = true;

    const detective = next.players.find((p) => p.alive && p.role === ROLES.DETECTIVE);
    if (detective && n.check) {
      const target = find(next, n.check);
      next.checks.push({ by: detective.id, target: target.id, isMafia: target.role === ROLES.MAFIA, day: state.day });
    }

    const required = [...requiredNightActors(next)];
    const anyDecider = deciders.some((p) => nightActed(next, p));
    for (const p of deciders) {
      if (deciders.length === 1 || !anyDecider) required.push(p);
    }
    recordAttendance(next, (p) => nightActed(next, p), required);

    if (killed) find(next, killed).alive = false;
    next.night = freshNight();
    const ev = { type: 'night_result', day: state.day + 1, killed };
    next.history.push(ev);
    events.push(ev);
    finishOrContinue(next, events, () => {
      next.phase = 'day';
      next.day = state.day + 1;
      next.ready = {};
    });
    return { state: next, events };
  }

  if (state.phase === 'day') {
    next.phase = 'vote';
    next.votes = {};
    return { state: next, events };
  }

  // vote
  const tally = {};
  let skips = 0;
  const votes = [];
  for (const p of next.players) {
    if (!p.alive || !(p.id in next.votes)) continue;
    const to = next.votes[p.id];
    votes.push({ from: p.id, to });
    if (to === null) skips += 1;
    else tally[to] = (tally[to] ?? 0) + 1;
  }
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  let eliminated = null;
  if (ranked.length > 0) {
    const [topId, topCount] = ranked[0];
    const tied = ranked.length > 1 && ranked[1][1] === topCount;
    if (!tied && topCount > skips) eliminated = topId;
  }
  recordAttendance(next, (p) => p.id in next.votes, aliveOf(next));
  if (eliminated) find(next, eliminated).alive = false;
  const ev = { type: 'vote_result', day: state.day, votes, eliminated };
  next.history.push(ev);
  events.push(ev);
  next.votes = {};
  finishOrContinue(next, events, () => {
    next.phase = 'night';
    next.night = freshNight();
  });
  return { state: next, events };
}
