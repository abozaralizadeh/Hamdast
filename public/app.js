// The whole browser app. No framework, no build step, no inline styles or HTML
// strings (text is always set with textContent, so chat cannot inject markup).
import en from './i18n/en.js';
import fa from './i18n/fa.js';

const DICTS = { en, fa };
const SESSION_KEY = 'mn.session';
const LANG_KEY = 'mn.lang';
const MAFIA_ROLES = ['mafia', 'godfather'];

const app = document.getElementById('app');
const state = {
  config: null,
  lang: 'fa',
  session: null, // { token, code }
  view: null,
  connected: false,
  skew: 0,
  revealRole: true,
  reporting: null,
  toast: null,
  channel: 'public',
  route: 'home',
  routeArg: '',
  busy: false,
};
let streamAbort = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

// ---------- small helpers ----------

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

const dict = () => DICTS[state.lang];

function t(path, vars = {}) {
  let value = path.split('.').reduce((o, k) => (o == null ? o : o[k]), dict());
  if (typeof value !== 'string') return path;
  for (const [k, v] of Object.entries(vars)) value = value.replaceAll(`{${k}}`, String(v));
  return value;
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const num = (value) => (state.lang === 'fa' ? String(value).replace(/\d/g, (d) => PERSIAN_DIGITS[d]) : String(value));

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

function setLang(lang) {
  state.lang = lang === 'en' ? 'en' : 'fa';
  store.set(LANG_KEY, state.lang);
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === 'fa' ? 'rtl' : 'ltr';
  document.title = state.config?.gameName ?? 'MafiaNight';
}

function showToast(message, ok = false) {
  state.toast = { message, ok };
  render();
  setTimeout(() => {
    if (state.toast?.message === message) {
      state.toast = null;
      render();
    }
  }, 3500);
}

const errorText = (code) => dict().errors[code] ?? dict().errors.default;

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.session?.token) headers.Authorization = `Bearer ${state.session.token}`;
  try {
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({ ok: false, error: 'server_error' }));
    if (res.status === 401 && state.session) endSession();
    return data;
  } catch {
    return { ok: false, error: 'network' };
  }
}

async function call(method, path, body) {
  const res = await api(method, path, body);
  if (!res.ok) showToast(errorText(res.error));
  return res;
}

// ---------- session and live stream ----------

function startSession(token, code) {
  state.session = { token, code };
  store.set(SESSION_KEY, JSON.stringify(state.session));
  state.revealRole = true;
  connectStream();
}

function endSession() {
  streamAbort?.abort();
  clearTimeout(reconnectTimer);
  state.session = null;
  state.view = null;
  state.connected = false;
  store.del(SESSION_KEY);
  location.hash = '#/';
  render();
}

async function connectStream() {
  streamAbort?.abort();
  clearTimeout(reconnectTimer);
  if (!state.session) return;
  const abort = new AbortController();
  streamAbort = abort;
  try {
    const res = await fetch('/api/stream', { headers: { Authorization: `Bearer ${state.session.token}` }, signal: abort.signal });
    if (res.status === 401) return endSession();
    if (!res.ok || !res.body) throw new Error('stream');
    state.connected = true;
    reconnectDelay = 1000;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (block.includes('event: view') && data) onView(JSON.parse(data.slice(6)));
      }
    }
  } catch (err) {
    if (abort.signal.aborted) return;
    console.error('live stream stopped', err);
  }
  if (abort.signal.aborted || streamAbort !== abort) return;
  state.connected = false;
  render();
  reconnectTimer = setTimeout(connectStream, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 8000);
}

function onView(view) {
  const before = state.view;
  state.skew = view.now - Date.now();
  state.view = view;
  if (before && !before.game && view.game) state.revealRole = true;
  if (before?.game && view.game && view.game.phase !== before.game.phase && !view.game.intro) state.revealRole = false;
  if (!before || before.game?.phase !== view.game?.phase) state.channel = 'public';
  render();
}

// ---------- routing ----------

function readRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, arg = ''] = hash.split('/');
  state.route = ['join', 'howto', 'privacy', 'terms'].includes(name) ? name : 'home';
  state.routeArg = arg.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

// ---------- rendering ----------

function keepFocus(fn) {
  const active = document.activeElement;
  const id = active?.id;
  const value = active?.value;
  const start = active?.selectionStart;
  const end = active?.selectionEnd;
  fn();
  if (id) {
    const el = document.getElementById(id);
    if (el) {
      if (value !== undefined && el.value !== value && 'value' in el && el.tagName !== 'SELECT') el.value = value;
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(start, end); } catch { /* not a text input */ }
    }
  }
}

function render() {
  keepFocus(() => {
    const chatBox = document.getElementById('chat-box');
    const pinned = !chatBox || chatBox.scrollTop + chatBox.clientHeight >= chatBox.scrollHeight - 24;
    app.replaceChildren(...[
      topbar(),
      !state.connected && state.session && state.view ? h('div', { class: 'banner', role: 'status' }, t('reconnecting')) : null,
      screen(),
      state.toast ? h('div', { class: `toast${state.toast.ok ? ' ok' : ''}`, role: 'alert' }, state.toast.message) : null,
    ].filter(Boolean));
    const next = document.getElementById('chat-box');
    if (next && pinned) next.scrollTop = next.scrollHeight;
  });
  tick();
}

function topbar() {
  return h('div', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' }, state.config?.gameName ?? 'MafiaNight'),
    h('div', { class: 'row' },
      h('button', { class: 'small', onclick: () => { setLang(state.lang === 'fa' ? 'en' : 'fa'); render(); } }, t('language')),
    ),
  );
}

function screen() {
  if (state.session && state.view) return state.view.game ? gameScreen() : lobbyScreen();
  if (state.session) return h('p', { class: 'muted' }, '...');
  if (state.route === 'howto') return pageScreen(t('howTo'), dict().howSections.map(([title, text]) => h('div', { class: 'card' }, h('h2', null, title), h('p', null, text))));
  if (state.route === 'privacy') return legalScreen(t('legal.privacyTitle'), dict().legal.privacy);
  if (state.route === 'terms') return legalScreen(t('legal.termsTitle'), dict().legal.terms);
  return homeScreen();
}

function pageScreen(title, body) {
  return h('div', { class: 'stack' }, h('h1', null, title), body, h('a', { href: '#/' }, t('back')));
}

function legalScreen(title, lines) {
  return pageScreen(title, [h('p', { class: 'notice' }, t('draftNotice')), lines.map((l) => h('p', null, l))]);
}

function homeScreen() {
  const joining = state.route === 'join' || state.routeArg;
  const minAge = state.config?.minAge ?? 16;
  const form = (mode) => {
    const needsCode = mode === 'join';
    return h('form', {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        if (state.busy) return;
        const nickname = document.getElementById('nick').value;
        const confirmed = document.getElementById('age').checked;
        state.busy = true;
        const code = needsCode ? document.getElementById('code').value.trim().toUpperCase() : null;
        const res = needsCode
          ? await call('POST', `/api/rooms/${encodeURIComponent(code)}/join`, { nickname, confirmed, language: state.lang })
          : await call('POST', '/api/rooms', { nickname, confirmed, language: state.lang });
        state.busy = false;
        if (res.ok) {
          location.hash = '#/';
          startSession(res.token, res.code);
        }
      },
    },
      h('h2', null, needsCode ? t('join') : t('create')),
      needsCode ? [h('label', { for: 'code' }, t('roomCode')), h('input', { id: 'code', value: state.routeArg, maxlength: '8', autocomplete: 'off', autocapitalize: 'characters', dir: 'ltr', required: true })] : null,
      h('label', { for: 'nick' }, t('nickname')),
      h('input', { id: 'nick', maxlength: '20', autocomplete: 'nickname', required: true, 'aria-describedby': 'nick-hint' }),
      h('small', { id: 'nick-hint', class: 'muted' }, t('nicknameHint')),
      h('label', { class: 'check', for: 'age' }, h('input', { id: 'age', type: 'checkbox', required: true }), h('span', null, t('ageConfirm', { age: num(minAge) }))),
      h('button', { class: 'primary', type: 'submit', disabled: state.busy }, needsCode ? t('joinRoom') : t('createRoom')),
    );
  };
  return h('div', { class: 'stack' },
    h('h1', null, state.config?.gameName ?? 'MafiaNight'),
    h('p', null, t('tagline')),
    joining ? [form('join'), h('a', { href: '#/' }, t('create'))] : [form('create'), h('p', { class: 'muted' }, t('join')), h('a', { href: '#/join' }, t('joinRoom'))],
    h('div', { class: 'row' },
      h('a', { href: '#/howto' }, t('howTo')), h('a', { href: '#/privacy' }, t('privacy')), h('a', { href: '#/terms' }, t('terms'))),
  );
}

