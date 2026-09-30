// App-shell cache. MBTA API requests always go to the network.
const CACHE = 'mbta-leave-by-v2';
const SHELL = ['./', 'index.html', 'core.js', 'manifest.json', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Network-first so new deploys show up immediately; cache is the offline fallback.
  event.respondWith(
    // no-cache: revalidate with the server instead of trusting the 10-min HTTP cache.
    // (A fresh Request: navigation requests cannot be re-fetched with an init object.)
    fetch(new Request(event.request.url, { cache: 'no-cache' }))
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
