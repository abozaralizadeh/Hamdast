// Hamdast project page: theme, role card, video, copy buttons and reveals.
// Runs in <head> so the saved theme applies before the first paint.

const root = document.documentElement;
root.classList.add('js');

function readTheme() {
  try { return localStorage.getItem('hamdast-theme'); } catch { return null; }
}
const saved = readTheme();
if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// The same five roles the game deals, with the app's own wording.
const ROLES = [
  { key: 'citizen', name: 'Citizen', fa: 'شهروند', desc: 'You have no power at night. Talk, watch, and vote out the Mafia.' },
  { key: 'doctor', name: 'Doctor', fa: 'دکتر', desc: 'Each night, save one person from the Mafia. You may save yourself once per game.' },
  { key: 'detective', name: 'Detective', fa: 'کارآگاه', desc: 'Each night, check one person. You learn if they are Mafia. The Godfather looks innocent.' },
  { key: 'mafia', name: 'Mafia', fa: 'مافیا', desc: 'You are with the Mafia. Talk in the Mafia chat at night. If the Godfather is gone, you choose the target.' },
  { key: 'godfather', name: 'Godfather', fa: 'پدرخوانده', desc: 'You lead the Mafia. Each night, choose who to eliminate. The Detective sees you as innocent.' },
];
// The deck for six players, as in roleList(6) in the rules engine.
const DECK = ['godfather', 'mafia', 'doctor', 'detective', 'citizen', 'citizen'];
let last = null;

function deal(card) {
  let key;
  do key = DECK[Math.floor(Math.random() * DECK.length)]; while (key === last);
  last = key;
  const role = ROLES.find((r) => r.key === key);
  card.querySelector('.role-name').textContent = role.name;
  card.querySelector('.role-fa').textContent = role.fa;
  card.querySelector('.role-desc').textContent = role.desc;
  card.classList.toggle('mafia', key === 'mafia' || key === 'godfather');
}

function setupRoleCard() {
  const card = document.querySelector('.role-card');
  if (!card) return;
  card.setAttribute('aria-pressed', 'false');
  card.addEventListener('click', () => {
    const open = !card.classList.contains('open');
    if (open) deal(card);
    card.classList.toggle('open', open);
    card.setAttribute('aria-pressed', String(open));
  });
}

function setupTheme() {
  const button = document.querySelector('.theme');
  if (!button) return;
  button.addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('hamdast-theme', next); } catch { /* private mode: the choice just isn't kept */ }
  });
}

// The hero video only downloads once it's close to the screen.
function setupVideo() {
  const video = document.querySelector('video[data-src]');
  if (!video) return;
  const load = () => {
    if (video.src) return;
    video.src = video.dataset.src;
    if (reducedMotion.matches) video.controls = true;
    else video.play().catch(() => { video.controls = true; });
  };
  if (!('IntersectionObserver' in window)) return load();
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { load(); io.disconnect(); }
  }, { rootMargin: '200px' });
  io.observe(video);
}

function setupCopy() {
  for (const button of document.querySelectorAll('.copy')) {
    button.addEventListener('click', async () => {
      const text = button.closest('.code').querySelector('code').textContent;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Select and copy';
      }
      button.classList.add('done');
      setTimeout(() => { button.textContent = 'Copy'; button.classList.remove('done'); }, 1800);
    });
  }
}

function setupReveal() {
  const items = document.querySelectorAll('.reveal');
  if (reducedMotion.matches || !('IntersectionObserver' in window)) {
    for (const el of items) el.classList.add('in');
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const el of items) io.observe(el);
}

document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupRoleCard();
  setupVideo();
  setupCopy();
  setupReveal();
});
