import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import en from '../public/i18n/en.js';
import fa from '../public/i18n/fa.js';

const root = path.resolve(import.meta.dirname, '../public');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

test('Farsi and English have exactly the same keys, and no empty values', () => {
  const a = flatten(en);
  const b = flatten(fa);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  for (const [k, v] of Object.entries({ ...a })) assert.ok(String(v).length > 0, `en ${k} empty`);
  for (const [k, v] of Object.entries({ ...b })) assert.ok(String(v).length > 0, `fa ${k} empty`);
});

test('placeholders match between languages', () => {
  const a = flatten(en);
  const b = flatten(fa);
  const marks = (s) => (String(s).match(/\{\w+\}/g) ?? []).sort().join();
  for (const k of Object.keys(a)) if (typeof a[k] === 'string') assert.equal(marks(a[k]), marks(b[k]), `placeholders differ for ${k}`);
});

test('every translation key used in app.js exists', () => {
  const src = read('app.js');
  const keys = flatten(en);
  const used = [...src.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]);
  assert.ok(used.length > 40);
  for (const k of used) assert.ok(k in keys, `missing key ${k}`);
  for (const role of ['citizen', 'doctor', 'detective', 'mafia', 'godfather']) {
    assert.ok(`role.${role}` in keys && `roleDesc.${role}` in keys);
  }
  for (const reason of ['abuse', 'cheating', 'spam', 'other']) assert.ok(`reason.${reason}` in keys);
  for (const phase of ['introNight', 'night', 'day', 'vote', 'over']) assert.ok(`phase.${phase}` in keys);
  for (const code of ['not_confirmed', 'bad_nickname', 'nickname_taken', 'room_full', 'game_started', 'rate_limited', 'chat_closed', 'default']) {
    assert.ok(`errors.${code}` in keys);
  }
});

test('every error code the server can send has a message', () => {
  const server = fs.readFileSync(path.resolve(import.meta.dirname, '../src/server/rooms.js'), 'utf8')
    + fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/rules.js'), 'utf8')
    + fs.readFileSync(path.resolve(import.meta.dirname, '../src/server/nickname.js'), 'utf8');
  const codes = new Set([...server.matchAll(/(?:fail\(|error: )'([a-z_]+)'/g)].map((m) => m[1]));
  const known = flatten(en);
  assert.ok(codes.size > 25, `only found ${codes.size} codes`);
  const missing = [...codes].filter((c) => !(`errors.${c}` in known));
  const allowed = new Set(['not_in_game', 'dead', 'game_over', 'bad_action', 'intro_night', 'bad_channel', 'not_found', 'no_game', 'not_over', 'voice_off']);
  assert.deepEqual(missing.filter((c) => !allowed.has(c)), []);
});

test('CSS uses logical properties only, so right to left works', () => {
  const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const physical = [
    /(margin|padding|border)-(left|right)\b/,
    /(^|[;{\s])(left|right)\s*:/,
    /text-align\s*:\s*(left|right)/,
    /float\s*:\s*(left|right)/,
    /(^|[;{\s])(width|height)\s*:/,
  ];
  for (const re of physical) assert.ok(!re.test(css), `physical property found: ${re}`);
});

test('client code never builds HTML from strings or uses inline styles', () => {
  for (const file of ['app.js', 'sw.js']) {
    const src = read(file);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(src), `${file} uses unsafe DOM or eval`);
    assert.ok(!/\.style\.|setAttribute\('style'|style:/.test(src), `${file} sets inline styles`);
  }
  assert.ok(!/ style=/.test(read('index.html')));
});

test('no third party scripts, fonts or trackers are referenced', () => {
  for (const file of ['index.html', 'app.js', 'style.css', 'sw.js']) {
    assert.ok(!/https?:\/\//.test(read(file).replace(/xmlns="[^"]+"/g, '')), `${file} references an outside URL`);
  }
});

test('manifest is valid for an installable web app', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.ok(m.icons.length >= 1);
  for (const icon of m.icons) assert.ok(fs.existsSync(path.join(root, icon.src)));
  assert.match(read('index.html'), /rel="manifest"/);
  assert.match(read('index.html'), /name="viewport"/);
});

test('docs and client text avoid em dashes', () => {
  const base = path.resolve(import.meta.dirname, '..');
  const files = [
    'README.md', 'docs/ROADMAP.md', 'docs/RULES.md', 'docs/LOGICAL-FLOW.md', 'docs/DESIGN.md', 'site/index.html', 'site/style.css', 'site/site.js', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md',
    'public/app.js', 'public/i18n/en.js', 'public/i18n/fa.js', 'public/style.css', 'setup_service.sh',
  ];
  for (const f of files) {
    const p = path.join(base, f);
    if (fs.existsSync(p)) assert.ok(!/[\u2013\u2014]/.test(fs.readFileSync(p, 'utf8')), `${f} has a dash character`);
  }
});

test('the Pages site points at real files, and deploys only when site/ changes', () => {
  const base = path.resolve(import.meta.dirname, '..');
  const page = fs.readFileSync(path.join(base, 'site/index.html'), 'utf8');
  for (const [, src] of page.matchAll(/(?:src|href)="((?!https?:|#)[^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(base, 'site', src)), `site/${src} is missing`);
  }
  assert.doesNotMatch(page, /src="https?:|<link[^>]+href="https?:|url\(['"]?https?:/, 'the site loads nothing from outside');
  for (const [tag] of page.matchAll(/<script[^>]*>/g)) assert.equal(tag, '<script src="site.js">', 'only the local site.js, no inline scripts');
  assert.doesNotMatch(fs.readFileSync(path.join(base, 'site/style.css'), 'utf8'), /url\(['"]?https?:/, 'no outside fonts or images in the CSS');
  const flow = fs.readFileSync(path.join(base, '.github/workflows/pages.yml'), 'utf8');
  assert.match(flow, /workflow_dispatch:/);
  assert.match(flow, /push:\s*\n\s*branches: \[main\]\s*\n\s*paths: \['site\/\*\*'\]/);
  assert.match(flow, /path: site/);
});
