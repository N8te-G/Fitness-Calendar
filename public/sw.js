// Service worker: shows the morning check-in reminder when a push arrives.
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Tell the app a push arrived, so the reminder panel can show it reached this phone.
async function report(error) {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await fetch("/api/reminder/received", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Requested-With": "wellness-watch" },
      body: JSON.stringify({ endpoint: sub.endpoint, error: error || "" }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // Reporting is best-effort.
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let body = "How do you feel today? It takes 10 seconds.";
    try {
      // Uses the same login cookie as the app; if it has expired we fall back to the plain text.
      // Give up after 4 seconds so the reminder always shows promptly.
      const res = await fetch(`/api/state?today=${today()}`, { credentials: "include", signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const state = await res.json();
        const day = state.days?.find((d) => d.date === today());
        const label = { watch: "Watch", elevated: "Elevated", high: "High" }[day?.level];
        if (label) body = `Illness risk: ${label}. How do you feel today?`;
      }
    } catch {
      // Offline or logged out: plain reminder.
    }
    let error = "";
    try {
      await self.registration.showNotification("Wellness Watch check-in", {
        body,
        tag: "checkin",
        renotify: true,
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        data: { url: "/#checkin" },
      });
    } catch (err) {
      error = err.message || String(err);
      // Last resort: the plainest possible notification.
      await self.registration.showNotification("Wellness Watch check-in", { body }).catch(() => {});
    }
    await report(error);
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
