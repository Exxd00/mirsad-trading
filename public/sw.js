/* Only public offline assets are cached. Never cache API, navigations, credentials or financial data. */
const STATIC_CACHE = "mirsad-public-v1";
const PUBLIC_FILES = ["/offline.html", "/icon.svg", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", event => { event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.addAll(PUBLIC_FILES))); self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("mirsad-public-") && key !== STATIC_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate") { event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html"))); return; }
  if (PUBLIC_FILES.includes(url.pathname)) event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
