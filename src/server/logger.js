// JSON-lines logger. Writes to stdout (so journalctl shows it) and to a file
// that rotates by size, so a few small files can be copied off the VM.
// Chat text, roles, nicknames and tokens never go in: those keys are removed.
import fs from 'node:fs';
import path from 'node:path';

const REDACT = new Set(['token', 'tokenhash', 'authorization', 'text', 'body', 'role', 'roles', 'nickname', 'password', 'admintoken', 'ip']);

export function scrub(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (REDACT.has(key.toLowerCase())) continue;
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? scrub(value) : value;
  }
  return out;
}

export function createLogger({ dir, maxBytes = 10 * 1024 * 1024, keep = 3, stdout = true, file = 'app.log' } = {}) {
  let fd = null;
  let size = 0;
  const target = dir ? path.join(dir, file) : null;

  function open() {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(target, 'a');
    size = fs.fstatSync(fd).size;
  }

  // Keeps `keep` old files: app.log.1 is the newest, app.log.<keep> the oldest.
  function rotate() {
    fs.closeSync(fd);
    fd = null;
    fs.rmSync(`${target}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      if (fs.existsSync(`${target}.${i}`)) fs.renameSync(`${target}.${i}`, `${target}.${i + 1}`);
    }
    fs.renameSync(target, `${target}.1`);
    open();
  }

  function write(level, msg, fields) {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...scrub(fields) }) + '\n';
    if (stdout) process.stdout.write(line);
    if (!target) return;
    try {
      if (fd === null) open();
      if (size + Buffer.byteLength(line) > maxBytes && size > 0) rotate();
      fs.writeSync(fd, line);
      size += Buffer.byteLength(line);
    } catch {
      // Logging must never take the game down.
    }
  }

  return {
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    close() {
      if (fd !== null) fs.closeSync(fd);
      fd = null;
    },
  };
}
