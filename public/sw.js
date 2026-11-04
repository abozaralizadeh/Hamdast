// Network first, with the last good copy as a fallback when offline.
// Game traffic under api/ is never cached. Every path here is relative to where
// the app is served, so it works at / and under a prefix such as /hamdast/.
// The cache name carries the scope, so other apps on the same host keep theirs.
const SCOPE = self.registration.scope;
const API = new URL('api/', SCOPE).href;
const PREFIX = 'hamdast-shell-';
const CACHE = `${PREFIX}3 ${SCOPE}`;
const SHELL = ['./', 'style.css', 'app.js', 'i18n/en.js', 'i18n/fa.js', 'fonts/Vazirmatn-wght.woff2', 'icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  // Only this app's own old caches for this scope are removed.
  const ours = (k) => k !== CACHE && k.startsWith(PREFIX) && k.endsWith(` ${SCOPE}`);
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter(ours).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  if (event.request.method !== 'GET' || !url.startsWith(SCOPE) || url.startsWith(API)) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
