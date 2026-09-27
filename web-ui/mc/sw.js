// Mission Control service worker — scope /mc/. Network-first so a new dashboard
// deploy is always picked up; the app shell is cached only as an offline fallback.
// API calls live at /api/* (outside this scope) and are never seen/cached here.
const VERSION = "mc-5";
const CACHE = "mc-" + VERSION;
const SHELL = ["/mc/", "/mc/index.html", "/mc/app.js", "/mc/style.css",
               "/mc/manifest.webmanifest", "/mc/icon-192.png", "/mc/icon-512.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting(); // take over immediately on update
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/mc/")) return; // only the redesign shell; API/classic untouched
  // network-first: always try fresh (revalidating), fall back to cache offline
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: "no-store" });
      if (fresh && fresh.ok) {
        const c = await caches.open(CACHE);
        c.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw err;
    }
  })());
});
