// Offline shell: the app opens with no signal; records are queued by api.js and synced later.
const CACHE = "tarazu-shell-v6";
const FONTS = "tarazu-fonts-v1"; // web fonts are cached after first load so typography survives offline
const SHELL = ["/", "/index.html", "/app", "/app.html", "/demo.html", "/manifest.webmanifest", "/assets/img/tarazu.svg",
  "/assets/css/base.css", "/assets/css/landing.css", "/assets/css/app.css", "/assets/css/chalk.css", "/assets/css/tour.css", "/assets/css/motion.css",
  "/assets/js/api.js", "/assets/js/charts.js", "/assets/js/speech.js", "/assets/js/i18n.js", "/assets/js/icons.js", "/assets/js/ui.js", "/assets/js/bench.js",
  "/assets/js/app.js", "/assets/js/landing.js", "/assets/js/chalk.js", "/assets/js/tour.js"];

self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== FONTS).map(k => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    // cache first: font files are immutable; the stylesheet is refreshed in the background
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok || r.type === "opaque") c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) {
    // network first; keep the last good answer for reading while offline
    e.respondWith(fetch(e.request).then(r => {
      const copy = r.clone();
      if (r.ok) caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || new Response(JSON.stringify({ detail: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } }))));
    return;
  }
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone();
    if (r.ok) caches.open(CACHE).then(c => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match("/app.html"))));
});
