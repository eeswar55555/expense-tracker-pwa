// Offline app shell. Network-first (with a short timeout) for our own files, so a
// new version pushed to GitHub Pages shows up on the next open while online,
// falling back to the cache when offline. Cross-origin calls (the Apps Script
// sync endpoint) are never intercepted or cached.

const CACHE = 'expense-tracker-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './css/entry.css',
  './css/history.css',
  './css/dashboard.css',
  './css/setup.css',
  './js/app.js',
  './js/util.js',
  './js/store.js',
  './js/sync.js',
  './js/recurring.js',
  './js/analytics.js',
  './js/charts.js',
  './js/views/add.js',
  './js/views/history.js',
  './js/views/dashboard.js',
  './js/views/setup.js',
  './js/views/entry-form.js',
  './js/views/due.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([
        fetch(req),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500)),
      ]);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req, { ignoreSearch: true })) ||
             (req.mode === 'navigate' ? cache.match('./index.html') : Response.error());
    }
  })());
});