const nameOf = (seatId) => state.view.players.find((p) => p.seatId === seatId)?.nickname ?? '?';
// Isolates keep a Farsi name from scrambling an English sentence, and the other way round.
const isoName = (seatId) => `\u2068${nameOf(seatId)}\u2069`;
const playerOf = (seatId) => state.view.players.find((p) => p.seatId === seatId);

function countdown(endsAt) {
  return h('span', { class: 'timer', 'data-ends': endsAt ?? '' }, '');
}

function tick() {
  for (const el of document.querySelectorAll('[data-ends]')) {
    const ends = Number(el.dataset.ends);
    if (!ends) { el.textContent = ''; continue; }
    const left = Math.max(0, Math.ceil((ends - (Date.now() + state.skew)) / 1000));
    el.textContent = num(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
  }
}
setInterval(tick, 250);

function playerRow(p, { lobby = false } = {}) {
  const v = state.view;
  const self = p.seatId === v.you.seatId;
  return h('li', { class: p.alive ? '' : 'dead' },
    h('span', { class: 'name' }, p.nickname),
    self ? h('span', { class: 'badge accent' }, t('you')) : null,
    p.seatId === v.room.hostSeatId ? h('span', { class: 'badge' }, t('host')) : null,
    p.role ? h('span', { class: `badge ${MAFIA_ROLES.includes(p.role) ? 'danger' : ''}` }, t(`role.${p.role}`)) : null,
    !p.alive && !lobby ? h('span', { class: 'badge' }, t('out')) : null,
    p.left ? h('span', { class: 'badge' }, t('left')) : p.absent ? h('span', { class: 'badge' }, t('absent')) : p.away ? h('span', { class: 'badge' }, t('away')) : null,
    h('span', { class: 'grow' }),
    !self && lobby && v.you.isHost ? h('button', { class: 'small danger', onclick: () => call('POST', '/api/kick', { seatId: p.seatId }) }, t('kick')) : null,
    !self ? (p.blocked
      ? h('span', { class: 'badge' }, t('blocked'))
      : h('button', { class: 'small', onclick: () => call('POST', '/api/block', { seatId: p.seatId }) }, t('block'))) : null,
    !self ? h('button', { class: 'small', onclick: () => { state.reporting = p.seatId; render(); } }, t('report')) : null,
  );
}

function reportPanel() {
  const target = playerOf(state.reporting);
  if (!target) return null;
  return h('div', { class: 'card', role: 'dialog', 'aria-label': t('report') },
    h('p', null, t('reportWhy', { name: `⁨${target.nickname}⁩` })),
    h('div', { class: 'row' },
      ['abuse', 'cheating', 'spam', 'other'].map((reason) => h('button', {
        onclick: async () => {
          const res = await call('POST', '/api/report', { seatId: target.seatId, reason });
          state.reporting = null;
          if (res.ok) showToast(t('reported'), true); else render();
        },
      }, t(`reason.${reason}`))),
      h('button', { class: 'link', onclick: () => { state.reporting = null; render(); } }, t('cancel'))),
  );
}

function chatPanel(title) {
  const v = state.view;
  const g = v.game;
  const me = v.you;
  const isMafia = MAFIA_ROLES.includes(me.role);
  const canPublic = !g || g.phase === 'over' || (g.phase === 'day' && me.alive);
  const canMafia = g && g.phase === 'night' && me.alive && isMafia;
  const channel = state.channel === 'mafia' && canMafia ? 'mafia' : 'public';
  const writable = channel === 'mafia' ? canMafia : canPublic;
  const send = async () => {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const res = await call('POST', '/api/chat', { channel, text });
    if (!res.ok) {
      const again = document.getElementById('chat-input');
      if (again && !again.value) again.value = text;
    }
  };
  return h('div', { class: 'card' },
    h('h2', null, title),
    h('div', { class: 'chat', id: 'chat-box', role: 'log', 'aria-live': 'polite' },
      v.chat.length === 0 ? h('p', { class: 'muted' }, t('noMessages')) : v.chat.map((m) => h('div', { class: `msg ${m.channel}` },
        h('span', { class: 'who' }, nameOf(m.seatId)), m.channel === 'mafia' ? h('span', { class: 'badge danger' }, t('chatMafia')) : null, ' ', m.body))),
    writable
      ? h('form', { class: 'chat-form', onsubmit: (e) => { e.preventDefault(); send(); } },
        canMafia ? h('select', { id: 'chat-channel', 'aria-label': t('chatLobby'), onchange: (e) => { state.channel = e.target.value; render(); } },
          h('option', { value: 'public', selected: channel === 'public' }, t('chatDay')), h('option', { value: 'mafia', selected: channel === 'mafia' }, t('chatMafia'))) : null,
        h('input', { id: 'chat-input', maxlength: '300', placeholder: t('chatPlaceholder'), autocomplete: 'off', 'aria-label': t('chatPlaceholder') }),
        h('button', { class: 'primary', type: 'submit' }, t('send')))
      : h('p', { class: 'muted' }, t('chatClosed')),
  );
}

function leaveButton() {
  return h('button', { class: 'danger', onclick: async () => { if (confirm(t('confirmLeave'))) { await api('POST', '/api/leave'); endSession(); } } }, t('leave'));
}

function lobbyScreen() {
  const v = state.view;
  const active = v.players.length;
  const link = `${location.origin}/#/join/${v.room.code}`;
  const canStart = v.you.isHost && active >= v.room.minPlayers && active <= v.room.maxPlayers;
  const s = v.room.settings;
  const field = (id, key, label) => h('div', null, h('label', { for: id }, label), h('input', { id, type: 'number', inputmode: 'numeric', min: String(Math.ceil((state.config?.phaseBounds.min ?? 10000) / 1000)), value: String(Math.round(s[key] / 1000)) }));
  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'muted' }, t('roomCode')), h('span', { class: 'code' }, v.room.code)),
      h('p', { class: 'muted' }, t('invite')),
      h('div', { class: 'row' },
        h('input', { readonly: true, dir: 'ltr', value: link, 'aria-label': t('invite'), class: 'grow' }),
        h('button', { onclick: async () => { try { await navigator.clipboard.writeText(link); showToast(t('linkCopied'), true); } catch { document.querySelector('input[readonly]')?.select(); } } }, t('copyLink')))),
    h('div', { class: 'card' },
      h('h2', null, `${t('players')} (${num(active)})`),
      h('ul', { class: 'players' }, v.players.map((p) => playerRow(p, { lobby: true })))),
    state.reporting ? reportPanel() : null,
    v.you.isHost ? h('form', {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        const ms = (id) => Math.round(Number(document.getElementById(id).value) * 1000);
        const res = await call('POST', '/api/settings', { dayMs: ms('set-day'), voteMs: ms('set-vote'), nightMs: ms('set-night') });
        if (res.ok) showToast(t('saved'), true);
      },
    },
      h('h2', null, t('settings')),
      h('div', { class: 'row' }, field('set-day', 'dayMs', t('dayTime')), field('set-vote', 'voteMs', t('voteTime')), field('set-night', 'nightMs', t('nightTime'))),
      h('button', { type: 'submit' }, t('save'))) : null,
    v.you.isHost
      ? h('div', null,
        h('button', { class: 'primary', disabled: !canStart, onclick: () => call('POST', '/api/start') }, t('startGame')),
        canStart ? null : h('p', { class: 'muted' }, t('needPlayers', { min: num(v.room.minPlayers), max: num(v.room.maxPlayers), count: num(active) })))
      : h('p', { class: 'muted' }, t('waitingHost')),
    chatPanel(t('chatLobby')),
    h('div', { class: 'row' }, h('a', { href: '#/howto', target: '_blank', rel: 'noopener' }, t('howTo')), leaveButton()),
  );
}

