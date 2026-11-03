// SQLite storage (built into Node). Holds only short-lived game data, see the
// retention table in docs/DESIGN.md. purge() is what enforces it.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, status TEXT NOT NULL, host_seat_id TEXT,
  settings_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, nickname TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
  language TEXT NOT NULL, status TEXT NOT NULL, blocked_json TEXT NOT NULL DEFAULT '[]', joined_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS seats_room ON seats(room_id);
CREATE TABLE IF NOT EXISTS games (
  room_id TEXT PRIMARY KEY, phase TEXT NOT NULL, day INTEGER NOT NULL,
  phase_started_at INTEGER NOT NULL, phase_ends_at INTEGER NOT NULL, state_json TEXT NOT NULL, winner TEXT
);
CREATE TABLE IF NOT EXISTS game_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_room ON game_events(room_id);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, seat_id TEXT NOT NULL, channel TEXT NOT NULL,
  body TEXT NOT NULL, day INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_room ON chat_messages(room_id);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, room_id TEXT, seat_id TEXT NOT NULL, reported_seat_id TEXT NOT NULL, reason TEXT NOT NULL,
  snapshot_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, reviewed_at INTEGER
);
CREATE TABLE IF NOT EXISTS bans (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS totals (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
`;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const q = {
    upsertRoom: db.prepare(`INSERT INTO rooms (id, code, status, host_seat_id, settings_json, created_at, updated_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, host_seat_id = excluded.host_seat_id,
      settings_json = excluded.settings_json, updated_at = excluded.updated_at, ended_at = excluded.ended_at`),
    upsertSeat: db.prepare(`INSERT INTO seats (id, room_id, nickname, token_hash, language, status, blocked_json, joined_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, blocked_json = excluded.blocked_json,
      language = excluded.language`),
    upsertGame: db.prepare(`INSERT INTO games (room_id, phase, day, phase_started_at, phase_ends_at, state_json, winner)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET phase = excluded.phase, day = excluded.day,
      phase_started_at = excluded.phase_started_at, phase_ends_at = excluded.phase_ends_at, state_json = excluded.state_json,
      winner = excluded.winner`),
    deleteGame: db.prepare('DELETE FROM games WHERE room_id = ?'),
    roomSeats: db.prepare('SELECT id FROM seats WHERE room_id = ?'),
    deleteSeat: db.prepare('DELETE FROM seats WHERE id = ?'),
    addEvent: db.prepare('INSERT INTO game_events (room_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)'),
    addChat: db.prepare('INSERT INTO chat_messages (room_id, seat_id, channel, body, day, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    clearChat: db.prepare('DELETE FROM chat_messages WHERE room_id = ?'),
    clearEvents: db.prepare('DELETE FROM game_events WHERE room_id = ?'),
    rooms: db.prepare("SELECT * FROM rooms WHERE status != 'closed'"),
    seats: db.prepare('SELECT * FROM seats WHERE room_id = ? ORDER BY joined_at, rowid'),
    game: db.prepare('SELECT * FROM games WHERE room_id = ?'),
    chat: db.prepare('SELECT * FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT 200'),
    addReport: db.prepare(`INSERT INTO reports (id, room_id, seat_id, reported_seat_id, reason, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    reports: db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at'),
    report: db.prepare('SELECT * FROM reports WHERE id = ?'),
    resolveReport: db.prepare('UPDATE reports SET status = ?, reviewed_at = ? WHERE id = ?'),
    addBan: db.prepare('INSERT OR IGNORE INTO bans (token_hash, created_at) VALUES (?, ?)'),
    isBanned: db.prepare('SELECT 1 AS x FROM bans WHERE token_hash = ?'),
    bump: db.prepare('INSERT INTO totals (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value'),
    totals: db.prepare('SELECT key, value FROM totals'),
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  function deleteRoomRows(id) {
    for (const table of ['seats', 'games', 'game_events', 'chat_messages']) {
      db.prepare(`DELETE FROM ${table} WHERE room_id = ?`).run(id);
    }
    db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  }

  return {
    saveRoom(room, now = Date.now()) {
      tx(() => {
        q.upsertRoom.run(room.id, room.code, room.status, room.hostSeatId, JSON.stringify(room.settings), room.createdAt, now, room.endedAt ?? null);
        const keep = new Set();
        for (const seat of room.seats.values()) {
          keep.add(seat.id);
          q.upsertSeat.run(seat.id, room.id, seat.nickname, seat.tokenHash, seat.language, seat.status, JSON.stringify([...seat.blocked]), seat.joinedAt);
        }
        for (const row of q.roomSeats.all(room.id)) if (!keep.has(row.id)) q.deleteSeat.run(row.id);
        if (room.game) {
          const g = room.game;
          q.upsertGame.run(room.id, g.state.phase, g.state.day, g.phaseStartedAt, g.phaseEndsAt, JSON.stringify(g.state), g.state.winner);
        } else {
          q.deleteGame.run(room.id);
        }
      });
    },
    addChat(roomId, m) {
      return Number(q.addChat.run(roomId, m.seatId, m.channel, m.body, m.day ?? 0, m.at).lastInsertRowid);
    },
    addEvent(roomId, type, payload, now = Date.now()) {
      q.addEvent.run(roomId, type, JSON.stringify(payload), now);
    },
    clearRoomHistory(roomId) {
      q.clearChat.run(roomId);
      q.clearEvents.run(roomId);
    },
    loadRooms() {
      return q.rooms.all().map((r) => {
        const game = q.game.get(r.id);
        return {
          room: r,
          seats: q.seats.all(r.id),
          game: game ? { ...game, state: JSON.parse(game.state_json) } : null,
          chat: q.chat.all(r.id).reverse(),
        };
      });
    },
    deleteRoom: (id) => tx(() => deleteRoomRows(id)),
    addReport(r, now = Date.now()) {
      q.addReport.run(r.id, r.roomId, r.seatId, r.reportedSeatId, r.reason, JSON.stringify(r.snapshot), now);
    },
    listReports: (status = 'open') => q.reports.all(status).map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot_json) })),
    getReport: (id) => q.report.get(id) ?? null,
    resolveReport: (id, status, now = Date.now()) => q.resolveReport.run(status, now, id),
    addBan: (hash, now = Date.now()) => q.addBan.run(hash, now),
    isBanned: (hash) => Boolean(q.isBanned.get(hash)),
    bumpTotals(winner, playerCount) {
      tx(() => {
        q.bump.run('games_played', 1);
        q.bump.run(`wins_${winner}`, 1);
        q.bump.run('players_total', playerCount);
      });
    },
    totals: () => Object.fromEntries(q.totals.all().map((r) => [r.key, r.value])),

    // Enforces the retention table: rooms 24h after the game ends (or after the
    // last activity if it never ended), reviewed reports 30 days, open reports 60 days,
    // bans 90 days.
    purge(now, { roomRetentionHours = 24, reportRetentionDays = 30, openReportMaxDays = 60, banRetentionDays = 90 } = {}) {
      const roomCut = now - roomRetentionHours * HOUR;
      const stale = db.prepare('SELECT id FROM rooms WHERE (ended_at IS NOT NULL AND ended_at < ?) OR (ended_at IS NULL AND updated_at < ?)').all(roomCut, roomCut);
      const removedRooms = tx(() => {
        for (const r of stale) deleteRoomRows(r.id);
        return stale.map((r) => r.id);
      });
      const reviewed = db.prepare("DELETE FROM reports WHERE status != 'open' AND reviewed_at < ?").run(now - reportRetentionDays * DAY);
      const open = db.prepare("DELETE FROM reports WHERE status = 'open' AND created_at < ?").run(now - openReportMaxDays * DAY);
      const bans = db.prepare('DELETE FROM bans WHERE created_at < ?').run(now - banRetentionDays * DAY);
      return { rooms: removedRooms, reports: Number(reviewed.changes) + Number(open.changes), bans: Number(bans.changes) };
    },
    countRows(table) {
      return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    },
    close: () => db.close(),
  };
}
