// Nickname rules: 2 to 20 letters, digits, spaces, dots, dashes, underscores.
// Unique inside a room. No impersonation names. Optional word list from
// config/blocked-words.txt.
import fs from 'node:fs';

const ALLOWED = /^[\p{L}\p{N}\p{M} _.\-‌]{2,20}$/u;
const RESERVED = ['admin', 'moderator', 'mod', 'system', 'support', 'host', 'server', 'hamdast', 'staff', 'مدیر', 'ادمین', 'سیستم', 'پشتیبان'];

export const normalize = (s) => s.toLowerCase().replace(/[\s._\-‌]/g, '');

export function loadBlockedWords(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')).map(normalize);
  } catch {
    return [];
  }
}

// Returns { ok: true, nickname } or { ok: false, error }.
export function checkNickname(raw, { taken = [], blockedWords = [] } = {}) {
  if (typeof raw !== 'string') return { ok: false, error: 'bad_nickname' };
  const nickname = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!ALLOWED.test(nickname)) return { ok: false, error: 'bad_nickname' };
  const key = normalize(nickname);
  if (key.length < 2) return { ok: false, error: 'bad_nickname' };
  if (RESERVED.some((r) => key === normalize(r))) return { ok: false, error: 'reserved_nickname' };
  if (blockedWords.some((w) => w && key.includes(w))) return { ok: false, error: 'blocked_nickname' };
  if (taken.some((t) => normalize(t) === key)) return { ok: false, error: 'nickname_taken' };
  return { ok: true, nickname };
}
