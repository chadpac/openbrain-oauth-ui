const CACHE_NAME = "open-brain-pwa-v2";
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


self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Open Brain";
  const options = {
    body: data.body || "You have a new Open Brain reminder.",
    icon: "/openbrain-oauth-ui/icons/icon-192.png",
    badge: "/openbrain-oauth-ui/icons/icon-192.png",
    tag: data.tag || undefined,
    data: {
      url: data.url || "/openbrain-oauth-ui/dashboard/"
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(
    event.notification?.data?.url || "/openbrain-oauth-ui/dashboard/",
    self.location.origin
  ).href;

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clientsList) {
      if (client.url.startsWith(self.location.origin + "/openbrain-oauth-ui/") && "focus" in client) {
        await client.focus();
        if ("navigate" in client) await client.navigate(target);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
