// App-shell cache. MBTA API requests always go to the network.
const CACHE = 't-minus-v1';
const SHELL = ['./', 'index.html', 'core.js', 'setup.js', 'manifest.json', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

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

// Network-first so new deploys show up immediately. The cache is the fallback when the server
// fails (5xx), is slow (no answer in 3 s; the request keeps running and still updates the
// cache), or is unreachable. The first two use an exact match (with the `?v=` query) so a new
// page never runs against an old cached module; offline ignores the query (the cached shell is
// self-consistent).
const TIMEOUT_MS = 3000;

// The latest navigation: served from the cache, and whether a newer page has since been saved.
let lastNav = { cached: false, updated: false };

async function postNav() {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'nav', ...lastNav });
}

// no-cache: revalidate with the server instead of trusting the 10-min HTTP cache.
// (A fresh Request: navigation requests cannot be re-fetched with an init object.)
async function fetchAndSave(request) {
  const res = await fetch(new Request(request.url, { cache: 'no-cache' }));
  if (res.ok) await caches.open(CACHE).then(c => c.put(request, res.clone()));
  return res;
}

self.addEventListener('message', event => {
  if (event.data === 'nav-status') event.source?.postMessage({ type: 'nav', ...lastNav });
});

// Leave-time reminders from the push server (server/): { title, body, tag }.
self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  event.waitUntil(self.registration.showNotification(data.title ?? 'T-Minus', {
    body: data.body ?? '', tag: data.tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
  }));
});

// Tapping a notification opens the app (or brings it to the front).
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const [client] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (client) return client.focus();
    return self.clients.openWindow('./');
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Versioned modules (`?v=<content hash>`) never change: a cached copy is served directly.
  if (url.searchParams.has('v')) {
    event.respondWith(caches.match(event.request).then(c => c ?? fetchAndSave(event.request))
      .catch(async () => (await caches.match(event.request, { ignoreSearch: true })) ?? Response.error()));
    return;
  }
  const nav = event.request.mode === 'navigate';
  if (nav) lastNav = { cached: false, updated: false };
  // Exact match; its text is kept for navigations to compare with a late network response.
  const cached = caches.match(event.request).then(async res => res && { res, text: nav ? await res.clone().text() : null });
  const net = fetchAndSave(event.request);
  let fromCache = false;
  const useCache = c => { fromCache = true; if (nav) lastNav = { cached: true, updated: false }; return c.res; };
  // After serving the cache: a newer page saved → "updated"; the same page → not a stale copy.
  if (nav) event.waitUntil(net.then(async res => {
    if (!fromCache || !res.ok) return;
    const [fresh, c] = await Promise.all([res.clone().text(), cached]);
    lastNav = fresh === c?.text ? { cached: false, updated: false } : { cached: true, updated: true };
    await postNav();
  }).catch(() => {}));
  else event.waitUntil(net.catch(() => {}));
  event.respondWith(new Promise(resolve => {
    let done = false;
    const finish = res => { if (!done) { done = true; resolve(res); } };
    const timer = setTimeout(() => cached.then(c => c && !done && finish(useCache(c))), TIMEOUT_MS);
    net.then(async res => {
      if (done || res.status < 500) return res;
      const c = await cached;
      return c ? useCache(c) : res;
    })
      .catch(async () => {
        if (done) return null;
        const res = await caches.match(event.request, { ignoreSearch: true });
        if (res) { fromCache = true; if (nav) lastNav = { cached: true, updated: false }; }
        return res ?? Response.error();
      })
      .then(res => { clearTimeout(timer); finish(res); });
  }));
});
