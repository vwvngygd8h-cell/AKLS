const CACHE = 'kennzeichen-waechter-v5';
const LOCAL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((c) => c.addAll(LOCAL))));
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
