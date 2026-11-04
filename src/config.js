// All settings live here, read from the environment, so the default rules and
// timers are easy to change. See .env.example for every name.
import { MIN_PLAYERS, MAX_PLAYERS } from './engine/rules.js';

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback) => (value === undefined || value === '' ? fallback : value === 'true' || value === '1');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// TRUST_PROXY: false, true (any proxy), or a comma list of proxy addresses such as 127.0.0.1.
const trust = (value) => {
  const v = String(value ?? '').trim();
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true' || v === '1') return true;
  return v.split(',').map((a) => a.trim()).filter(Boolean);
};

export function loadConfig(env = process.env) {
  return {
    gameName: env.GAME_NAME || 'Hamdast',
    port: int(env.PORT, 3000),
    host: env.HOST || '127.0.0.1',
    trustProxy: trust(env.TRUST_PROXY),
    defaultLanguage: env.DEFAULT_LANGUAGE === 'en' ? 'en' : 'fa',
    minPlayers: clamp(int(env.MIN_PLAYERS, 6), MIN_PLAYERS, MAX_PLAYERS),
    maxPlayers: clamp(int(env.MAX_PLAYERS, 12), MIN_PLAYERS, MAX_PLAYERS),
    maxOpenRooms: int(env.MAX_OPEN_ROOMS, 100),
    maxRoomsPerIp: int(env.MAX_ROOMS_PER_IP, 3),
    minAge: int(env.MIN_AGE, 16),
    minPhaseMs: int(env.MIN_PHASE_MS, 10000),
    maxPhaseMs: 15 * 60 * 1000,
    timers: {
      introMs: int(env.INTRO_MS, 20000),
      dayMs: int(env.DAY_MS, 180000),
      voteMs: int(env.VOTE_MS, 45000),
      nightMs: int(env.NIGHT_MS, 45000),
      nightEarlyEnd: bool(env.NIGHT_EARLY_END, false),
    },
    speakMs: int(env.SPEAK_MS, 30000),
    dataDir: env.DATA_DIR || './data',
    logDir: env.LOG_DIR || './logs',
    logMaxBytes: int(env.LOG_MAX_BYTES, 10 * 1024 * 1024),
    logKeep: int(env.LOG_KEEP, 3),
    logStdout: bool(env.LOG_STDOUT, true),
    roomRetentionHours: int(env.ROOM_RETENTION_HOURS, 24),
    reportRetentionDays: int(env.REPORT_RETENTION_DAYS, 30),
    openReportMaxDays: int(env.OPEN_REPORT_MAX_DAYS, 60),
    banRetentionDays: int(env.BAN_RETENTION_DAYS, 90),
    voiceProvider: env.VOICE_PROVIDER || 'off',
    adminToken: env.ADMIN_TOKEN || '',
    heartbeatMs: 20000,
  };
}
