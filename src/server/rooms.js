// Rooms, seats, timers, chat and safety tools. The rules themselves live in
// ../engine/rules.js; this file only decides who may do what and when.
import crypto from 'node:crypto';
import * as engine from '../engine/rules.js';
import { buildView } from './view.js';
import { checkNickname } from './nickname.js';
import { voicePolicy } from '../voice/policy.js';
import { LIMITS } from './ratelimit.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REPORT_REASONS = new Set(['abuse', 'cheating', 'spam', 'other']);
const MAX_CHAT_IN_MEMORY = 200;
const MAX_CHAT_LENGTH = 300;

const fail = (error, status = 400) => ({ ok: false, error, status });
const LOBBY_COUNT_MS = 2 * 60 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const defaultRng = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;

export class RoomManager {
  constructor({ config, store, logger, voice, limiter, rng = defaultRng, now = Date.now, blockedWords = [], timers = globalThis }) {
    Object.assign(this, { config, store, logger, voice, limiter, rng, now, blockedWords, timers });
    this.rooms = new Map(); // room id -> room
    this.byCode = new Map(); // code -> room
    this.bySeat = new Map(); // seat id -> room
    this.byToken = new Map(); // token hash -> seat id
    this.listeners = new Map(); // seat id -> Set<{ send, close }>
    this.gameTimers = new Map(); // room id -> timer
    this.voiceTimers = new Map(); // room id -> timer
  }

  // ---------- lookups ----------

  authenticate(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    const hash = sha256(token);
    const seatId = this.byToken.get(hash);
    const room = seatId ? this.bySeat.get(seatId) : null;
    const seat = room?.seats.get(seatId);
    if (!seat || seat.status !== 'active' || this.store.isBanned(hash)) return null;
    return { room, seat };
  }

