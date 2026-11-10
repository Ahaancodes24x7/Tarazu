// API client with an offline outbox: a slip captured with no signal is queued
// in this browser and synced when the connection returns.
const OUTBOX = "tarazu.outbox.v1";

export class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

export async function api(path, { method = "GET", body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
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
