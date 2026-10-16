// Keeps the app working with no signal by storing every file on the phone.
// With signal, it always asks the website for the latest files first (so updates
// arrive straight away) and falls back to the stored copy if the network is slow or down.
const VERSION = '2026.10.16-1';
const CACHE = `mileage-${VERSION}`;
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'expenses-ui.js', 'manifest.webmanifest',
  'js/periods.js', 'js/logic.js', 'js/store.js', 'js/idb.js', 'js/files.js',
  'js/expenses.js', 'js/photos.js', 'js/swipe.js', 'js/methods.js',
  'vendor/exceljs.min.js', 'vendor/jszip.min.js', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so we never store an old copy.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => { setTimeout(resolve, NETWORK_TIMEOUT_MS); });
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch { /* offline */ }
    const cached = await cache.match(e.request, { ignoreSearch: true });
    return cached || network;
  })());
});