  #ctx() {
    return { now: this.now(), config: this.config, voice: this.voice };
  }

  viewOf(seatId) {
    const room = this.bySeat.get(seatId);
    return room ? buildView(room, seatId, this.#ctx()) : null;
  }

  // ---------- joining ----------

  #newCode() {
    for (let i = 0; i < 50; i++) {
      let code = '';
      for (let j = 0; j < 6; j++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.byCode.has(code)) return code;
    }
    throw new Error('could not make a room code');
  }

  #addSeat(room, nickname, language) {
    const token = crypto.randomBytes(24).toString('base64url');
    const seat = {
      id: crypto.randomUUID(),
      nickname,
      tokenHash: sha256(token),
      language: language === 'en' ? 'en' : 'fa',
      status: 'active',
      blocked: new Set(),
      joinedAt: this.now(),
      connections: 0,
    };
    room.seats.set(seat.id, seat);
    this.bySeat.set(seat.id, room);
    this.byToken.set(seat.tokenHash, seat.id);
    return { seat, token };
  }

  // owner is the creator's address. It stays in memory to cap rooms per address and is never stored or logged.
  createRoom({ nickname, language, confirmed }, { owner = null } = {}) {
    if (confirmed !== true) return fail('not_confirmed');
    const nick = checkNickname(nickname, { blockedWords: this.blockedWords });
    if (!nick.ok) return fail(nick.error);
    // A game in play counts, and so does a lobby for its first two hours. Older lobbies were
    // most likely left in a closed tab, so they don't lock their creator out.
    const t = this.now();
    const open = [...this.rooms.values()].filter((r) => r.status === 'playing' || (r.status === 'lobby' && t - r.createdAt < LOBBY_COUNT_MS));
    if (open.length >= this.config.maxOpenRooms) return fail('server_busy', 503);
    if (owner && open.filter((r) => r.owner === owner).length >= this.config.maxRoomsPerIp) return fail('too_many_rooms', 429);
    const room = {
      id: crypto.randomUUID(),
      code: this.#newCode(),
      status: 'lobby',
      hostSeatId: null,
      settings: { ...this.config.timers },
      createdAt: this.now(),
      endedAt: null,
      seats: new Map(),
      game: null,
      chat: [],
      speaker: null,
      owner,
    };
    const { seat, token } = this.#addSeat(room, nick.nickname, language);
    room.hostSeatId = seat.id;
    this.rooms.set(room.id, room);
    this.byCode.set(room.code, room);
    this.store.saveRoom(room, this.now());
    this.logger.info('room_created', { roomId: room.id });
    return { ok: true, code: room.code, token, seatId: seat.id };
  }

  joinRoom(code, { nickname, language, confirmed }) {
    if (confirmed !== true) return fail('not_confirmed');
    const room = this.byCode.get(String(code ?? '').toUpperCase());
    if (!room) return fail('room_not_found', 404);
    if (room.status !== 'lobby') return fail('game_started', 409);
    const active = [...room.seats.values()].filter((s) => s.status === 'active');
    if (active.length >= this.config.maxPlayers) return fail('room_full', 409);
    const nick = checkNickname(nickname, { taken: active.map((s) => s.nickname), blockedWords: this.blockedWords });
    if (!nick.ok) return fail(nick.error);
    const { seat, token } = this.#addSeat(room, nick.nickname, language);
    this.#save(room);
    this.logger.info('player_joined', { roomId: room.id, seatId: seat.id });
    this.#broadcast(room);
    return { ok: true, code: room.code, token, seatId: seat.id };
  }

  // ---------- live connections ----------

  subscribe(seatId, listener) {
    const room = this.bySeat.get(seatId);
    if (!room) return null;
    const seat = room.seats.get(seatId);
    if (!this.listeners.has(seatId)) this.listeners.set(seatId, new Set());
    this.listeners.get(seatId).add(listener);
    seat.connections += 1;
    listener.send(buildView(room, seatId, this.#ctx()));
    this.#broadcast(room, seatId);
    return () => {
      this.listeners.get(seatId)?.delete(listener);
      seat.connections = Math.max(0, seat.connections - 1);
      if (this.bySeat.get(seatId) === room) this.#broadcast(room);
    };
  }

  #broadcast(room, exceptSeatId = null) {
    const ctx = this.#ctx();
    for (const seat of room.seats.values()) {
      if (seat.id === exceptSeatId) continue;
      const set = this.listeners.get(seat.id);
      if (!set?.size) continue;
      const view = buildView(room, seat.id, ctx);
      for (const l of set) l.send(view);
    }
  }

  #save(room) {
    this.store.saveRoom(room, this.now());
  }

  // ---------- leaving, host tools ----------

  #passHost(room) {
    if (room.seats.get(room.hostSeatId)?.status === 'active') return;
    const next = [...room.seats.values()].find((s) => s.status === 'active');
    room.hostSeatId = next ? next.id : null;
  }

  #dropSeatAccess(seat, closeConnections = true) {
    this.byToken.delete(seat.tokenHash);
    if (closeConnections) {
      for (const l of this.listeners.get(seat.id) ?? []) l.close?.();
      this.listeners.delete(seat.id);
    }
  }

  #removeSeat(room, seat, status) {
    seat.status = status;
    this.#dropSeatAccess(seat);
    if (room.game && room.game.state.phase !== 'over') {
      room.game.state = engine.markAbsent(room.game.state, seat.id);
    }
    this.#passHost(room);
    if (![...room.seats.values()].some((s) => s.status === 'active')) {
      this.#closeRoom(room);
      return;
    }
    this.#save(room);
    if (room.game && room.game.state.phase !== 'over' && engine.isComplete(room.game.state)) {
      this.#advance(room);
      return;
    }
    this.#broadcast(room);
  }

  leave(seatId) {
    const room = this.bySeat.get(seatId);
    if (!room) return fail('not_found', 404);
    this.#removeSeat(room, room.seats.get(seatId), 'left');
    this.logger.info('player_left', { roomId: room.id, seatId });
    return { ok: true };
  }

  kick(hostSeatId, targetSeatId) {
    const room = this.bySeat.get(hostSeatId);
    if (!room || room.hostSeatId !== hostSeatId) return fail('forbidden', 403);
    if (room.status !== 'lobby') return fail('game_started', 409);
    const target = room.seats.get(targetSeatId);
    if (!target || target.status !== 'active' || target.id === hostSeatId) return fail('bad_target');
    this.#removeSeat(room, target, 'removed');
    return { ok: true };
  }

  updateSettings(seatId, input) {
    const room = this.bySeat.get(seatId);
    if (!room || room.hostSeatId !== seatId) return fail('forbidden', 403);
    if (room.status !== 'lobby') return fail('game_started', 409);
    const next = { ...room.settings };
    for (const key of ['dayMs', 'voteMs', 'nightMs']) {
      if (input?.[key] === undefined) continue;
      const v = input[key];
      if (!Number.isInteger(v) || v < this.config.minPhaseMs || v > this.config.maxPhaseMs) return fail('bad_settings');
      next[key] = v;
    }
    room.settings = next;
    this.#save(room);
    this.#broadcast(room);
    return { ok: true };
  }

  // ---------- the game ----------

  startGame(seatId) {
    const room = this.bySeat.get(seatId);
    if (!room || room.hostSeatId !== seatId) return fail('forbidden', 403);
    if (room.status !== 'lobby') return fail('game_started', 409);
    const active = [...room.seats.values()].filter((s) => s.status === 'active');
    if (active.length < this.config.minPlayers || active.length > this.config.maxPlayers) return fail('bad_player_count');
    const state = engine.createGame({ playerIds: active.map((s) => s.id), rng: this.rng, settings: room.settings });
    const t = this.now();
    room.game = { state, phaseStartedAt: t, phaseEndsAt: t + engine.phaseMs(state) };
    room.status = 'playing';
    room.chat = [];
    this.store.clearRoomHistory(room.id);
    this.voice.openRoom(room.id);
    this.#save(room);
    this.#armTimer(room);
    this.#applyVoice(room);
    this.logger.info('game_started', { roomId: room.id, players: active.length });
    this.#broadcast(room);
    return { ok: true };
  }

  act(seatId, action) {
    const room = this.bySeat.get(seatId);
    if (!room?.game) return fail('no_game', 409);
    const res = engine.act(room.game.state, seatId, action);
    if (!res.ok) return fail(res.error);
    room.game.state = res.state;
    this.#save(room);
    if (engine.isComplete(res.state)) this.#advance(room);
    else this.#broadcast(room);
    return { ok: true };
  }

  #advance(room) {
    const { state, events } = engine.advance(room.game.state);
    const t = this.now();
    room.game.state = state;
    for (const ev of events) this.store.addEvent(room.id, ev.type, ev, t);
    if (state.phase === 'over') {
      room.status = 'over';
      room.endedAt = t;
      room.game.phaseEndsAt = t;
      this.store.bumpTotals(state.winner, state.players.length);
      this.logger.info('game_over', { roomId: room.id, winner: state.winner, days: state.day });
    } else {
      room.game.phaseStartedAt = t;
      room.game.phaseEndsAt = t + engine.phaseMs(state);
    }
    this.#save(room);
    this.#armTimer(room);
    this.#applyVoice(room);
    this.#broadcast(room);
  }

  #armTimer(room) {
    clearTimeout(this.gameTimers.get(room.id));
    this.gameTimers.delete(room.id);
    if (!room.game || room.game.state.phase === 'over') return;
    const delay = Math.max(0, room.game.phaseEndsAt - this.now());
    const handle = this.timers.setTimeout(() => {
      if (this.rooms.has(room.id) && room.game?.state.phase !== 'over') this.#advance(room);
    }, delay);
    handle.unref?.();
    this.gameTimers.set(room.id, handle);
  }

  rematch(seatId) {
    const room = this.bySeat.get(seatId);
    if (!room || room.hostSeatId !== seatId) return fail('forbidden', 403);
    if (room.status !== 'over') return fail('not_over', 409);
    for (const seat of [...room.seats.values()]) {
      if (seat.status !== 'active') room.seats.delete(seat.id);
    }
    room.game = null;
    room.status = 'lobby';
    room.endedAt = null;
    room.chat = [];
    room.speaker = null;
    this.store.clearRoomHistory(room.id);
    this.#save(room);
    this.#applyVoice(room);
    this.#broadcast(room);
    return { ok: true };
  }

  // ---------- chat ----------

  sendChat(seatId, channel, text) {
    const room = this.bySeat.get(seatId);
    if (!room) return fail('not_found', 404);
    const body = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!body || body.length > MAX_CHAT_LENGTH) return fail('bad_message');
    if (!this.limiter.allow(`chat:${seatId}`, LIMITS.chat)) return fail('rate_limited', 429);
    const state = room.game?.state;
    const me = state?.players.find((p) => p.id === seatId);
    if (channel === 'public') {
      const open = !state || state.phase === 'over' || (state.phase === 'day' && me?.alive);
      if (!open) return fail('chat_closed', 403);
    } else if (channel === 'mafia') {
      const allowed = state?.phase === 'night' && me?.alive && engine.isMafiaTeam(me.role);
      if (!allowed) return fail('chat_closed', 403);
    } else {
      return fail('bad_channel');
    }
    const message = { seatId, channel, body, at: this.now(), day: state?.day ?? 0 };
    message.id = this.store.addChat(room.id, message);
    room.chat.push(message);
    if (room.chat.length > MAX_CHAT_IN_MEMORY) room.chat.shift();
    this.#broadcast(room);
    return { ok: true };
  }

  // ---------- safety ----------

  block(seatId, targetSeatId) {
    const room = this.bySeat.get(seatId);
    if (!room) return fail('not_found', 404);
    if (seatId === targetSeatId || !room.seats.has(targetSeatId)) return fail('bad_target');
    room.seats.get(seatId).blocked.add(targetSeatId);
    this.#save(room);
    this.#broadcast(room);
    return { ok: true };
  }

  report(seatId, targetSeatId, reason) {
    const room = this.bySeat.get(seatId);
    if (!room) return fail('not_found', 404);
    if (seatId === targetSeatId || !room.seats.has(targetSeatId) || !REPORT_REASONS.has(reason)) return fail('bad_target');
    const target = room.seats.get(targetSeatId);
    const id = crypto.randomUUID();
    // The snapshot keeps recent public chat so a report can be judged after the chat itself is gone.
    const recent = room.chat.filter((m) => m.channel === 'public').slice(-20).map((m) => ({
      from: room.seats.get(m.seatId)?.nickname ?? '?',
      body: m.body,
      at: m.at,
    }));
    this.store.addReport({
      id,
      roomId: room.id,
      seatId,
      reportedSeatId: targetSeatId,
      reason,
      snapshot: { roomCode: room.code, reported: target.nickname, recent },
    }, this.now());
    this.logger.info('report_filed', { roomId: room.id, reportId: id, reason });
    return { ok: true };
  }

  listReports() {
    return this.store.listReports('open');
  }

  resolveReport(id, action) {
    const report = this.store.getReport(id);
    if (!report || report.status !== 'open') return fail('not_found', 404);
    if (action === 'ban') {
      const room = this.bySeat.get(report.reported_seat_id);
      const seat = room?.seats.get(report.reported_seat_id);
      if (seat) {
        this.store.addBan(seat.tokenHash, this.now());
        this.#removeSeat(room, seat, 'removed');
      }
      this.store.resolveReport(id, 'actioned', this.now());
    } else if (action === 'dismiss') {
      this.store.resolveReport(id, 'dismissed', this.now());
    } else {
      return fail('bad_action');
    }
    return { ok: true };
  }

  // ---------- voice ----------

  voiceToken(seatId) {
    if (!this.voice.enabled) return fail('voice_off', 404);
    const room = this.bySeat.get(seatId);
    if (!room) return fail('not_found', 404);
    return { ok: true, ...this.voice.tokenFor(room.id, seatId) };
  }

  #applyVoice(room) {
    clearTimeout(this.voiceTimers.get(room.id));
    this.voiceTimers.delete(room.id);
    if (!this.voice.enabled) return;
    const t = this.now();
    const active = [...room.seats.values()].filter((s) => s.status === 'active').map((s) => s.id);
    const policy = voicePolicy({
      state: room.game?.state,
      activeSeatIds: active,
      startedAt: room.game?.phaseStartedAt ?? t,
      speakMs: this.config.speakMs,
      now: t,
    });
    room.speaker = policy;
    this.voice.setSpeakers(room.id, policy.allowed);
    if (policy.mode === 'turn') {
      const handle = this.timers.setTimeout(() => {
        if (!this.rooms.has(room.id)) return;
        this.#applyVoice(room);
        this.#broadcast(room);
      }, Math.max(0, policy.turnEndsAt - t) + 5);
      handle.unref?.();
      this.voiceTimers.set(room.id, handle);
    }
  }

  // ---------- lifetime ----------

  #closeRoom(room) {
    clearTimeout(this.gameTimers.get(room.id));
    clearTimeout(this.voiceTimers.get(room.id));
    this.gameTimers.delete(room.id);
    this.voiceTimers.delete(room.id);
    this.voice.closeRoom(room.id);
    for (const seat of room.seats.values()) {
      this.#dropSeatAccess(seat);
      this.bySeat.delete(seat.id);
    }
    this.rooms.delete(room.id);
    this.byCode.delete(room.code);
    this.store.deleteRoom(room.id);
  }

  // Deletes rooms past the retention window, and old reports.
  maintenance() {
    const result = this.store.purge(this.now(), this.config);
    for (const id of result.rooms) {
      const room = this.rooms.get(id);
      if (room) {
        for (const seat of room.seats.values()) this.bySeat.delete(seat.id);
        for (const seat of room.seats.values()) this.#dropSeatAccess(seat);
        clearTimeout(this.gameTimers.get(id));
        clearTimeout(this.voiceTimers.get(id));
        this.voice.closeRoom(id);
        this.rooms.delete(id);
        this.byCode.delete(room.code);
      }
    }
    this.limiter.sweep();
    if (result.rooms.length || result.reports) this.logger.info('purged', { rooms: result.rooms.length, reports: result.reports });
    return result;
  }

  // Rebuilds rooms from the database after a restart and resumes their timers.
  restore() {
    let restored = 0;
    for (const { room: r, seats, game, chat } of this.store.loadRooms()) {
      const room = {
        id: r.id,
        code: r.code,
        status: r.status,
        hostSeatId: r.host_seat_id,
        settings: JSON.parse(r.settings_json),
        createdAt: r.created_at,
        endedAt: r.ended_at,
        seats: new Map(),
        game: game ? { state: game.state, phaseStartedAt: game.phase_started_at, phaseEndsAt: game.phase_ends_at } : null,
        chat: chat.map((m) => ({ id: m.id, seatId: m.seat_id, channel: m.channel, body: m.body, at: m.created_at, day: m.day })),
        speaker: null,
      };
      for (const s of seats) {
        room.seats.set(s.id, {
          id: s.id,
          nickname: s.nickname,
          tokenHash: s.token_hash,
          language: s.language,
          status: s.status,
          blocked: new Set(JSON.parse(s.blocked_json)),
          joinedAt: s.joined_at,
          connections: 0,
        });
        this.bySeat.set(s.id, room);
        if (s.status === 'active') this.byToken.set(s.token_hash, s.id);
      }
      this.rooms.set(room.id, room);
      this.byCode.set(room.code, room);
      if (room.game && room.game.state.phase !== 'over') {
        this.voice.openRoom(room.id);
        this.#armTimer(room);
        this.#applyVoice(room);
      }
      restored += 1;
    }
    if (restored) this.logger.info('rooms_restored', { count: restored });
    return restored;
  }

  shutdown() {
    for (const h of this.gameTimers.values()) clearTimeout(h);
    for (const h of this.voiceTimers.values()) clearTimeout(h);
    this.gameTimers.clear();
    this.voiceTimers.clear();
    for (const set of this.listeners.values()) for (const l of set) l.close?.();
    this.listeners.clear();
  }
}
