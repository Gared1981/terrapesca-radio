// Radio Terrapesca Service Worker
// Keeps audio alive in background and caches static assets

const CACHE = 'terrapesca-radio-v1';
const STATIC = ['/panel.html', '/listen.html'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC.filter(Boolean))).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept the audio stream — let it flow through normally
  if (url.pathname.startsWith('/radio/stream') ||
      url.pathname.startsWith('/live.mp3') ||
      url.pathname.startsWith('/stream.mp3') ||
      url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first for static HTML
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// Keep alive: respond to ping messages from the page
self.addEventListener('message', e => {
  if (e.data === 'ping') e.ports[0]?.postMessage('pong');
});
