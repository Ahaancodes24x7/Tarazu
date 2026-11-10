// API client. On the server build, calls go over HTTP with an offline outbox: a slip
// captured with no signal is queued and synced later. In the mobile app the engine runs
// on the phone itself (engine-worker.js), so every call is answered locally and offline.
const OUTBOX = "tarazu.outbox.v1";

export const EMBEDDED = document.querySelector('meta[name="tarazu-runtime"]')?.content === "embedded";

export class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

// ------------------------------------------------------------ on-device engine
let worker, seq = 0, splash;
const pending = new Map();

function engine() {
  if (worker) return worker;
  worker = new Worker("/assets/js/engine-worker.js");
  worker.onmessage = ({ data }) => {
    if (data.ready) { splash?.remove(); globalThis.__tarazuBoot = data; return; }
    if (data.bootError) {
      if (splash) splash.querySelector("p").textContent = "The engine could not start: " + data.bootError;
      for (const p of pending.values()) p.reject(new ApiError(data.bootError, 500));
      pending.clear();
      return;
    }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new ApiError(data.error, 500));
    else p.resolve(new Response(data.status === 204 ? null : data.body, { status: data.status, headers: data.headers }));
  };
  return worker;
}

function showSplash() {
  if (splash || !document.body) return;
  splash = document.createElement("div");
  splash.id = "engineSplash";
  splash.setAttribute("role", "status");
  splash.style.cssText = "position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:var(--canvas,#0b0f0d);color:var(--ink,#efe8d8);font:500 15px/1.5 var(--font-sans,system-ui);text-align:center;padding:24px";
  splash.innerHTML = '<div><svg width="56" height="56" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M32 8v44M14 52h36M10 20h44"/><path d="M10 20 4 36h12zM54 20l-6 16h12z"/></svg><p>Starting the engine on this phone…</p></div>';
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
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    engine().postMessage({ id, method: opts.method || "GET", path: url.pathname, query: url.search.slice(1),
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

export async function api(path, { method = "GET", body, form } = {}) {
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
