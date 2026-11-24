// Service worker: shows the morning check-in reminder when a push arrives.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let title = "Wellness Watch check-in";
    let body = "How do you feel today? It takes 10 seconds.";
    let message = null;
    try {
      message = event.data ? event.data.json() : null;
    } catch {
      message = null;
    }
    if (message) {
      title = message.title || title;
      body = message.body || body;
    }
    try {
      await self.registration.showNotification(title, {
        body,
        tag: "checkin",
        renotify: true,
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        data: { url: "/#checkin" },
      });
    } catch {
      // Last resort: the plainest possible notification.
      await self.registration.showNotification(title, { body }).catch(() => {});
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.navigate?.("/#checkin");
    } else {
      await self.clients.openWindow("/#checkin");
    }
  })());
});
