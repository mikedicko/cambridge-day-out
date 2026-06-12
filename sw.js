/* Cambridge Day Out — service worker: pre-cache the app shell for offline use. */
const CACHE = 'cambridge-day-v2';
const STOP_IDS = ['station', 'fitzwilliam', 'fitzbillies', 'bridge-clock', 'kings',
  'walk-river', 'punting', 'bookshop', 'eagle', 'dishoom', 'gelato'];
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  ...STOP_IDS.map((id) => `./images/${id}.jpg`),
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only handle same-origin GETs; let Google Maps etc. hit the network directly.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network-first so updates land immediately; cache fallback keeps it working
  // offline on the riverbank.
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() =>
      caches.match(e.request).then((cached) => cached || caches.match('./index.html'))
    )
  );
});
