// Offline cache: everything the app needs, cache-first. Bump CACHE on each release.
const CACHE = 'fledgling-poc-8.1';
const FILES = ['./', 'index.html', 'i18n.js', 'research.js', 'app.js', 'icon.svg', 'worker.js', 'voicecore.js', 'world.wasm', 'sample.wav',
  'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
