// API client. On the server build, calls go over HTTP with an offline outbox: a slip
// captured with no signal is queued and synced later. In the mobile app the engine runs
// on the phone itself (engine-worker.js), so every call is answered locally and offline.
const OUTBOX = "tarazu.outbox.v1";

export const EMBEDDED = document.querySelector('meta[name="tarazu-runtime"]')?.content === "embedded";

export class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

// ------------------------------------------------------------ on-device engine
let worker, seq = 0, splash, engineReady = false, usedCache = false;
const pending = new Map();
const readyCallbacks = [];

// Start-up cache (app only). Python takes a few seconds to start on a phone, so the last answers
// to read-only requests are kept on the device: the app opens on them at once, then refreshes
// itself when the engine is ready. Anything that changes data always waits for the engine.
const BOOT_CACHE = "tarazu.bootcache.v1";
const CACHEABLE = /^\/api\/(meta|parties|instruments|jobs)(\/|\?|$)/;
let bootCache = null;
function cacheRead() {
  if (!bootCache) { try { bootCache = JSON.parse(localStorage.getItem(BOOT_CACHE) || "{}"); } catch { bootCache = {}; } }
  return bootCache;
}
let saveTimer = 0;
function cachePut(key, text) {
  const c = cacheRead();
  delete c[key];
  c[key] = text;
  const keys = Object.keys(c);
  for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete c[k];
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(BOOT_CACHE, JSON.stringify(c)); } catch { /* storage full or blocked */ } }, 300);
}

/** Run `cb` once the on-device engine is ready, if the screen was first drawn from the start-up cache. */
export function onEngineReady(cb) {
  if (EMBEDDED && !PARENT && !engineReady) readyCallbacks.push(cb);
}

function engine() {
  if (worker) return worker;
  worker = new Worker("/assets/js/engine-worker.js");
  worker.onmessage = ({ data }) => {
    if (data.ready) {
      engineReady = true;
      splash?.remove();
      globalThis.__tarazuBoot = data;
      if (usedCache) readyCallbacks.splice(0).forEach(cb => { try { cb(); } catch { /* keep going */ } });
      return;
    }
    if (data.bootError) {
      if (splash) splash.querySelector("p").textContent = "The engine could not start: " + data.bootError;
      for (const p of pending.values()) p.reject(new ApiError(data.bootError, 500));
      pending.clear();
      return;
    }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) { p.reject(new ApiError(data.error, 500)); return; }
    if (p.cacheKey && data.status === 200) cachePut(p.cacheKey, new TextDecoder().decode(data.body));
    p.resolve(new Response(data.status === 204 ? null : data.body, { status: data.status, headers: data.headers }));
  };
  return worker;
}

const LOGO = '<svg width="56" height="56" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M32 8v44M14 52h36M10 20h44"/><path d="M10 20 4 36h12zM54 20l-6 16h12z"/></svg>';

function showSplash() {
  if (splash || engineReady || !document.body) return;
  splash = document.createElement("div");
  splash.id = "engineSplash";
  splash.setAttribute("role", "status");
  if (cacheRead()["/api/meta"]) {
    // returning visit: the screen is already drawn from the cache, so only a small note
    splash.style.cssText = "position:fixed;left:50%;bottom:calc(92px + var(--sab,0px));transform:translateX(-50%);z-index:9999;padding:8px 14px;border-radius:999px;background:rgba(14,21,18,.92);color:var(--ink,#efe8d8);border:1px solid rgba(226,194,126,.35);font:500 13px var(--font-sans,system-ui);pointer-events:none";
    splash.innerHTML = "<p style='margin:0'>Starting the engine…</p>";
  } else {
    splash.style.cssText = "position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:var(--canvas,#0b0f0d);color:var(--ink,#efe8d8);font:500 15px/1.5 var(--font-sans,system-ui);text-align:center;padding:24px";
    splash.innerHTML = `<div>${LOGO}<p>Starting the engine on this phone…</p></div>`;
  }
  document.body.append(splash);
}

// A page opened inside the app (the walkthrough) borrows the app's running engine
// instead of starting a second one.
const PARENT = (() => { try { return window.parent !== window ? window.parent.__tarazuFetch : null; } catch { return null; } })();

if (EMBEDDED && !PARENT) {
  engine();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showSplash, { once: true });
  else showSplash();
}

async function localFetch(path, opts) {
  const url = new URL(path, location.origin);
  let body = null;
  const headers = { ...(opts.headers || {}) };
  if (Object.prototype.toString.call(opts.body) === "[object FormData]") {
    const req = new Request(url, { method: opts.method, body: opts.body });
    headers["content-type"] = req.headers.get("content-type");
    body = await req.arrayBuffer();
  } else if (opts.body != null) {
    body = new TextEncoder().encode(opts.body).buffer;
  }
  const method = opts.method || "GET";
  const key = url.pathname + url.search;
  const cacheKey = method === "GET" && CACHEABLE.test(key) ? key : null;
  if (cacheKey && !engineReady) {
    const hit = cacheRead()[cacheKey];
    if (hit !== undefined) {
      usedCache = true;
      return new Response(hit, { status: 200, headers: { "content-type": "application/json", "x-tarazu-cache": "boot" } });
    }
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, cacheKey });
    engine().postMessage({ id, method, path: url.pathname, query: url.search.slice(1),
      headers: Object.entries(headers), body }, body ? [body] : []);
  });
}

