const CACHE_NAME = 'taskbox-v32-task-visibility';
const CACHE_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/points-store.js',
  './js/db.js',
  './js/task-utils.js',
  './js/task-visibility.js',
  './js/box-types.js',
  './js/box-type-sheet.js',
  './js/core-box-nav.js',
  './js/mainline-fields.js',
  './js/mainline-page.js',
  './js/recurrence.js',
  './js/recurrence-ui.js',
  './js/home.js',
  './js/box-detail.js',
  './manifest.json',
  './service-worker.js'
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
    const refresh = fetch(request).then(async (fresh) => {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, fresh.clone());
      return fresh;
    });
    e.waitUntil(refresh.then(() => undefined).catch(() => {}));
    e.respondWith(caches.match(request).then((cached) => cached || refresh));
    return;
  }

  e.respondWith(caches.match(request).then((r) => r || fetch(request)));
});
