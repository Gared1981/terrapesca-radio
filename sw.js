// Radio Terrapesca Service Worker - PWA & Background Audio Engine
// Mantiene activos los recursos en segundo plano y caché inteligente

const CACHE = 'terrapesca-radio-v7';
const STATIC = [
  '/',
  '/index.html',
  '/listen.html',
  '/studio.html',
  '/sucursal.html',
  '/manifest.json',
  '/buenfin/logo_terrapesca_marine.png',
  '/buenfin/logo_buen_fin.png',
  '/icon-192.png',
  '/icon-512.png'
];

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
  self.clients.claim().then(() => {
    self.clients.matchAll({ type: 'window' }).then(clients => {
      clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
    });
  });
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept audio streams or real-time APIs — let them stream natively
  if (url.pathname.startsWith('/radio/stream') ||
      url.pathname.startsWith('/live.mp3') ||
      url.pathname.startsWith('/stream.mp3') ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/ws') ||
      url.pathname.startsWith('/rodo/') ||
      url.pathname.startsWith('/spots/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Network-first for HTML pages: siempre sirve la versión fresca desplegada,
  // con fallback a la caché si se pierde la conexión.
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});

// Keep alive: responde a pulsos ping de la página para evitar que el Service Worker se duerma
self.addEventListener('message', e => {
  if (e.data === 'ping') e.ports[0]?.postMessage('pong');
});
