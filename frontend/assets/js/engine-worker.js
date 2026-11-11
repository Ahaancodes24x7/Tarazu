// The Tarazu engine inside the app: the same Python code as the server, running in
// WebAssembly (Pyodide) in a background worker, so the screen never freezes while it
// works. Records live in SQLite on the device and are saved to IndexedDB after every change.
/* global loadPyodide */
// Some WebViews serve .wasm without the application/wasm type, which breaks streaming
// compilation; compiling from the downloaded bytes works everywhere.
const _streaming = WebAssembly.instantiateStreaming?.bind(WebAssembly);
WebAssembly.instantiateStreaming = async (source, imports) => {
  const res = await source;
  if (_streaming && (res.headers.get("content-type") || "").startsWith("application/wasm")) {
    try { return await _streaming(res.clone(), imports); } catch { /* fall back below */ }
  }
  return WebAssembly.instantiate(await res.arrayBuffer(), imports);
};
importScripts("/pyodide/pyodide.js");

const BOOT = `
import os, sys
sys.path.insert(0, "/lib/site.zip")
os.environ["TARAZU_DATA"] = "/data"
from tarazu import lite
lite.install()  # same endpoints and validation, without a web framework's start-up cost
from tarazu.api import app

async def handle(method, path, query, headers, body):
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
             "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": query.encode(),
             "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers],
             "server": ("app", 80), "client": ("app", 0), "root_path": ""}
    payload = bytes(body) if body is not None else b""
    done = False
    async def receive():
        nonlocal done
        if done:
            return {"type": "http.disconnect"}
        done = True
        return {"type": "http.request", "body": payload, "more_body": False}
    out = {"status": 500, "headers": [], "body": bytearray()}
    async def send(msg):
        if msg["type"] == "http.response.start":
            out["status"] = msg["status"]
            out["headers"] = [[k.decode("latin-1"), v.decode("latin-1")] for k, v in msg.get("headers", [])]
        elif msg["type"] == "http.response.body":
            out["body"] += msg.get("body", b"")
    await app(scope, receive, send)
    return out["status"], out["headers"], bytes(out["body"])
`;

let py, handle, saveTimer;

function persist(populate) {
  return new Promise((ok, fail) => py.FS.syncfs(populate, err => (err ? fail(err) : ok())));
}

async function boot() {
  const t0 = performance.now(), marks = {};
  const mark = k => { marks[k] = Math.round(performance.now() - t0); };
  // Overlap everything that does not depend on Python being up: the manifest and the bytecode
  // archive download while WebAssembly compiles; the saved records load while packages install.
  const manifestP = fetch("/py/manifest.json").then(r => r.json());
  const siteP = manifestP.then(m => fetch("/py/" + m.site)).then(r => r.arrayBuffer());
  py = await loadPyodide({ indexURL: "/pyodide/", fullStdLib: false });
  mark("pyodide");
  const manifest = await manifestP;
  await Promise.all([
    py.loadPackage(manifest.pyodide, { messageCallback: () => {} }).then(() => mark("packages")),
    (async () => {
      py.FS.mkdirTree("/lib");
      py.FS.writeFile("/lib/site.zip", new Uint8Array(await siteP));
      py.FS.mkdirTree("/data");
      py.FS.mount(py.FS.filesystems.IDBFS, {}, "/data");
      await persist(true);
      mark("files");
    })(),
  ]);
  await py.runPythonAsync(BOOT);
  mark("imports");
  handle = py.globals.get("handle");
  return { ms: Math.round(performance.now() - t0), marks, version: manifest.version };
}

const ready = boot();
ready.then(info => postMessage({ ready: true, ...info })).catch(e => postMessage({ bootError: String(e && e.message || e) }));

self.onmessage = async ({ data: m }) => {
  try {
    await ready;
    const res = await handle(m.method, m.path, m.query, py.toPy(m.headers), m.body ? py.toPy(new Uint8Array(m.body)) : null);
    const [status, headers, body] = res.toJs();
    res.destroy();
    const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    postMessage({ id: m.id, status, headers, body: buf }, [buf]);
    if (m.method !== "GET" && status < 400) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => persist(false).catch(() => {}), 250);
    }
  } catch (e) {
    postMessage({ id: m.id, error: String(e && e.message || e) });
  }
};