function phaseLabel(g) {
  if (g.phase === 'night' && g.intro) return t('phase.introNight');
  return t(`phase.${g.phase}`);
}

function historyLines(g) {
  const lines = [];
  for (const ev of g.history) {
    if (ev.type === 'night_result') {
      lines.push(ev.killed ? t('diedTonight', { day: num(ev.day), name: isoName(ev.killed) }) : t('nobodyDied', { day: num(ev.day) }));
    } else if (ev.type === 'vote_result') {
      lines.push(ev.eliminated ? t('voteOut', { day: num(ev.day), name: isoName(ev.eliminated) }) : t('voteNobody', { day: num(ev.day) }));
      for (const vote of ev.votes) {
        lines.push(t('voteDetail', { from: isoName(vote.from), to: vote.to ? isoName(vote.to) : t('skipped') }));
      }
    }
  }
  return lines;
}

function actionPanel() {
  const v = state.view;
  const g = v.game;
  const a = v.you.action;
  if (g.phase === 'over') return null;
  if (!v.you.alive) return h('div', { class: 'card' }, h('p', { class: 'muted' }, t('spectating')));
  if (!a) return null;
  if (a.kind === 'wait') return h('div', { class: 'card' }, h('p', null, g.intro ? t('introNight') : t('nightWait')));
  if (a.kind === 'ready') {
    return h('div', { class: 'card' },
      h('button', { class: 'primary', disabled: a.selected, onclick: () => call('POST', '/api/action', { type: 'ready' }) }, t('readyToVote')),
      a.selected ? h('p', { class: 'muted' }, t('readySent')) : null,
      g.progress ? h('p', { class: 'muted' }, t('progress', { done: num(g.progress.done), total: num(g.progress.total) })) : null);
  }
  const night = a.kind !== 'vote';
  const prompt = { kill: 'chooseKill', save: 'chooseSave', check: 'chooseCheck', vote: 'votePrompt' }[a.kind];
  const pick = (target) => call('POST', '/api/action', night ? { type: 'night', target } : { type: 'vote', target });
  return h('div', { class: 'card' },
    h('h2', null, t(prompt)),
    h('div', { class: 'choices' }, a.options.map((id) => h('button', {
      class: a.selected === id ? 'selected' : '',
      disabled: a.voted,
      'aria-pressed': a.selected === id ? 'true' : 'false',
      onclick: () => pick(id),
    }, nameOf(id)))),
    a.kind === 'vote' ? h('button', { disabled: a.voted, class: a.voted && a.selected === null ? 'selected' : '', onclick: () => pick(null) }, t('skipVote')) : null,
    night && a.selected ? h('p', { class: 'muted' }, t('actionDone')) : null,
    a.kind === 'vote' && a.voted ? h('p', { class: 'muted' }, a.selected ? t('votedFor', { name: isoName(a.selected) }) : t('votedSkip')) : null,
    a.kind === 'vote' && g.progress ? h('p', { class: 'muted' }, t('progress', { done: num(g.progress.done), total: num(g.progress.total) })) : null);
}

