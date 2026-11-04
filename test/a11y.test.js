import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../public');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const tokens = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]));

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Surfaces that are written as plain hex in the CSS rather than as tokens.
const banner = '#3a2a1f';
const toast = '#2b1d1d';
const toastOk = '#1d2b22';
const selected = '#3a3320';

test('the surfaces used in the contrast checks still exist in the CSS', () => {
  for (const hex of [banner, toast, toastOk, selected]) assert.ok(css.includes(hex), `${hex} is no longer in style.css`);
});

test('text meets WCAG AA contrast (4.5:1) on every surface it appears on', () => {
  const t = tokens;
  const surfaces = { bg: t.bg, panel: t.panel, 'panel-2': t['panel-2'], banner, toast, selected };
  const pairs = [
    ['text', ['bg', 'panel', 'panel-2', 'banner', 'toast', 'selected']],
    ['muted', ['bg', 'panel', 'panel-2']],
    ['accent', ['bg', 'panel', 'panel-2']],
    ['danger', ['bg', 'panel', 'panel-2', 'banner', 'toast']],
    ['good', ['bg', 'panel', 'panel-2']],
  ];
  for (const [fg, onto] of pairs) {
    for (const name of onto) {
      const r = ratio(t[fg], surfaces[name]);
      assert.ok(r >= 4.5, `${fg} on ${name} is ${r.toFixed(2)}:1`);
    }
  }
  assert.ok(ratio(t.good, toastOk) >= 4.5, 'good on the ok toast');
  // Tinted badges, the Mafia chat bubble and the coloured initials.
  assert.ok(ratio(t.accent, t['accent-soft']) >= 4.5, 'accent badge');
  assert.ok(ratio(t.danger, t['danger-soft']) >= 4.5, 'danger badge');
  assert.ok(ratio(t.text, t['danger-soft']) >= 4.5, 'text in a Mafia chat bubble');
  assert.ok(ratio(t.muted, selected) >= 4.5, 'name label in my own chat bubble');
  const hues = [...css.matchAll(/\.avatar\[data-hue='\d'\] \{ background: (#[0-9a-f]{6}); \}/g)].map((m) => m[1]);
  assert.equal(hues.length, 8);
  for (const hue of hues) assert.ok(ratio(t.bg, hue) >= 4.5, `avatar initial on ${hue}`);
  assert.ok(ratio(t['accent-text'], t.accent) >= 4.5, 'primary button text');
});

test('borders of inputs and buttons meet 3:1 against the surface they sit on', () => {
  for (const name of ['bg', 'panel', 'panel-2']) {
    const r = ratio(t(name), tokens.control);
    assert.ok(r >= 3, `control border on ${name} is ${r.toFixed(2)}:1`);
  }
  assert.ok(ratio(tokens.focus, tokens.bg) >= 3 && ratio(tokens.focus, tokens.panel) >= 3, 'focus ring');
  function t(name) { return tokens[name]; }
});

test('inputs and buttons use the control border, not the faint divider', () => {
  const rule = css.match(/button, input, select \{[^}]*\}/)[0];
  assert.match(rule, /var\(--control\)/);
});

test('the page declares a language, a viewport and a focus style', () => {
  assert.match(html, /<html[^>]*\blang=/);
  assert.match(html, /name="viewport"/);
  assert.match(css, /:focus-visible/);
});

test('every text input in the app has an accessible name', () => {
  const inputs = [...app.matchAll(/h\('(?:input|select)',\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(inputs.length > 3);
  for (const attrs of inputs) {
    const named = /'aria-label'|\bid\b/.test(attrs) || /type:\s*'checkbox'/.test(attrs);
    assert.ok(named, `unnamed control: ${attrs.slice(0, 80)}`);
  }
});

test('the chat log is a polite live region', () => {
  assert.match(app, /role: 'log', 'aria-live': 'polite'/);
});
