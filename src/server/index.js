import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createLogger } from './logger.js';
import { openStore } from './store.js';
import { createLimiter } from './ratelimit.js';
import { createVoice } from '../voice/provider.js';
import { RoomManager } from './rooms.js';
import { createApp } from './http.js';
import { loadBlockedWords } from './nickname.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');

export function buildServer(config = loadConfig()) {
  const logger = createLogger({ dir: path.resolve(projectRoot, config.logDir), maxBytes: config.logMaxBytes, keep: config.logKeep, stdout: config.logStdout });
  const store = openStore(path.resolve(projectRoot, config.dataDir, 'mafianight.db'));
  const limiter = createLimiter();
  const voice = createVoice(config);
  const manager = new RoomManager({
    config,
    store,
    logger,
    voice,
    limiter,
    blockedWords: loadBlockedWords(path.join(projectRoot, 'config', 'blocked-words.txt')),
  });
  manager.restore();
  const server = createApp({ manager, config, logger, limiter, publicDir: path.join(projectRoot, 'public') });
  return { server, manager, store, logger, config, limiter };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, manager, store, logger, config } = buildServer();
  const sweep = setInterval(() => manager.maintenance(), 10 * 60 * 1000);
  manager.maintenance();
  server.listen(config.port, config.host, () => {
    logger.info('listening', { host: config.host, port: config.port, voice: config.voiceProvider });
  });
  const stop = () => {
    logger.info('stopping');
    clearInterval(sweep);
    manager.shutdown();
    server.close(() => {
      store.close();
      logger.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
