/* L5Music PWA — sw.js b124 */

const CACHE = 'l5music-b374';
const SHELL = [
  '/',
  '/index.html',
  '/app.js?v=b374',
  '/styles.css?v=b360',
  '/pwa.css?v=b374',
  '/login.js?v=b360',
  '/login.html',
  '/manifest.json',
  '/favicon.png', '/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache: API, streams, auth
  if (
    url.pathname.startsWith('/rest/') ||
    url.pathname.startsWith('/l5/') ||
    url.pathname === '/favicon.ico' ||
    url.pathname.includes('stream') ||
    url.pathname.includes('login')
  ) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response('Offline – API unavailable', { status: 503 })
      )
    );
    return;
  }

  // Network-first for HTML and JS — always get fresh, fall back to cache
  if (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname.startsWith('/app.js') ||
    url.pathname === '/sw.js'
  ) {
    event.respondWith(
      fetch(event.request).then(resp => {
        if (!resp || resp.status !== 200 || resp.type === 'opaque') return resp;
        const clone = resp.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, clone));
        return resp;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for everything else (CSS, images, fonts)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(resp => {
        if (!resp || resp.status !== 200 || resp.type === 'opaque') return resp;
        const clone = resp.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, clone));
        return resp;
      }).catch(() => {
        if (event.request.mode === 'navigate') return caches.match('/index.html');
      });
    })
  );
});
