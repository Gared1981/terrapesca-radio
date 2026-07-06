// Radio Terrapesca Service Worker
// Keeps audio alive in background and caches static assets

const CACHE = 'terrapesca-radio-v3';
const STATIC = ['/', '/index.html', '/panel.html', '/listen.html', '/studio.html', '/sucursal.html'];

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

  // Network-first for static HTML: always serve the freshly deployed version,
  // falling back to cache only when offline. (Cache-first left stale UIs after deploys.)
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});

// Keep alive: respond to ping messages from the page
self.addEventListener('message', e => {
  if (e.data === 'ping') e.ports[0]?.postMessage('pong');
});
