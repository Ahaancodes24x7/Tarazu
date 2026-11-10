// Guided project tour: a spotlight walks through the landing page, then continues in the workspace.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SEEN = "tarazu.tour.seen";
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } },
};
const isApp = !!$("#nav");
const narrow = () => innerWidth < 1024;
const openSide = () => { if (isApp && narrow()) $("#side")?.classList.add("open"); };
const closeSide = () => { if (isApp && narrow()) $("#side")?.classList.remove("open"); };

const LANDING = [
  { sel: "#heroTitle", title: "What Tarazu is for", text: "When the fine metal a karigar returns doesn't match what was issued, Tarazu helps both sides find out <b>why</b>, from the records, without blaming anyone." },
  { sel: "#scale", title: "The balance", text: "Tap a pan, or use the arrow keys, to place a weight. The beam answers. In the workspace the same idea runs on real records: what was issued against what came back." },
  { sel: "#tag", title: "Three languages", text: "English, हिन्दी and ਪੰਜਾਬੀ throughout. Metal is only ever “unaccounted for”, never missing or stolen." },
  { sel: "#cta .lbtn-secondary", title: "Guided walkthrough", text: "A chalkboard walkthrough of one dispute, step by step, computed by the engine as you watch." },
  { sel: "#ctaApp", title: "Next: your workspace", text: "Real jobs live here: records, investigations, corrections and settlements. Continue the tour there?", next: "Continue in the workspace", go: "/app.html?tour=1#jobs" },
];

const APP = [
  { sel: "#acctBtn", title: "Demo view and language", text: "Switch between the <b>jeweller</b> and one <b>karigar</b>, and between English, हिन्दी and ਪੰਜਾਬੀ. This is not a login; the server still refuses another karigar's jobs." },
  { sel: "#nav a[data-view=jobs]", title: "The workshop", text: "Every job on the bench, with its difference, review state and next step.", action: () => { if (location.hash !== "#jobs") location.hash = "#jobs"; } },
  { sel: () => $("#spectrum") || $("#jobsBody"), title: "Difference spectrum", text: "Each mark is a job placed by its fine-metal difference: unaccounted to the left, returned beyond issue to the right. Drag across the line to filter." },
  { sel: () => $(".jcard") || $("#seed") || $("#jobsBody"), title: "The shelf",
    text: () => $("#seed") ? "Load the sample workshop to get five synthetic cases, each labelled Sample." : "Each card carries a small balance tilted by that job's real state. Open one to work on its bench: preview explanations, replay the records, record checks and sign." },
  { sel: "#cmdBtn", title: "Search anything", text: "Press <b>Ctrl K</b> or <b>/</b> to jump to any job, page or action. Press <b>?</b> for all shortcuts." },
  { sel: "#nav a[data-view=instruments]", title: "Instruments", text: "Each scale's measurement bound, and a guided calibration that derives it from repeat readings of a certified weight." },
  { sel: "#nav a[data-view=eval]", title: "Evaluation", text: "How the engine performs on a synthetic workshop with faults injected blind. Clearly marked as simulated." },
  { sel: "#nav a[data-view=settings]", title: "Units & settings", text: "Tola, masha and ratti conversion computed by the server, offline sync and sample data." },
  { sel: "#nav .nav-ext", title: "Guided walkthrough", text: "A chalkboard walkthrough of one dispute, step by step." },
  { sel: "#sync", title: "Connection and sync", text: "Whether the server is reachable, and how many records saved offline are still waiting to be sent." },
  { sel: "#acctBtn", title: "That's the tour", text: "Replay it any time from this menu.", next: "Finish" },
];

let ui = null, steps = [], idx = 0, raf = 0;