function voicePanel() {
  const v = state.view;
  if (!v.voice.enabled) return null;
  let line = t('openDiscussion');
  if (v.voice.mode === 'muted') line = t('voiceMuted');
  if (v.voice.mode === 'turn') line = t('speakerNow', { name: isoName(v.voice.speakerSeatId) });
  return h('div', { class: 'card' },
    h('h2', null, t('voiceTitle')),
    h('p', null, line),
    v.voice.mode === 'turn' && v.voice.canSpeak ? h('p', { class: 'badge accent' }, t('youCanSpeak')) : null,
    v.voice.provider === 'fake' ? h('p', { class: 'notice' }, t('voiceSimulated')) : null);
}

function gameScreen() {
  const v = state.view;
  const g = v.game;
  const role = v.you.role;
  const isMafia = MAFIA_ROLES.includes(role);
  const team = v.players.filter((p) => p.role && MAFIA_ROLES.includes(p.role) && p.seatId !== v.you.seatId);
  const history = historyLines(g);
  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('span', { class: 'badge accent' }, v.room.code),
        h('h2', { class: 'grow' }, `${phaseLabel(g)}${g.day ? ` · ${num(g.day)}` : ''}`),
        g.phase === 'over' ? null : countdown(g.phaseEndsAt))),
    g.phase === 'over' ? h('div', { class: 'card' },
      h('div', { class: 'winner' }, g.winner === 'mafia' ? t('mafiaWin') : t('citizensWin')),
      v.you.isHost ? h('button', { class: 'primary', onclick: () => call('POST', '/api/rematch') }, t('rematch')) : h('p', { class: 'muted' }, t('waitingRematch'))) : null,
    h('button', { class: `role-card ${isMafia ? 'mafia' : ''}`, 'aria-expanded': String(state.revealRole), onclick: () => { state.revealRole = !state.revealRole; render(); } },
      state.revealRole
        ? [h('div', { class: 'muted' }, t('yourRole')), h('div', { class: 'role-name' }, t(`role.${role}`)), h('p', null, t(`roleDesc.${role}`)),
          team.length ? h('p', null, `${t('yourTeam')}: ${team.map((p) => `${p.nickname} (${t(`role.${p.role}`)})`).join('، ')}`) : null,
          h('small', { class: 'muted' }, t('tapToHide'))]
        : h('div', null, t('tapToShow'))),
    actionPanel(),
    v.you.checks.length ? h('div', { class: 'card' }, h('h2', null, t('checks')),
      v.you.checks.map((c) => h('p', null, t('checkResult', { name: isoName(c.target), result: c.isMafia ? t('isMafia') : t('notMafia') })))) : null,
    history.length ? h('div', { class: 'card history' }, h('h2', null, t('history')), history.map((l) => h('p', null, l))) : null,
    voicePanel(),
    h('div', { class: 'card' }, h('h2', null, t('players')), h('ul', { class: 'players' }, v.players.map((p) => playerRow(p)))),
    state.reporting ? reportPanel() : null,
    chatPanel(g.phase === 'day' ? t('chatDay') : t('chatLobby')),
    h('div', { class: 'row' }, h('a', { href: '#/howto', target: '_blank', rel: 'noopener' }, t('howTo')), leaveButton()),
  );
}

// ---------- start ----------

async function init() {
  try {
    state.config = await (await fetch('/api/config')).json();
  } catch {
    state.config = { gameName: 'MafiaNight', defaultLanguage: 'fa', minAge: 16, phaseBounds: { min: 10000, max: 900000 } };
  }
  const saved = store.get(LANG_KEY);
  const browser = (navigator.language || '').toLowerCase().startsWith('fa') ? 'fa' : null;
  setLang(saved ?? browser ?? state.config.defaultLanguage);
  readRoute();
  window.addEventListener('hashchange', () => { readRoute(); render(); });
  try {
    const saved = JSON.parse(store.get(SESSION_KEY) ?? 'null');
    if (saved?.token) {
      state.session = saved;
      connectStream();
    }
  } catch { /* ignore a broken saved session */ }
  render();
  const secureEnough = location.protocol === 'https:' || location.hostname === 'localhost';
  if (secureEnough && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
