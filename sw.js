const CACHE_NAME = "open-brain-pwa-v11";
const SW_VERSION = "v11-list-duplicate-check";
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


const PUSH_ACTION_URL = "https://prctfnpbftjepdckwpao.supabase.co/functions/v1/push-notification-action";

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : "" };
  }

  const actions = [];
  if (data.kind === "task" && data.action_token) {
    actions.push(
      { action: "done", title: "✅ Done" },
      { action: "snooze30", title: "😴 Snooze 30 min" }
    );
  } else if (data.kind === "habit" && data.action_token) {
    actions.push(
      { action: "done", title: "✅ Done" },
      { action: "open", title: "Open" }
    );
  }

  const silent = data.sound_mode === "silent";
  const options = {
    body: data.body || "You have a new Open Brain reminder.",
    icon: "/openbrain-oauth-ui/icons/icon-192.png",
    badge: "/openbrain-oauth-ui/icons/icon-192.png",
    tag: data.tag || undefined,
    actions,
    silent,
    ...(silent || data.vibrate_enabled === false ? {} : { vibrate: [180, 90, 180] }),
    data: {
      url: data.url || "/openbrain-oauth-ui/dashboard/",
      kind: data.kind || "",
      action_token: data.action_token || ""
    }
  };

  event.waitUntil(self.registration.showNotification(data.title || "Open Brain", options));
});

async function openOpenBrain(targetPath) {
  const target = new URL(targetPath || "/openbrain-oauth-ui/dashboard/", self.location.origin).href;
  const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clientsList) {
    if (client.url.startsWith(self.location.origin + "/openbrain-oauth-ui/") && "focus" in client) {
      await client.focus();
      if ("navigate" in client) await client.navigate(target);
      return;
    }
  }
  if (self.clients.openWindow) await self.clients.openWindow(target);
}

function wait(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function showActionConfirmation(event, info, result){
  const tag = event.notification?.tag || ("open-brain-confirm-" + Date.now());
  let title = "Open Brain";
  let body = result?.message || "Updated.";

  if(result?.action === "snooze30" && result?.snoozed_until){
    const when = new Intl.DateTimeFormat(undefined,{
      hour:"numeric",
      minute:"2-digit"
    }).format(new Date(result.snoozed_until));
    title = "Reminder snoozed";
    body = "Snoozed until " + when + ".";
  }else if(result?.action === "done"){
    title = result?.resource_type === "habit" ? "Habit complete" : "Marked done";
    body = result?.item_title ? result.item_title : (result?.message || "Marked done.");
  }

  event.notification.close();
  await self.registration.showNotification(title,{
    body,
    icon:"/openbrain-oauth-ui/icons/icon-192.png",
    badge:"/openbrain-oauth-ui/icons/icon-192.png",
    tag,
    silent:true,
    renotify:false,
    requireInteraction:true,
    data:{url:info.url || "/openbrain-oauth-ui/dashboard/"}
  });

  await wait(12000);
  const confirmations = await self.registration.getNotifications({tag});
  confirmations.forEach(n => n.close());
}

self.addEventListener("notificationclick", event => {
  const info = event.notification?.data || {};
  const action = event.action || "";

  event.waitUntil((async () => {
    if ((action === "done" || action === "snooze30") && info.action_token) {
      try {
        const response = await fetch(PUSH_ACTION_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: info.action_token, action })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) {
          throw new Error(result.error || "Open Brain could not apply that action.");
        }

        await showActionConfirmation(event, info, result);

        const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of clientsList) {
          client.postMessage({
            type: "open-brain-push-action",
            action,
            message: result.message || "Updated.",
            snoozed_until: result.snoozed_until || null
          });
        }
        return;
      } catch (err) {
        event.notification.close();
        await self.registration.showNotification("Open Brain action failed", {
          body: err?.message || "Open Open Brain to update this reminder.",
          icon: "/openbrain-oauth-ui/icons/icon-192.png",
          tag: "open-brain-action-error",
          silent: true,
          data: { url: info.url || "/openbrain-oauth-ui/dashboard/" }
        });
        return;
      }
    }

    event.notification.close();
    await openOpenBrain(info.url);
  })());
});


self.addEventListener("message", event => {
  if(event.data?.type === "open-brain-get-sw-version"){
    event.source?.postMessage({ type:"open-brain-sw-version", version:SW_VERSION });
  }
});
