const CACHE_NAME = "open-brain-pwa-v1";
const APP_SHELL = [
  "/openbrain-oauth-ui/dashboard/",
  "/openbrain-oauth-ui/manifest.webmanifest",
  "/openbrain-oauth-ui/icons/icon-192.png",
  "/openbrain-oauth-ui/icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put("/openbrain-oauth-ui/dashboard/", copy));
          return response;
        })
        .catch(() => caches.match("/openbrain-oauth-ui/dashboard/"))
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      }))
    );
    return;
  }

  if (url.hostname === "cdn.jsdelivr.net") {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(request);
        const network = fetch(request).then(response => {
          cache.put(request, response.clone()).catch(() => {});
          return response;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
