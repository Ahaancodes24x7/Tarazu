// Mobile preview: drives the live workspace inside the device frame.
const $ = s => document.querySelector(s);
const screen = $("#screen"), device = $("#device");
const APP_ORIGIN = `${location.protocol}//${location.hostname}:8100`;
let engine = "server";

const base = () => (engine === "app" ? `${APP_ORIGIN}/index.html` : "/app.html");
const walkURL = () => (engine === "app" ? `${APP_ORIGIN}/demo.html` : "/demo.html");

function fit() {
  // scale the whole device so it always fits the window height
  const w = parseFloat(getComputedStyle(device).getPropertyValue("--w")) + 28;
  const h = parseFloat(getComputedStyle(device).getPropertyValue("--h")) + 28;
  const avail = Math.min(innerHeight - 70, innerWidth - 32);
  const s = Math.min(1, avail / h, (innerWidth - 32) / w);
  device.style.transform = `scale(${s})`;
  device.style.marginBottom = `${-(1 - s) * h}px`;
  device.style.marginLeft = device.style.marginRight = `${-(1 - s) * w / 2}px`;
}

function tick() {
  const d = new Date();
  $("#clock").textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function refreshSeedHint() {
  if (engine !== "server") { $("#seedHint").hidden = true; return; }
  try { $("#seedHint").hidden = (await api("/api/jobs")).length > 0; } catch { $("#seedHint").hidden = true; }
}

async function go(target) {
  if (target === "walk") { screen.src = walkURL(); return; }
  if (target === "tour") { screen.src = `${engine === "app" ? `${APP_ORIGIN}/index.html` : "/app.html"}?tour=1#jobs`; return; }
  if (target === "case") {
    let id = null;
    if (engine === "server") {
      try {
        const jobs = await api("/api/jobs");
        id = (jobs.find(j => /worked example/i.test(j.title)) || jobs.find(j => j.verdict === "unaccounted") || jobs[0])?.job_id;
      } catch { /* fall through to the workshop */ }
    } else {
      // the offline build has its own storage: open the workshop and let the viewer pick the case
      target = "#jobs";
    }
    target = id ? `#job/${id}` : "#jobs";
  }
  const url = base() + target;
  const sameDoc = screen.contentWindow && screen.src.split("#")[0] === new URL(base(), location.href).href;
  if (sameDoc) {
    try { screen.contentWindow.location.hash = target; return; } catch { /* cross-origin: reload instead */ }
  }
  screen.src = url;
}

document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go(b.dataset.go)));

$("#seed").addEventListener("click", async () => {
  try { await api("/api/demo/seed", { method: "POST" }); } catch { /* already seeded */ }
  $("#seedHint").hidden = true;
  try { screen.contentWindow.location.hash = "#jobs"; screen.contentWindow.location.reload(); }
  catch { screen.src = "/app.html#jobs"; }
});

$("#devices").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  document.querySelectorAll("#devices button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  device.style.setProperty("--w", `${b.dataset.w}px`);
  device.style.setProperty("--h", `${b.dataset.h}px`);
  fit();
});

$("#engines").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  engine = b.dataset.engine;
  document.querySelectorAll("#engines button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  $("#engineNote").textContent = engine === "app"
    ? "The engine now runs inside the phone screen itself (WebAssembly), with its own storage and no network. The first start takes a few seconds."
    : "The screen is served by the Tarazu server on this computer.";
  $("#caption").textContent = engine === "app" ? "Offline app build · engine on the phone" : "Live · tap inside the phone";
  screen.src = base() + "#jobs";
  refreshSeedHint();
});

// Is the offline app build being served (python tools/serve_app.py)?
fetch(`${APP_ORIGIN}/py/manifest.json`, { mode: "no-cors", cache: "no-store" })
  .then(() => { $("#appEngine").disabled = false; })
  .catch(() => {});

if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
  $("#lan").innerHTML = `On a phone on the same Wi-Fi, open <code>${location.origin}/app.html</code>.`;
}

addEventListener("resize", fit);
fit();
tick();
setInterval(tick, 15000);
refreshSeedHint();
