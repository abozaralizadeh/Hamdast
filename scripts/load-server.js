// A throwaway server for scripts/load.js: tiny timers, a temporary database, no
// per-address rate limits, a free port. Prints "PORT <n>" when it is ready.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamdast-load-'));
const config = loadConfig({
  LOG_STDOUT: 'false', MIN_PHASE_MS: '1', INTRO_MS: '40', DAY_MS: '400', VOTE_MS: '400', NIGHT_MS: '150',
  DATA_DIR: path.join(dir, 'data'), LOG_DIR: path.join(dir, 'logs'),
  // Every bot comes from one address, so the room caps are lifted for the load test.
  MAX_ROOMS_PER_IP: '100000', MAX_OPEN_ROOMS: '100000',
});
const app = buildServer(config);
app.limiter.allow = () => true;
app.server.listen(0, '127.0.0.1', () => console.log(`PORT ${app.server.address().port}`));
const stop = () => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