/** fetch() for /api paths, answered by the server or by the on-device engine. */
export function apiFetch(path, opts = {}) {
  if (!EMBEDDED) return fetch(path, opts);
  return PARENT ? PARENT(path, opts) : localFetch(path, opts);
}

// ------------------------------------------------------- walkthrough in the app
let walk;
export function openWalkthrough() {
  if (!EMBEDDED || PARENT) { location.href = "/demo.html"; return; }
  if (walk) return;
  walk = document.createElement("iframe");
  walk.src = "/demo.html";
  walk.title = "Guided walkthrough";
  walk.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:95;background:var(--canvas,#0b0f0d)";
  document.body.append(walk);
  history.pushState({ walk: 1 }, "");
}
function closeWalkthrough() {
  if (!walk) return;
  walk.remove();
  walk = null;
}

if (EMBEDDED && !PARENT) {
  window.__tarazuFetch = localFetch;
  window.__tarazuCloseWalk = () => { if (walk) history.back(); };
  addEventListener("popstate", closeWalkthrough);  // the phone's back button closes the walkthrough
}
if (EMBEDDED) {
  document.addEventListener("click", e => {
    const a = e.target.closest('a[href="/demo.html"], a[href="/app.html"]');
    if (!a) return;
    if (a.getAttribute("href") === "/demo.html" && !PARENT) { e.preventDefault(); openWalkthrough(); }
    else if (a.getAttribute("href") === "/app.html" && PARENT) { e.preventDefault(); window.parent.__tarazuCloseWalk(); }
  });
}

// Identical GETs started within a moment of each other share one request (the first screen
// asks for the same data from several places). Any write clears this, so data is never stale.
const recentGets = new Map();
const SHARE_MS = 1500;

export function api(path, { method = "GET", body, form } = {}) {
  if (method !== "GET" || form) {
    recentGets.clear();
    return request(path, method, body, form);
  }
  const now = performance.now();
  const hit = recentGets.get(path);
  if (hit && now - hit.at < SHARE_MS) return hit.p.then(d => (typeof d === "object" && d !== null ? structuredClone(d) : d));
  const p = request(path, method, body, form);
  recentGets.set(path, { at: now, p });
  p.catch(() => recentGets.delete(path));
  return p;
}

async function request(path, method, body, form) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  let res;
  try {
    res = await apiFetch(path, opts);
  } catch (e) {
    if (e && typeof e.status === "number") throw new ApiError(e.message, e.status);  // may come from the app's realm
    throw new ApiError("offline", 0);
  }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    let msg = typeof data === "string" ? data : data.detail;
    if (Array.isArray(msg)) msg = msg.map(d => `${(d.loc || []).slice(-1)[0]}: ${d.msg}`).join("; ");
    throw new ApiError(msg || `Request failed (${res.status})`, res.status);
  }
  return data;
}

/** An object URL for a binary API resource (slip photos). */
export async function apiObjectURL(path) {
  const res = await apiFetch(path);
  if (!res.ok) throw new ApiError("Not found", res.status);
  return URL.createObjectURL(await res.blob());
}

/** Save an API download. In the app it opens the phone's share sheet; on the web it downloads. */
export async function apiDownload(path, filename) {
  const res = await apiFetch(path);
  if (!res.ok) throw new ApiError(`Download failed (${res.status})`, res.status);
  const text = await res.text();
  const cap = globalThis.Capacitor;
  const fs = cap?.Plugins?.Filesystem, share = cap?.Plugins?.Share;
  if (cap?.isNativePlatform?.() && fs && share) {
    const { uri } = await fs.writeFile({ path: filename, data: text, directory: "CACHE", encoding: "utf8" });
    await share.share({ title: filename, files: [uri] });
    return;
  }
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], { type: res.headers.get("content-type") || "text/plain" })), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ------------------------------------------------------------------ outbox
function readBox() { try { return JSON.parse(localStorage.getItem(OUTBOX) || "[]"); } catch { return []; } }
function writeBox(b) { try { localStorage.setItem(OUTBOX, JSON.stringify(b)); } catch {} }

export function outboxCount() { return readBox().length; }

/** POST that falls back to the outbox when the network is down. */
export async function postOrQueue(path, body) {
  try {
    return { queued: false, data: await api(path, { method: "POST", body }) };
  } catch (e) {
    if (e.status === 0) {
      const box = readBox();
      box.push({ path, body, at: new Date().toISOString() });
      writeBox(box);
      return { queued: true };
    }
    throw e;
  }
}

export async function flushOutbox(onEach) {
  const box = readBox();
  if (!box.length) return { sent: 0, failed: 0 };
  const keep = [];
  let sent = 0, failed = 0;
  for (const item of box) {
    try {
      await api(item.path, { method: "POST", body: item.body });
      sent++;
      onEach && onEach(item, null);
    } catch (e) {
      if (e.status === 0) keep.push(item);
      else { failed++; onEach && onEach(item, e); }
    }
  }
  writeBox(keep);
  return { sent, failed, left: keep.length };
}
