// HTTP API, the live stream, and static files. No framework.
//
// The live stream is Server-Sent Events read with fetch, not EventSource, so the
// session token travels in an Authorization header and never in a URL.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LIMITS } from './ratelimit.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=()',
};

const STATUS_FOR = { unauthorized: 401, rate_limited: 429 };

export function createApp({ manager, config, logger, limiter, publicDir }) {
  const root = path.resolve(publicDir);

  const clientAddress = (req) => {
    if (config.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }

  function json(res, status, data) {
    send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  function reply(res, result) {
    if (result.ok) {
      const { ok, ...rest } = result;
      return json(res, 200, { ok: true, ...rest });
    }
    return json(res, result.status ?? STATUS_FOR[result.error] ?? 400, { ok: false, error: result.error });
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 10_000) {
          reject(Object.assign(new Error('too_large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (size === 0) return resolve({});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsed && typeof parsed === 'object' ? parsed : {});
        } catch {
          reject(Object.assign(new Error('bad_json'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;

  function isAdmin(req) {
    if (!config.adminToken) return false;
    const given = Buffer.from(bearer(req) ?? '');
    const want = Buffer.from(config.adminToken);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  function openStream(req, res, seatId) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const listener = {
      send: (view) => res.write(`event: view\ndata: ${JSON.stringify(view)}\n\n`),
      close: () => res.end(),
    };
    const unsubscribe = manager.subscribe(seatId, listener);
    const beat = setInterval(() => res.write(': ping\n\n'), config.heartbeatMs);
    req.on('close', () => {
      clearInterval(beat);
      unsubscribe?.();
    });
  }

  async function handleApi(req, res, url) {
    const ip = clientAddress(req);
    if (!limiter.allow(`api:${ip}`, LIMITS.api)) return json(res, 429, { ok: false, error: 'rate_limited' });
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/health') return json(res, 200, { ok: true });
    if (route === 'GET /api/config') {
      return json(res, 200, {
        gameName: config.gameName,
        minPlayers: config.minPlayers,
        maxPlayers: config.maxPlayers,
        minAge: config.minAge,
        defaultLanguage: config.defaultLanguage,
        voice: manager.voice.enabled,
        phaseBounds: { min: config.minPhaseMs, max: config.maxPhaseMs },
      });
    }

    if (url.pathname.startsWith('/api/admin/')) {
      if (!config.adminToken) return json(res, 404, { ok: false, error: 'not_found' });
      if (!isAdmin(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
      if (route === 'GET /api/admin/reports') return json(res, 200, { ok: true, reports: manager.listReports() });
      const m = /^\/api\/admin\/reports\/([\w-]+)$/.exec(url.pathname);
      if (m && req.method === 'POST') {
        const body = await readJson(req);
        return reply(res, manager.resolveReport(m[1], body.action));
      }
      return json(res, 404, { ok: false, error: 'not_found' });
    }

    if (route === 'POST /api/rooms') {
      if (!limiter.allow(`create:${ip}`, LIMITS.create)) return json(res, 429, { ok: false, error: 'rate_limited' });
      return reply(res, manager.createRoom(await readJson(req)));
    }
    const join = /^\/api\/rooms\/([A-Za-z0-9]{4,8})\/join$/.exec(url.pathname);
    if (join && req.method === 'POST') {
      if (!limiter.allow(`join:${ip}`, LIMITS.join)) return json(res, 429, { ok: false, error: 'rate_limited' });
      return reply(res, manager.joinRoom(join[1], await readJson(req)));
    }

    // Everything below needs a session token.
    const auth = manager.authenticate(bearer(req));
    if (!auth) return json(res, 401, { ok: false, error: 'unauthorized' });
    const seatId = auth.seat.id;

    if (route === 'GET /api/stream') return openStream(req, res, seatId);
    if (route === 'GET /api/view') return json(res, 200, { ok: true, view: manager.viewOf(seatId) });
    if (route === 'GET /api/voice') return reply(res, manager.voiceToken(seatId));
    if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not_found' });

    const body = await readJson(req);
    switch (url.pathname) {
      case '/api/leave': return reply(res, manager.leave(seatId));
      case '/api/start': return reply(res, manager.startGame(seatId));
      case '/api/rematch': return reply(res, manager.rematch(seatId));
      case '/api/settings': return reply(res, manager.updateSettings(seatId, body));
      case '/api/kick': return reply(res, manager.kick(seatId, body.seatId));
      case '/api/action': return reply(res, manager.act(seatId, body));
      case '/api/chat': return reply(res, manager.sendChat(seatId, body.channel ?? 'public', body.text));
      case '/api/block': return reply(res, manager.block(seatId, body.seatId));
      case '/api/report': {
        if (!limiter.allow(`report:${seatId}`, LIMITS.report)) return json(res, 429, { ok: false, error: 'rate_limited' });
        return reply(res, manager.report(seatId, body.seatId, body.reason));
      }
      default: return json(res, 404, { ok: false, error: 'not_found' });
    }
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, 'Bad request');
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + path.sep)) return send(res, 404, 'Not found');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      send(res, 200, req.method === 'HEAD' ? '' : data, {
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
    });
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      if (err.status) return json(res, err.status, { ok: false, error: err.message });
      logger.error('request_failed', { message: err.message });
      if (!res.headersSent) json(res, 500, { ok: false, error: 'server_error' });
    }
  });
}