function build() {
  ui = document.createElement("div");
  ui.className = "tour";
  ui.innerHTML = `<div class="tour-block"></div><div class="tour-spot"></div>
    <div class="tour-pop" role="dialog" aria-modal="true" aria-labelledby="tourT" aria-describedby="tourP" tabindex="-1">
      <div class="tour-meta"><span id="tourN"></span><button type="button" class="tour-x" aria-label="Close tour">✕</button></div>
      <h3 id="tourT"></h3><p id="tourP"></p>
      <div class="tour-dots" id="tourDots" aria-hidden="true"></div>
      <div class="tour-act"><button type="button" class="btn sm quiet" id="tourBack">Back</button><button type="button" class="btn sm primary" id="tourNext">Next</button></div>
    </div>`;
  document.body.appendChild(ui);
  $(".tour-x", ui).addEventListener("click", end);
  $("#tourBack", ui).addEventListener("click", () => show(idx - 1));
  $("#tourNext", ui).addEventListener("click", next);
  addEventListener("keydown", onKey, true);
}
function onKey(e) {
  if (!ui) return;
  if (e.key === "Escape") { e.stopPropagation(); end(); }
  else if (e.key === "ArrowRight") next();
  else if (e.key === "ArrowLeft" && idx > 0) show(idx - 1);
  else if (e.key === "Tab") {
    const f = $$("button", $(".tour-pop", ui)).filter(b => b.style.visibility !== "hidden");
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}
function next() {
  const s = steps[idx];
  if (s.go) { store.set(SEEN, "1"); location.href = s.go; return; }
  if (idx >= steps.length - 1) { end(); return; }
  show(idx + 1);
}
function target(s) {
  const el = typeof s.sel === "function" ? s.sel() : $(s.sel);
  return el && el.getClientRects().length ? el : null;
}
function show(i) {
  idx = Math.max(0, Math.min(steps.length - 1, i));
  const s = steps[idx];
  s.before?.(); s.action?.();
  setTimeout(() => {
    const el = target(s);
    if (el) el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    $("#tourN", ui).textContent = `${idx + 1} of ${steps.length}`;
    $("#tourT", ui).textContent = s.title;
    $("#tourP", ui).innerHTML = typeof s.text === "function" ? s.text() : s.text;
    $("#tourDots", ui).innerHTML = steps.map((_, j) => `<i class="${j === idx ? "on" : j < idx ? "done" : ""}"></i>`).join("");
    $("#tourBack", ui).style.visibility = idx ? "visible" : "hidden";
    $("#tourNext", ui).textContent = s.next || (idx === steps.length - 1 ? "Finish" : "Next");
    $("#tourNext", ui).focus({ preventScroll: true });
  }, s.action ? 300 : 80);
}
function place() {
  if (!ui) return;
  const s = steps[idx], el = s && target(s);
  const spot = $(".tour-spot", ui), pop = $(".tour-pop", ui);
  const pw = pop.offsetWidth, ph = pop.offsetHeight, m = 12;
  if (el) {
    const r = el.getBoundingClientRect(), pad = 6;
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`, opacity: 1 });
    let top = r.bottom + pad + m;
    if (top + ph > innerHeight - m) top = r.top - pad - m - ph;
    if (top < m) top = Math.min(innerHeight - ph - m, Math.max(m, r.top + r.height / 2 - ph / 2));
    let left = r.left + r.width / 2 - pw / 2;
    if (r.right + pw + m * 2 < innerWidth && (top + ph > r.top && top < r.bottom)) left = r.right + pad + m;
    left = Math.min(innerWidth - pw - m, Math.max(m, left));
    pop.style.left = `${left}px`; pop.style.top = `${top}px`;
  } else {
    Object.assign(spot.style, { width: "0px", height: "0px", opacity: 0 });
    pop.style.left = `${(innerWidth - pw) / 2}px`; pop.style.top = `${(innerHeight - ph) / 2}px`;
  }
  raf = requestAnimationFrame(place);
}
export function startTour() {
  if (ui) end();
  steps = isApp ? APP : LANDING;
  build();
  $(".tour-nudge")?.remove();
  idx = 0; show(0);
  cancelAnimationFrame(raf); raf = requestAnimationFrame(place);
}
function end() {
  if (!ui) return;
  cancelAnimationFrame(raf);
  removeEventListener("keydown", onKey, true);
  ui.remove(); ui = null;
  store.set(SEEN, "1");
  closeSide();
  if (isApp && location.search.includes("tour=1")) history.replaceState(null, "", location.pathname + location.hash);
}

$$("[data-tour-start]").forEach(b => b.addEventListener("click", startTour));

if (isApp) {
  $("#tourBtn")?.addEventListener("click", startTour);
  if (new URLSearchParams(location.search).get("tour") === "1") {
    let n = 0;
    const wait = () => ($("#main")?.children.length && !$("#main .skel") || n++ > 40 ? startTour() : setTimeout(wait, 100));
    wait();
  }
} else if (!store.get(SEEN)) {
  // first visit: a small, dismissible offer rather than an interruption
  setTimeout(() => {
    if (ui || store.get(SEEN)) return;
    const n = document.createElement("div");
    n.className = "tour-nudge"; n.setAttribute("role", "region"); n.setAttribute("aria-label", "Tour offer");
    n.innerHTML = `<span>New here? A one-minute tour shows what each part does.</span>
      <button type="button" class="btn sm primary">Take the tour</button><button type="button" class="tour-x" aria-label="Dismiss">✕</button>`;
    document.body.appendChild(n);
    $(".btn", n).addEventListener("click", startTour);
    $(".tour-x", n).addEventListener("click", () => { n.remove(); store.set(SEEN, "1"); });
  }, 4000);
}
