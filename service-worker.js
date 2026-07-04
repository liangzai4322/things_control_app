const CACHE_NAME = 'taskbox-v17-task-context-menu';
const CACHE_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/points-page.js',
  './js/points-store.js',
  './js/points-ai.js',
  './js/db.js',
  './js/home.js',
  './js/box-detail.js',
  './js/lucky-wheel.js',
  './js/ai-extract.js',
  './js/settings.js',
  './js/small-world.js',
  './manifest.json',
  './mock-points.json',
  './data/mock-points.json',
  './sw-v11.js'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(CACHE_FILES)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const isSound = /\/assets\/sounds\/.+\.(mp3|wav|ogg)$/i.test(url.pathname);
  const isSameOrigin = url.origin === self.location.origin;
  const isAppShellAsset = isSameOrigin && (
    url.pathname === '/'
    || url.pathname.endsWith('/index.html')
    || /\.css$/i.test(url.pathname)
    || /\.js$/i.test(url.pathname)
    || /\.json$/i.test(url.pathname)
    || /\/manifest\.json$/i.test(url.pathname)
  );

  if (isSound) {
    e.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, copy));
          return res;
        });
      })
    );
    return;
  }

  if (isAppShellAsset) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error('app_shell_fetch_failed');
      }
    })());
    return;
  }

  e.respondWith(caches.match(request).then((r) => r || fetch(request)));
});
