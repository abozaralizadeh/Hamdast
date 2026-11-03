// The view filter. Every message a player receives is built here, from the
// full game state, and holds only what that player is allowed to see.
// Nothing else in the server sends game state to a client.
import { isMafiaTeam, ROLES } from '../engine/rules.js';

function actionFor(state, me) {
  if (!me.alive || state.phase === 'over') return null;
  const alive = state.players.filter((p) => p.alive);
  if (state.phase === 'night') {
    if (state.intro) return { kind: 'wait' };
    const godfatherAlive = alive.some((p) => p.role === ROLES.GODFATHER);
    if (me.role === ROLES.GODFATHER || (me.role === ROLES.MAFIA && !godfatherAlive)) {
      return {
        kind: 'kill',
        options: alive.filter((p) => !isMafiaTeam(p.role)).map((p) => p.id),
        selected: state.night.killVotes[me.id] ?? null,
      };
    }
    if (me.role === ROLES.DOCTOR) {
      return {
        kind: 'save',
        options: alive.filter((p) => p.id !== me.id || !state.doctorSelfUsed).map((p) => p.id),
        selected: state.night.save,
      };
    }
    if (me.role === ROLES.DETECTIVE) {
      return { kind: 'check', options: alive.filter((p) => p.id !== me.id).map((p) => p.id), selected: state.night.check };
    }
    return { kind: 'wait' };
  }
  if (state.phase === 'day') return { kind: 'ready', selected: Boolean(state.ready[me.id]) };
  if (state.phase === 'vote') {
    const voted = me.id in state.votes;
    return { kind: 'vote', options: alive.filter((p) => p.id !== me.id).map((p) => p.id), voted, selected: voted ? state.votes[me.id] : null };
  }
  return null;
}

function chatVisible(room, seat, mySeatRole, over) {
  return room.chat.filter((m) => {
    if (seat.blocked.has(m.seatId)) return false;
    if (m.channel === 'public') return true;
    return over || isMafiaTeam(mySeatRole);
  });
}

export function buildView(room, seatId, ctx) {
  const seat = room.seats.get(seatId);
  const game = room.game;
  const state = game?.state ?? null;
  const me = state?.players.find((p) => p.id === seatId) ?? null;
  const over = state?.phase === 'over';
  const myTeam = me && isMafiaTeam(me.role);

  const players = [];
  for (const s of room.seats.values()) {
    if (!state && (s.status === 'left' || s.status === 'removed')) continue;
    const p = state?.players.find((x) => x.id === s.id);
    const entry = {
      seatId: s.id,
      nickname: s.nickname,
      away: !s.connections && s.status === 'active',
      left: s.status === 'left',
      blocked: seat.blocked.has(s.id),
      alive: p ? p.alive : true,
      absent: p ? p.absent : false,
    };
    // A role is shown to its owner, to the owner's Mafia teammates, and to everyone at the end.
    if (p && (over || s.id === seatId || (myTeam && isMafiaTeam(p.role)))) entry.role = p.role;
    players.push(entry);
  }

  const view = {
    now: ctx.now,
    room: {
      code: room.code,
      status: room.status,
      hostSeatId: room.hostSeatId,
      settings: room.settings,
      minPlayers: ctx.config.minPlayers,
      maxPlayers: ctx.config.maxPlayers,
    },
    you: {
      seatId,
      nickname: seat.nickname,
      isHost: room.hostSeatId === seatId,
      role: me?.role ?? null,
      alive: me ? me.alive : true,
      action: state && me ? actionFor(state, me) : null,
      checks: state && me ? state.checks.filter((c) => c.by === me.id) : [],
    },
    players,
    game: state
      ? {
        phase: state.phase,
        intro: state.intro,
        day: state.day,
        phaseEndsAt: state.phase === 'over' ? null : game.phaseEndsAt,
        history: state.history,
        winner: state.winner,
        // Counts are shown for day and vote only. A night count would show which roles are still alive.
        progress: state.phase === 'vote'
          ? { done: Object.keys(state.votes).length, total: state.players.filter((p) => p.alive).length }
          : state.phase === 'day'
            ? { done: Object.keys(state.ready).length, total: state.players.filter((p) => p.alive).length }
            : null,
      }
      : null,
    chat: chatVisible(room, seat, me?.role, over).map((m) => ({ id: m.id, seatId: m.seatId, channel: m.channel, body: m.body, at: m.at })),
    voice: {
      enabled: ctx.voice.enabled,
      provider: ctx.voice.name,
      mode: room.speaker?.mode ?? 'open',
      speakerSeatId: room.speaker?.speakerId ?? null,
      turnEndsAt: room.speaker?.turnEndsAt ?? null,
      canSpeak: (room.speaker?.allowed ?? []).includes(seatId),
    },
  };
  return view;
}
