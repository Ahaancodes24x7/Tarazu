// Tarazu workbench. All balances, explanations, checks and conversions come from the server;
// this file lays them out, collects input and sends it back through the existing endpoints.
import { api, postOrQueue, flushOutbox, outboxCount } from "./api.js";
import { drawLines, drawBars } from "./charts.js";
import { speak } from "./speech.js";
import { t } from "./i18n.js";
import { icon } from "./icons.js";
import { $, $$, esc, g3, when, ago, statusLabel, balanceStrip, toleranceLine, toast, openDialog, openDrawer } from "./ui.js";
import { Bench, miniBalance, tiltForJob, spectrumSVG, specX, SPEC, fitSpectrum } from "./bench.js";

const store = {
  get(k, d) { try { const v = localStorage.getItem("tarazu." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("tarazu." + k, JSON.stringify(v)); } catch { /* storage unavailable: keep in memory */ } },
};
const S = {
  role: store.get("role", "jeweller"), viewer: store.get("viewer", ""), lang: store.get("lang", "en"),
  parties: [], meta: null, instruments: [], job: null, selected: "", changes: null,
  ui: { q: "", filter: "all", sort: "updated", view: "shelf", brush: null, ...store.get("jobsUI", {}) },
};
const L = k => t(S.lang, k);
const main = $("#main");
const TYPES = ["ISSUE", "RETURN_FINISHED", "RETURN_SCRAP", "WIP_HOLD", "ALLOY_ADD", "STONE_SET", "TRANSFER"];
const typeName = ty => (S.meta?.type_label?.[S.lang] || S.meta?.type_label?.en || {})[ty] || ty.replace(/_/g, " ").toLowerCase();
// which check directly tests each hypothesis (mirrors the engine's check catalogue)
const HYP_CHECK = { H1: "count_pieces", H2: "weigh_scrap_bag", H3: "weigh_bench", H4: "assay", H5: "reweigh", H6: "photo", H7: "dup_match", H8: "weigh_stones" };
const checkText = (kind, ev) => ((S.meta?.check_text?.[S.lang] || S.meta?.check_text?.en || {})[kind] || kind).replace("{ev}", ev || "the record");
const KARAT = { "0.916": "22 K", "0.750": "18 K", "0.999": "fine", "0.925": "sterling", "0.585": "14 K" };
const material = (metal, fin) => `${metal ? metal[0].toUpperCase() + metal.slice(1) : ""} · ${fin}${KARAT[fin] ? ` (${KARAT[fin]})` : ""}`;
const fail = e => toast(e.status === 0 ? "The server is not reachable. Your last confirmed result is still shown." : e.message, "error");
const day = iso => { const d = new Date(iso); return iso && !isNaN(d) ? d.toLocaleDateString({ en: "en-IN", hi: "hi-IN", pa: "pa-IN" }[S.lang] || "en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"; };
let enterTimer;
// entrance once per fresh page visit; "data" after a confirmed server change
function enter(kind = "page") {
  if (kind === "page") $$(".page-head, .case-head, .banner, .spectrum, .toolbar, .changes, .stage, .case-main > *, .case-rail > *, .tiles > *, .eval-form, .settings-grid > *, .grid2 > *, main > .panel", main)
    .forEach((n, k) => { n.dataset.d = ""; n.style.setProperty("--d", `${Math.min(k, 10) * 55}ms`); });
  document.body.dataset.enter = kind;
  clearTimeout(enterTimer); enterTimer = setTimeout(() => { delete document.body.dataset.enter; }, 1700);
}
function finishRender() { if (S.fresh) { S.fresh = false; enter("page"); } }
function setTilt(v) { const b = document.getElementById("miniBeam"); if (b) b.style.transform = `rotate(${v === "unaccounted" ? -14 : v === "surplus" ? 14 : 0}deg)`; }
const announce = msg => { const n = $("#announce"); n.textContent = ""; setTimeout(() => { n.textContent = msg; }, 50); };

/* ================================================================ chrome */
$$("[data-ic]").forEach(n => { n.outerHTML = icon(n.dataset.ic); });

function applyChrome() {
  document.documentElement.lang = S.lang;
  $$("[data-t]").forEach(n => { n.textContent = L(n.dataset.t); });
  const ks = S.parties.filter(p => p.role === "karigar");
  if (S.role === "karigar" && !ks.some(k => k.party_id === S.viewer)) { S.role = "jeweller"; S.viewer = ""; }
  $("#viewAs").innerHTML = `<option value="jeweller">${esc(L("workshopView"))}</option>` +
    (ks.length ? `<optgroup label="${esc(L("karigar"))}">${ks.map(k => `<option value="k:${esc(k.party_id)}">${esc(L("karigar"))} · ${esc(k.name)}</option>`).join("")}</optgroup>` : "");
  $("#viewAs").value = S.role === "karigar" ? `k:${S.viewer}` : "jeweller";
  $("#langSel").value = S.lang;
  const me = S.parties.find(p => p.party_id === S.viewer);
  $("#acctLbl").textContent = S.role === "karigar" ? (me?.name || L("karigar")) : L("jeweller");
  $("#acctAv").textContent = S.role === "karigar" ? "K" : "J";
  moveInk();
}
function switchView(v) {
  if (v.startsWith("k:")) { S.role = "karigar"; S.viewer = v.slice(2); } else { S.role = "jeweller"; S.viewer = ""; }
  store.set("role", S.role); store.set("viewer", S.viewer);
  S.job = null; S.changes = null; S.jobs = null;
  applyChrome();
  if (location.hash.startsWith("#job/")) location.hash = "#jobs"; else route();
}
$("#viewAs").addEventListener("change", e => { closeAcct(); switchView(e.target.value); });
$("#langSel").addEventListener("change", e => { S.lang = e.target.value; store.set("lang", S.lang); applyChrome(); route(); });

// account popover: demo view, language, tour, shortcuts
function openAcct(open) {
  $("#acctPop").hidden = !open; $("#acctBtn").setAttribute("aria-expanded", String(open));
  if (open) $("#viewAs").focus();
}
const closeAcct = () => { if (!$("#acctPop").hidden) openAcct(false); };
$("#acctBtn").addEventListener("click", e => { e.stopPropagation(); openAcct($("#acctPop").hidden); });
document.addEventListener("click", e => { if (!$("#acctPop").hidden && !e.target.closest(".acct-wrap")) openAcct(false); });
$("#acctPop").addEventListener("keydown", e => { if (e.key === "Escape") { openAcct(false); $("#acctBtn").focus(); } });
$("#keysBtn").addEventListener("click", () => { openAcct(false); openKeys(); });
$("#tourBtn").addEventListener("click", () => openAcct(false));
$("#cmdBtn").addEventListener("click", () => openCmd());

// sliding underline under the current section
function moveInk() {
  const a = $("#nav a[aria-current]"), ink = $("#navInk");
  if (!ink) return;
  if (!a || getComputedStyle(ink).display === "none") { ink.style.opacity = "0"; return; }
  ink.style.opacity = "1"; ink.style.width = `${a.offsetWidth - 16}px`; ink.style.transform = `translateX(${a.offsetLeft + 8}px)`;
}
addEventListener("resize", moveInk);

// connection and pending-sync status are separate facts
function syncStatus() {
  const on = navigator.onLine, n = outboxCount();
  const txt = `${on ? L("online") : L("offline")}${n ? ` · ${n} ${L("waiting")}` : ` · ${L("allSynced")}`}`;
  $("#sync").innerHTML = `<i class="sync-dot ${on ? "" : "off"}"></i><span class="sync-txt">${esc(txt)}</span>`;
  $("#sync").title = txt;
}
async function syncNow() {
  const r = await flushOutbox((item, err) => err && toast(`A record saved offline was refused by the server: ${err.message}`, "error"));
  if (r.sent) { toast(`Sent ${r.sent} record${r.sent > 1 ? "s" : ""} saved while offline`); route(); }
  syncStatus();
  return r;
}
addEventListener("online", () => { syncStatus(); syncNow(); });
addEventListener("offline", syncStatus);

/* ================================================================ router */
addEventListener("hashchange", route);
let routeSeq = 0;
const stale = seq => seq !== routeSeq;
async function route() {
  const seq = ++routeSeq;
  closeAcct();
  const [view, arg] = (location.hash.slice(1) || "jobs").split("/");
  const key = `${location.hash || "#jobs"}|${S.role}|${S.viewer}|${S.lang}`;
  S.fresh = key !== S.lastKey; S.lastKey = key;
  if (view !== "job") setTilt("balanced");
  const navView = view === "job" ? "jobs" : view;
  $$("#nav a[data-view]").forEach(a => { if (a.dataset.view === navView) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  moveInk();
  try {
    if (view === "job" && arg) await renderJob(arg, { seq });
    else if (view === "instruments") await renderInstruments(seq);
    else if (view === "eval") await renderEval(seq);
    else if (view === "settings") renderSettings();
    else await renderJobs(seq);
  } catch (e) {
    if (stale(seq)) return;
    main.innerHTML = `<div class="panel empty">${icon("alert", "lg")}<h2>${e.status === 403 ? "Not available in this view" : "Could not load this page"}</h2>
      <p>${esc(e.status === 0 ? "The server is not reachable. Start it with python run.py, then try again." : e.message)}</p>
      <div class="actions"><button class="btn" id="retry">${icon("refresh")}Try again</button><a class="btn quiet" href="#jobs">${esc(L("back"))}</a></div></div>`;
    $("#retry")?.addEventListener("click", route);
  }
}

/* ================================================================ jobs */
const reviewCat = j => (j.settlement === "final" ? "settled" : j.settlement === "draft" ? "awaiting" : "none");
function jobCat(j) {
  if (j.verdict === "unaccounted") return "open";
  if (j.verdict === "surplus") return "surplus";
  if (j.verdict === "balanced") return reviewCat(j) === "settled" ? "settled" : reviewCat(j) === "awaiting" ? "awaiting" : "withinTol";
  return "error";
}
function nextAction(j) {
  if (j.verdict === "unaccounted" || j.verdict === "surplus") return L("investigate");
  const r = reviewCat(j);
  if (r === "none") return j.verdict === "balanced" ? L("draftAct") : "";
  if (r === "awaiting") return j.settlement_approvals?.[`${S.role}_at`] ? `Waiting for ${S.role === "jeweller" ? L("karigar").toLowerCase() : L("jeweller").toLowerCase()}` : L("approveAct");
  return "";
}
function diffCell(j) {
  if (j.verdict === "balanced") return `<span class="diff">${icon("check", "sm")} ${esc(L("withinTol"))}</span>`;
  if (j.verdict === "error") return `<span class="diff">—</span>`;
  const x = Math.abs(+j.excess_g).toFixed(3);
  return `<span class="diff"><b>${x} g</b><small>${j.verdict === "surplus" ? "fine metal returned beyond issue" : "fine metal unaccounted"}</small></span>`;
}
function reviewCell(j) {
  const r = reviewCat(j);
  if (r === "settled") return statusLabel("balanced", L("final"));
  if (r === "awaiting") return `<span class="status draft">${icon("clock")}${esc(L("draftState"))}</span>`;
  return `<span class="status neutral">${icon("ring")}${esc(L("noDraft"))}</span>`;
}

function diffLabel(j) {
  if (j.verdict === "balanced") return "within tolerance";
  if (j.verdict === "error") return "could not compute";
  const x = Math.abs(+j.excess_g).toFixed(3);
  return j.verdict === "surplus" ? `${x} g returned beyond issue` : `${x} g fine unaccounted`;
}
async function renderJobs(seq = routeSeq) {
  const me = S.parties.find(p => p.party_id === S.viewer);
  const isK = S.role === "karigar";
  document.title = `${L("jobs")} · Tarazu`;
  main.innerHTML = `
    <header class="page-head ws-head">
      <div class="grow"><span class="eyebrow">${esc(isK ? `${L("karigar")} · ${me?.name || ""}` : L("workshopView"))}</span>
        <h1>${esc(isK ? L("jobs") : L("workshop"))}</h1>
        <p class="lede" id="wsLede">${isK ? "Your own jobs only. The figures and explanations are the same ones the jeweller sees." : "Every job on the bench, placed by its fine-metal difference."}</p></div>
      <div class="actions">${isK
        ? `<a class="btn" href="/api/parties/${esc(S.viewer)}/export?format=csv">${icon("download")}CSV</a><a class="btn primary" href="/api/parties/${esc(S.viewer)}/export">${icon("download")}Export my account</a>`
        : `<button class="btn" id="peopleBtn">${icon("users")}${esc(L("people"))}</button><button class="btn primary" id="newJob">${icon("plus")}${esc(L("newJob"))}</button>`}</div>
    </header>
    <div id="jobsBody"><div class="shelf">${Array.from({ length: 6 }, () => `<div class="jcard skel-card"><span class="skel" style="height:56px;width:104px">.</span><span class="skel">Job title placeholder</span><span class="skel" style="width:60%">.</span></div>`).join("")}</div></div>`;
  $("#peopleBtn")?.addEventListener("click", openPeople);
  $("#newJob")?.addEventListener("click", openNewJob);
  const jobs = await api(`/api/jobs${isK ? `?karigar_id=${encodeURIComponent(S.viewer)}` : ""}`);
  if (stale(seq)) return;
  S.jobs = jobs;
  drawJobsBody();
}

const tableHTML = rows => `<table class="data cases"><caption class="sr-only">Jobs</caption>
  <thead><tr><th>${esc(L("job"))}</th><th>${esc(L("person"))}</th><th>${esc(L("material"))}</th><th>${esc(L("difference"))}</th><th>${esc(L("reviewState"))}</th><th>${esc(L("updated"))}</th><th>${esc(L("nextAction"))}</th></tr></thead>
  <tbody>${rows.map((j, ri) => `<tr data-id="${esc(j.job_id)}" style="--i:${Math.min(ri, 12)}">
    <td><a class="job-title" href="#job/${esc(j.job_id)}">${esc(j.title)}</a><span class="sub"><span class="mono">${esc(j.job_id)}</span>${j.simulated ? `<span class="sample-tag">${esc(L("sample"))}</span>` : ""}</span></td>
    <td>${esc(j.karigar_name)}</td><td class="hide-sm">${esc(material(j.metal, j.fineness_default))}</td><td>${diffCell(j)}</td><td>${reviewCell(j)}</td>
    <td class="small muted"><time datetime="${esc(j.updated_at)}" title="${esc(when(j.updated_at, S.lang))}">${esc(ago(j.updated_at))}</time></td>
    <td>${nextAction(j) ? `<span class="next-act">${esc(nextAction(j))}${icon("chevR", "sm")}</span>` : `<span class="muted">${L("none")}</span>`}</td></tr>`).join("")}</tbody></table>`;

const shelfHTML = rows => `<div class="shelf">${rows.map((j, k) => {
  const cat = jobCat(j), na = nextAction(j);
  return `<a class="jcard cat-${cat}" href="#job/${esc(j.job_id)}" data-id="${esc(j.job_id)}" style="--i:${Math.min(k, 12)}" aria-label="${esc(j.title)}: ${esc(diffLabel(j))}">
    <div class="jc-top">${miniBalance(tiltForJob(j))}${reviewCell(j)}</div>
    <h3 class="job-title">${esc(j.title)}</h3>
    <p class="jc-sub">${esc(j.karigar_name)} · ${esc(material(j.metal, j.fineness_default))}</p>
    <div class="jc-diff">${j.verdict === "balanced" ? `<b>${icon("check", "sm")} ${esc(L("withinTol"))}</b>` : j.verdict === "error" ? `<b>—</b>`
      : `<b>${Math.abs(+j.excess_g).toFixed(3)} g</b><span>${j.verdict === "surplus" ? "fine metal returned beyond issue" : "fine metal unaccounted"}</span>`}</div>
    <div class="jc-foot"><span class="mono">${esc(j.job_id)}</span>${j.simulated ? `<span class="sample-tag">${esc(L("sample"))}</span>` : ""}<span class="grow"></span><time datetime="${esc(j.updated_at)}" title="${esc(when(j.updated_at, S.lang))}">${esc(ago(j.updated_at))}</time></div>
    ${na ? `<span class="jc-next">${esc(na)} ${icon("arrowR", "sm")}</span>` : ""}
  </a>`;
}).join("")}</div>`;

function drawJobsBody() {
  const jobs = S.jobs || [], host = $("#jobsBody");
  if (!host) return;
  if (!jobs.length) {
    host.innerHTML = `<div class="panel empty">${icon("layers", "lg")}<h2>${esc(L("noJobs"))}</h2>
      <p>${S.role === "karigar" ? "No jobs have been recorded for this karigar yet." : "Create a job for a karigar, or load a sample workshop with five synthetic cases to explore how investigations work."}</p>
      ${S.role === "jeweller" ? `<div class="actions"><button class="btn" id="seed">${esc(L("demo"))}</button><button class="btn primary" id="newJob2">${icon("plus")}${esc(L("newJob"))}</button></div>` : ""}</div>`;
    $("#seed")?.addEventListener("click", seedDemo);
    $("#newJob2")?.addEventListener("click", openNewJob);
    finishRender();
    return;
  }
  const C = { all: jobs.length, open: 0, surplus: 0, withinTol: 0, awaiting: 0, settled: 0 };
  jobs.forEach(j => { const c = jobCat(j); if (c in C) C[c]++; });
  const lede = $("#wsLede");
  if (lede && S.role === "jeweller") lede.textContent = `${jobs.length} job${jobs.length > 1 ? "s" : ""} on the bench · ${C.open} with metal unaccounted · ${C.surplus} returned beyond issue · ${C.withinTol + C.awaiting + C.settled} within tolerance${C.awaiting ? ` · ${C.awaiting} awaiting approval` : ""}.`;
  const narrow = innerWidth < 640;
  if (S.specNarrow !== undefined && S.specNarrow !== narrow) S.ui.brush = null;   // brush coordinates belong to one drawing width
  S.specNarrow = narrow; fitSpectrum(innerWidth);
  const maxAbs = Math.max(0.05, ...jobs.map(j => Math.abs(+j.excess_g || 0)));
  const xOf = j => (j.verdict === "balanced" ? SPEC.cx : specX(+j.excess_g, maxAbs));
  const q = S.ui.q.trim().toLowerCase(), br = S.ui.brush;
  let rows = jobs.filter(j => (S.ui.filter === "all" || jobCat(j) === S.ui.filter) &&
    (!q || `${j.title} ${j.karigar_name} ${j.job_id}`.toLowerCase().includes(q)) && (!br || (xOf(j) >= br[0] && xOf(j) <= br[1])));
  const sorters = { updated: (a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""), diff: (a, b) => Math.abs(+b.excess_g) - Math.abs(+a.excess_g), name: (a, b) => a.title.localeCompare(b.title) };
  rows.sort(sorters[S.ui.sort] || sorters.updated);
  const chip = (k, label) => `<button type="button" data-filter="${k}" aria-pressed="${S.ui.filter === k}">${k === "all" ? "" : `<i class="cat-${k}"></i>`}${esc(label)} <b>${C[k]}</b></button>`;
  const view = S.ui.view === "table" ? "table" : "shelf";
  host.innerHTML = `
    ${jobs.some(j => j.simulated) ? `<div class="banner">${icon("info")}<div><b>Sample data present.</b> Jobs marked <span class="sample-tag">${esc(L("sample"))}</span> are synthetic cases for exploring the bench, not measured workshop records.</div></div>` : ""}
    <section class="panel spectrum" id="spectrum" aria-labelledby="spT">
      <div class="panel-head"><h2 id="spT">${esc(L("spectrum"))}</h2><span class="sub">Each mark is a job. Drag across the line to filter; select a mark to open it.</span>
        ${br ? `<button type="button" class="btn sm accent" id="clearBrush">${icon("x", "sm")}Clear range</button>` : ""}</div>
      <div class="spectrum-body">${spectrumSVG(jobs, { brush: br, catOf: jobCat, label: diffLabel })}</div>
    </section>
    <div class="toolbar">
      <label class="search field"><span class="sr-only">${esc(L("search"))}</span>${icon("search")}<input type="search" id="q" value="${esc(S.ui.q)}" placeholder="${esc(L("search"))}" autocomplete="off"></label>
      <div class="chips" role="group" aria-label="Filter by state">${chip("all", L("all"))}${chip("open", L("open"))}${chip("surplus", L("surplus"))}${chip("withinTol", L("withinTol"))}${chip("awaiting", L("awaiting"))}${chip("settled", L("settled"))}</div>
      <label class="sort">${icon("sort", "sm")}<span>${esc(L("sortBy"))}</span><select class="input" id="sort">
        <option value="updated">${esc(L("sortUpdated"))}</option><option value="diff">${esc(L("sortDiff"))}</option><option value="name">${esc(L("sortName"))}</option></select></label>
      <div class="seg" role="group" aria-label="Layout"><button type="button" data-layout="shelf" aria-pressed="${view === "shelf"}">${icon("layers", "sm")} ${esc(L("shelfView"))}</button><button type="button" data-layout="table" aria-pressed="${view === "table"}">${icon("jobs", "sm")} ${esc(L("listView"))}</button></div>
    </div>
    <p class="result-count" id="resultCount" aria-live="polite">${rows.length} of ${jobs.length} jobs${br ? " in the selected range" : ""}</p>
    <div id="casesPanel">${rows.length ? (view === "shelf" ? shelfHTML(rows) : `<div class="panel">${tableHTML(rows)}</div>`)
      : `<div class="panel empty">${icon("search", "lg")}<h2>No jobs match</h2><p>Nothing matches the current search, filter or range.</p><button class="btn" id="clearF">Clear search, filter and range</button></div>`}</div>`;
  $("#sort").value = S.ui.sort;
  const saveUI = () => store.set("jobsUI", { filter: S.ui.filter, sort: S.ui.sort, view: S.ui.view });
  $$("[data-filter]").forEach(b => b.addEventListener("click", () => { S.ui.filter = b.dataset.filter; saveUI(); drawJobsBody(); $(`[data-filter="${S.ui.filter}"]`)?.focus(); }));
  $$("[data-layout]").forEach(b => b.addEventListener("click", () => { S.ui.view = b.dataset.layout; saveUI(); drawJobsBody(); $(`[data-layout="${S.ui.view}"]`)?.focus(); }));
  $("#sort").addEventListener("change", e => { S.ui.sort = e.target.value; saveUI(); drawJobsBody(); $("#sort").focus(); });
  $("#q").addEventListener("input", e => { S.ui.q = e.target.value; const pos = e.target.selectionStart; drawJobsBody(); const n = $("#q"); n.focus(); n.setSelectionRange(pos, pos); });
  $("#clearF")?.addEventListener("click", () => { S.ui.q = ""; S.ui.filter = "all"; S.ui.brush = null; saveUI(); drawJobsBody(); $("#q").focus(); });
  $("#clearBrush")?.addEventListener("click", () => { S.ui.brush = null; drawJobsBody(); });
  $$(".cases tbody tr").forEach(tr => tr.addEventListener("click", e => { if (!e.target.closest("a")) location.hash = `#job/${tr.dataset.id}`; }));
  bindSpectrum();
  finishRender();
}

// drag across the spectrum to filter by a range of differences
function bindSpectrum() {
  const svg = $("#specSvg"), rect = $("#spBrush");
  if (!svg) return;
  const toX = e => { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()).x; };
  let x0 = null;
  svg.addEventListener("pointerdown", e => {
    if (e.target.closest(".sp-mk")) return;
    x0 = toX(e); svg.setPointerCapture(e.pointerId);
    rect.setAttribute("visibility", "visible"); rect.setAttribute("x", x0); rect.setAttribute("width", 0);
  });
  svg.addEventListener("pointermove", e => { if (x0 == null) return; const x = toX(e); rect.setAttribute("x", Math.min(x0, x)); rect.setAttribute("width", Math.abs(x - x0)); });
  const done = e => {
    if (x0 == null) return;
    const x = toX(e), a = Math.min(x0, x), b = Math.max(x0, x); x0 = null;
    S.ui.brush = b - a > 8 ? [a, b] : null;
    drawJobsBody();
  };
  svg.addEventListener("pointerup", done);
  svg.addEventListener("pointercancel", () => { x0 = null; drawJobsBody(); });
}

async function seedDemo() {
  try {
    const r = await api("/api/demo/seed", { method: "POST" });
    toast(r.seeded ? "Sample workshop loaded. Its five jobs are synthetic and labelled Sample." : r.message);
    await loadParties(); route();
  } catch (e) { fail(e); }
}

function openPeople() {
  const list = () => S.parties.length ? S.parties.map(p => `<li><span>${esc(p.name)}</span><span class="muted">${esc(L(p.role))}</span></li>`).join("") : `<li class="muted">No people yet.</li>`;
  openDialog({ title: L("people"), desc: "Jewellers and karigars who appear on jobs.", body: `
    <ul class="people" id="plist">${list()}</ul>
    <form class="form" id="f" style="margin-top:var(--s5)" novalidate>
      <h3 class="label">${esc(L("newParty"))}</h3>
      <div class="field-row">
        <label class="field"><span>Name or code</span><input name="name" required maxlength="80" placeholder="e.g. Karigar K-03" autocomplete="off"></label>
        <fieldset class="field"><legend>Role</legend><div class="seg" id="rc"><button type="button" data-v="karigar" aria-pressed="true">${esc(L("karigar"))}</button><button type="button" data-v="jeweller" aria-pressed="false">${esc(L("jeweller"))}</button></div></fieldset>
      </div>
      <p class="hint small muted">Use a code rather than a full name if records may be shared for research.</p>
      <div class="form-error" id="err" role="alert"></div>
      <div class="dialog-actions"><button type="button" class="btn" data-close>Done</button><button class="btn primary">${icon("plus")}Add person</button></div>
    </form>`, onMount(m) {
    let role = "karigar";
    $$("#rc button", m).forEach(b => b.addEventListener("click", () => { role = b.dataset.v; $$("#rc button", m).forEach(x => x.setAttribute("aria-pressed", String(x === b))); }));
    $("#f", m).addEventListener("submit", async e => {
      e.preventDefault();
      const name = e.target.elements.name;
      if (!name.value.trim()) { name.setAttribute("aria-invalid", "true"); $("#err", m).textContent = "Enter a name or code."; name.focus(); return; }
      try {
        await api("/api/parties", { method: "POST", body: { name: name.value.trim(), role } });
        await loadParties(); $("#plist", m).innerHTML = list(); name.value = ""; name.removeAttribute("aria-invalid"); $("#err", m).textContent = "";
        toast("Person added"); if (location.hash === "#jobs" || !location.hash) drawJobsBody();
      } catch (err) { $("#err", m).textContent = err.message; }
    });
  } });
}

function openNewJob() {
  const ks = S.parties.filter(p => p.role === "karigar"), js = S.parties.filter(p => p.role === "jeweller");
  if (!ks.length) { toast("Add a karigar first"); return openPeople(); }
  const FIN = [["0.925", "silver", "Sterling 925"], ["0.999", "silver", "Fine silver 999"], ["0.916", "gold", "22 K · 916"], ["0.750", "gold", "18 K · 750"]];
  openDialog({ title: L("newJob"), desc: "A job is one order given to one karigar.", body: `
    <form class="form" id="f" novalidate>
      <label class="field"><span>Order</span><input name="title" required maxlength="120" placeholder="e.g. Payal pair, sterling"></label>
      <div class="field-row">
        <label class="field"><span>${esc(L("karigar"))}</span><select name="karigar_id">${ks.map(k => `<option value="${esc(k.party_id)}">${esc(k.name)}</option>`).join("")}</select></label>
        <label class="field"><span>${esc(L("jeweller"))}</span><select name="jeweller_id"><option value="">Not specified</option>${js.map(k => `<option value="${esc(k.party_id)}">${esc(k.name)}</option>`).join("")}</select></label>
      </div>
      <fieldset class="field"><legend>Metal and purity</legend><div class="choice" id="fc">${FIN.map(([f, m, l], i) => `<button type="button" data-f="${f}" data-m="${m}" aria-pressed="${i === 0}">${l}</button>`).join("")}</div></fieldset>
      <div class="field-row">
        <label class="field"><span>Agreed wastage, maximum</span><input name="wmax" type="number" min="0" step="0.01" value="0.5" inputmode="decimal"><span class="hint">% of fine metal issued</span></label>
        <label class="field"><span>Pieces on the order sheet</span><input name="pieces" type="number" min="0" step="1" value="0" inputmode="numeric"><span class="hint">0 if not known</span></label>
      </div>
      <div class="form-error" id="err" role="alert"></div>
      <div class="dialog-actions"><button type="button" class="btn" data-close>${esc(L("cancel"))}</button><button class="btn primary">Create job</button></div>
    </form>`, onMount(m, close) {
    let fin = "0.925", metal = "silver";
    $$("#fc button", m).forEach(b => b.addEventListener("click", () => { fin = b.dataset.f; metal = b.dataset.m; $$("#fc button", m).forEach(x => x.setAttribute("aria-pressed", String(x === b))); }));
    $("#f", m).addEventListener("submit", async e => {
      e.preventDefault(); const f = e.target.elements;
      if (!f.title.value.trim()) { f.title.setAttribute("aria-invalid", "true"); $("#err", m).textContent = "Give the order a name."; f.title.focus(); return; }
      try {
        const j = await api("/api/jobs", { method: "POST", body: { title: f.title.value.trim(), karigar_id: f.karigar_id.value, jeweller_id: f.jeweller_id.value,
          metal, fineness_default: fin, wastage_min_pct: "0", wastage_max_pct: f.wmax.value || "0", pieces_expected: +f.pieces.value || 0 } });
        close(); location.hash = `#job/${j.job_id}`;
      } catch (err) { $("#err", m).textContent = err.message; }
    });
  } });
}

/* ================================================================ investigation */
async function renderJob(id, { seq = routeSeq, action = null } = {}) {
  const prev = S.job && S.job.job.job_id === id ? S.job : null;
  if (!prev) {
    S.selected = ""; S.changes = null;
    main.innerHTML = `<div class="case-page"><div class="case-head"><span class="skel" style="width:120px">Jobs</span><h1><span class="skel">Loading job title here</span></h1></div>
      <div class="case-grid"><div class="case-main"><div class="panel panel-body"><span class="skel" style="display:block;height:140px">.</span></div></div><div class="case-rail"><div class="panel panel-body"><span class="skel" style="display:block;height:200px">.</span></div></div></div></div>`;
  }
  const viewer = S.role === "karigar" ? S.viewer : "";
  const d = await api(`/api/jobs/${encodeURIComponent(id)}?lang=${S.lang}${viewer ? `&viewer=${encodeURIComponent(viewer)}` : ""}`);
  if (stale(seq) && !action) return;
  S.changes = action && prev ? diffReports(prev, d, action) : (action ? null : S.changes && prev ? S.changes : null);
  S.job = d;
  S.dataChange = !!action;
  drawJob();
  if (S.changes) announce(S.changes.items.join(". "));
}

function diffReports(prev, next, action) {
  const a = prev.report, b = next.report, items = [action];
  if (a.balance.raw_g !== b.balance.raw_g) items.push(`Remaining difference ${a.balance.raw_g} g → ${b.balance.raw_g} g fine`);
  if (a.balance.verdict !== b.balance.verdict) items.push(`Status: ${verdictWord(a.balance.verdict)} → ${verdictWord(b.balance.verdict)}`);
  const was = Object.fromEntries(a.explanations.map(x => [x.key, x]));
  const ruled = b.explanations.filter(x => !x.last_resort && !x.alive && was[x.key]?.alive);
  if (ruled.length) items.push(`Ruled out ${ruled.length} explanation${ruled.length > 1 ? "s" : ""}: ${ruled.slice(0, 3).map(x => x.titles.join(" + ")).join("; ")}${ruled.length > 3 ? "; …" : ""}`);
  const inv = b.investigation;
  if (inv.status === "resolved" && a.investigation.status !== "resolved") {
    const best = b.explanations.find(x => x.key === inv.best);
    if (best) items.push(`The checks now point to one explanation: ${best.titles.join(" + ")}`);
  }
  const oldIds = new Set(a.events.map(e => e.event_id));
  const added = b.events.filter(e => !oldIds.has(e.event_id));
  const changedEx = new Set([...ruled.map(x => x.key), ...(inv.status === "resolved" ? [inv.best] : [])]);
  const sp = prev.settlements[0], sn = next.settlements[0];
  if (sn && (!sp || sp.settlement_id !== sn.settlement_id)) items.push("A settlement draft was created for both parties to review");
  else if (sn && sp && sn.status !== sp.status && sn.status === "final") items.push("Both parties have approved the settlement");
  return { items, added: added.map(e => e.event_id), changedEx: [...changedEx], suggestDraft: b.balance.verdict === "balanced" && !(sn && !sn.stale) };
}
const verdictWord = v => ({ balanced: L("balancedV"), unaccounted: L("unaccountedV"), surplus: L("surplusV") }[v] || v);

function drawJob() {
  const d = S.job, j = d.job, rep = d.report, b = rep.balance, inv = rep.investigation;
  const set = d.settlements[0];
  document.title = `${j.title} · Tarazu`;
  const nc = b.verdict !== "balanced" ? inv.next_check : null;
  S.previewKey = null;
  main.innerHTML = `<div class="case-page">
    <header class="case-head">
      <a class="crumb" href="#jobs">${icon("chevL", "sm")}${esc(L("back"))}</a>
      <div class="case-top">
        <div class="grow">
          <div style="display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center">${statusLabel(b.verdict, verdictWord(b.verdict))}${j.simulated ? `<span class="sample-tag" title="Synthetic sample data">${esc(L("sampleData"))}</span>` : ""}</div>
          <h1>${esc(j.title)}</h1>
          <span class="case-id">${esc(j.job_id)}</span>
        </div>
        <div class="actions"><button class="btn quiet" id="speak">${icon("speaker")}${esc(L("readAloud"))}</button><button class="btn primary" id="addRec">${icon("plus")}${esc(L("addRecord"))}</button></div>
      </div>
      <dl class="case-meta">
        <div><dt>${esc(L("karigar"))}</dt><dd>${esc(d.karigar?.name || "—")}</dd></div>
        <div><dt>${esc(L("jeweller"))}</dt><dd>${esc(d.jeweller?.name || "Not specified")}</dd></div>
        <div><dt>${esc(L("material"))}</dt><dd>${esc(material(j.metal, j.fineness_default))}</dd></div>
        <div><dt>${esc(L("wastage"))}</dt><dd class="num">${esc(j.wastage_min_pct)}–${esc(j.wastage_max_pct)}%</dd></div>
        ${+j.pieces_expected ? `<div><dt>Pieces ordered</dt><dd class="num">${esc(j.pieces_expected)}</dd></div>` : ""}
        <div><dt>${esc(L("updated"))}</dt><dd><time datetime="${esc(j.updated_at)}">${esc(when(j.updated_at, S.lang))}</time></dd></div>
        <div><dt>${esc(L("reviewState"))}</dt><dd>${esc(set && !set.stale ? (set.status === "final" ? L("final") : L("draftState")) : L("noDraft"))}</dd></div>
      </dl>
    </header>
    ${S.changes ? changesPanel(S.changes) : ""}
    <section class="panel stage" id="stage" aria-label="The bench: the balance for this job">
      <div class="stage-main">
        <div class="stage-bar"><span class="stage-mode" id="stageMode">${icon("dot", "sm")} Live</span><span>Every record is a weight on its pan. Select one for its details and history.</span></div>
        <div class="bench-host" id="benchHost"></div>
        ${whatIfHTML(rep)}
      </div>
      <aside class="readout" id="readout" aria-live="polite">${readoutHTML(rep, false)}</aside>
      ${replayHTML(rep)}
    </section>
    <div class="case-grid">
      <div class="case-main">
        ${b.verdict === "balanced" ? "" : explanationsPanel(rep)}
        ${ledgerPanel(rep)}
        ${measurePanel(rep)}
      </div>
      <div class="case-rail">
        ${b.verdict === "balanced" ? "" : nextPanel(rep)}
        ${reviewPanel(d)}
      </div>
    </div>
    ${nc ? `<div class="next-bar" role="region" aria-label="Next action"><span>${icon("target", "sm")} ${esc(nc.text)}</span><a class="btn sm" href="#nextCheck" id="goNext">${esc(L("recordAct"))}</a></div>` : ""}
  </div>`;
  S.bench = new Bench($("#benchHost"), { onPick: openRecord });
  S.bench.render(rep, { selected: S.selected });
  bindJob();
  setTilt(b.verdict);
  if (S.dataChange) { S.dataChange = false; S.fresh = false; enter("data"); } else finishRender();
  // mark what changed, once, after a confirmed server response
  if (S.changes) {
    S.changes.added.forEach(id => $(`.ledger tr[data-ev="${CSS.escape(id)}"]`)?.classList.add("is-changed"));
    S.changes.changedEx.forEach(k => $(`.expl li[data-key="${CSS.escape(k)}"]`)?.classList.add("is-changed"));
    if (S.changes.signed) $(`.seal[data-role="${S.changes.signed}"]`)?.classList.add("is-changed");
  }
}

function changesPanel(c) {
  return `<section class="changes" aria-labelledby="chgT"><div class="row"><h2 id="chgT">${icon("refresh")}What changed</h2>
    <button class="btn quiet sm" id="chgClose">${icon("x", "sm")}Dismiss</button></div>
    <ul>${c.items.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    ${c.suggestDraft ? `<div><a class="btn sm accent" href="#review">${icon("arrowR", "sm")}Continue to shared review</a></div>` : ""}</section>`;
}

function readoutHTML(rep, replay) {
  const b = rep.balance;
  const lo = +b.residual_lo_g + +b.band_hi_g, hi = +b.residual_hi_g + +b.band_lo_g;
  const emCls = b.verdict === "balanced" ? "ok" : b.verdict === "surplus" ? "surplus" : "";
  return `<p class="finding">${esc(rep.narration[0] || "")}</p>
    <dl class="rdgs">
      <div><dt>${esc(L("issued"))}</dt><dd>${esc(b.fine_in_g)}<small> g</small></dd></div>
      <div><dt>${esc(L("accounted"))}</dt><dd>${esc(b.fine_out_g)}<small> g</small></dd>${+b.fine_deduct_g ? `<span class="xs muted">+ ${esc(b.fine_deduct_g)} g stones deducted</span>` : ""}</div>
      <div class="em ${emCls}"><dt>${esc(L("remaining"))}</dt><dd>${esc(b.raw_g)}<small> g</small></dd><span class="xs muted">${b.verdict === "surplus" ? "negative: more came back than went out" : `agreed allowance ${esc(b.band_lo_g)}–${esc(b.band_hi_g)} g`}</span></div>
      <div><dt>${esc(L("range"))}</dt><dd class="sm">${g3(lo)} to ${g3(hi)}<small> g</small></dd><span class="xs muted">scale and purity uncertainty included</span></div>
    </dl>
    <p class="xs readout-foot">${replay ? "Replay: computed by the engine from the first records only, with their current (corrected) values." : `Fine (pure) metal, in grams. Computed by the server in ${esc(rep.latency_ms)} ms.`}</p>`;
}

function whatIfHTML(rep) {
  const b = rep.balance;
  if (b.verdict === "balanced") return `<div class="whatif"><span class="wi-lbl">${icon("check", "sm")} The balance closes within tolerance. Nothing to preview.</span></div>`;
  const xs = rep.explanations.filter(x => x.alive && !x.last_resort).slice(0, 5);
  if (!xs.length) return "";
  return `<div class="whatif" role="group" aria-label="Preview an explanation on the balance"><span class="wi-lbl">${icon("target", "sm")} Preview on the balance:</span>
    ${xs.map(x => `<button type="button" class="wi" data-wi="${esc(x.key)}" aria-pressed="false"><span class="mono">${esc(x.hyps.join("+"))}</span>${esc(x.titles.join(" + "))}</button>`).join("")}
    <span class="wi-note">Each explanation would close the gap exactly. A preview shows that on the balance; nothing is recorded.</span></div>`;
}

const replayRoots = rep => rep.events.filter(e => !e.parent_event_id && !e.effective?.voided);
function replayHTML(rep) {
  const n = replayRoots(rep).length;
  if (n < 2) return "";
  return `<div class="replay"><label for="replayIn">${icon("clock", "sm")} Replay the records</label>
    <input type="range" id="replayIn" min="1" max="${n}" value="${n}" step="1" aria-valuetext="${n} of ${n} records">
    <output id="replayOut" for="replayIn">${n} of ${n} · now</output>
    <button type="button" class="btn sm quiet" id="replayNow" hidden>${icon("refresh", "sm")}Back to now</button></div>`;
}

function measurePanel(rep) {
  const b = rep.balance;
  const lo = +b.residual_lo_g + +b.band_hi_g, hi = +b.residual_hi_g + +b.band_lo_g;
  return `<section class="panel" aria-labelledby="msT">
    <div class="panel-head"><h2 id="msT">Measurement</h2><span class="sub">What each record contributes, and the uncertainty around the difference</span></div>
    <div class="panel-body measure-grid">
      <div id="stripHost">${balanceStrip(rep, { selected: S.selected })}</div>
      ${toleranceLine(b)}
      <details class="method"><summary>${icon("chevD", "sm")}How this is calculated</summary>
        <div class="method-body">
          <p>Each record's fine metal is its weight × its purity (F = m × φ). Masses are stored as whole micrograms and calculated with exact decimal arithmetic.</p>
          <p>Every weight carries the measurement bound of the scale it was weighed on, and every purity carries the bound of its assay method. Adding these up gives the measured range of the difference, from ${g3(lo)} to ${g3(hi)} g.</p>
          <p>The job is within tolerance when that range reaches the agreed wastage band (${esc(b.band_lo_g)}–${esc(b.band_hi_g)} g fine). Otherwise the engine lists explanations that would close the gap.</p>
          <p class="xs">Computed by the server in ${esc(rep.latency_ms)} ms · solver: ${esc(rep.explain?.solver || "—")}.</p>
        </div></details>
    </div></section>`;
}

function confState(e) {
  const j = e.approved_jeweller_at, k = e.approved_karigar_at;
  if (j && k) return `<span class="conf ok">${icon("check", "sm")}${esc(L("confirmedBoth"))}</span>`;
  if (j) return `<span class="conf part">${icon("clock", "sm")}${esc(L("confirmedJ"))}</span>`;
  if (k) return `<span class="conf part">${icon("clock", "sm")}${esc(L("confirmedK"))}</span>`;
  return `<span class="conf none">${icon("ring", "sm")}${esc(L("notConfirmed"))}</span>`;
}
function sourceOf(e) {
  const bits = [];
  if (e.document_id?.startsWith("doc_")) bits.push(`${icon("camera", "sm")} photo`);
  else if (e.document_id) bits.push(`${icon("file", "sm")} ${esc(e.document_id)}`);
  const inst = S.instruments.find(i => i.instrument_id === e.instrument_id);
  if (inst) bits.push(`${icon("scale", "sm")} ${esc(inst.name)}`);
  if (e.assay_method && e.assay_method !== "declared") bits.push(esc(e.assay_method));
  if (!bits.length) bits.push(e.created_by ? `entered by ${esc(e.created_by)}` : "manual entry");
  return bits.join(" · ");
}
function orderedRows(evs) {
  const by = Object.fromEntries(evs.map(x => [x.event_id, x]));
  const rootOf = e => { let c = e; while (c.parent_event_id && by[c.parent_event_id]) c = by[c.parent_event_id]; return c.event_id; };
  const kids = {};
  evs.filter(e => e.parent_event_id).forEach(e => (kids[rootOf(e)] ||= []).push(e));
  const rows = [];
  evs.filter(e => !e.parent_event_id).forEach(e => { rows.push([e, false]); (kids[e.event_id] || []).forEach(c => rows.push([c, true])); });
  return rows;
}
function qtyCell(e, child) {
  const eff = e.effective;
  if (e.event_type === "ASSAY" || e.void) return "—";
  if (child) return `${esc(e.value_original)} ${esc(e.unit)}`;
  const written = `${esc(e.value_original)} ${esc(e.unit)}`;
  if (eff && eff.mass_g !== e.mass_g) return `<span class="was">${written}</span>${esc(eff.mass_g)} g`;
  return e.unit === "g" ? `${esc(e.mass_g)} g` : `${written} <span class="xs muted">= ${esc(e.mass_g)} g</span>`;
}
function ledgerPanel(rep) {
  const evs = rep.events;
  const rows = orderedRows(evs);
  return `<section class="panel" id="ledger" aria-labelledby="ledT">
    <div class="panel-head"><h2 id="ledT">${esc(L("ledger"))}</h2><span class="sub">Select a record for its details and history. Corrections are added as new rows; originals are never changed.</span></div>
    ${rows.length ? `<div class="table-wrap"><table class="data ledger"><caption class="sr-only">Records for this job</caption>
      <thead><tr><th>Record</th><th>Date</th><th class="n">Quantity</th><th class="n">Purity</th><th class="n">Fine g</th><th>Source</th><th>Confirmation</th></tr></thead>
      <tbody>${rows.map(([e, child], ri) => {
        const eff = e.effective, voided = eff?.voided;
        const finChanged = !child && eff && eff.fineness !== e.fineness;
        return `<tr style="--i:${Math.min(ri, 12)}" data-ev="${esc(e.event_id)}" class="${child ? "child" : ""} ${voided ? "voided" : ""} ${S.selected === e.event_id ? "sel" : ""}">
          <td>${child ? "↳ " : ""}<button type="button" class="rec-label" data-open="${esc(e.event_id)}">${esc(e.label)}</button>
            <span class="rec-type">${child ? `${e.void ? "voids" : "corrects"} ${esc(e.parent_label)}` : esc(typeName(e.event_type))}${voided ? " · voided" : ""}</span></td>
          <td data-label="Date" class="small muted"><time datetime="${esc(e.timestamp || e.created_at)}" title="${esc(when(e.timestamp || e.created_at, S.lang))}">${esc(day(e.timestamp || e.created_at))}</time></td>
          <td data-label="Quantity" class="n num">${qtyCell(e, child)}</td>
          <td data-label="Purity" class="n num">${e.void || (child && e.event_type === "REWEIGH") ? "—" : finChanged ? `<span class="was">${esc(e.fineness)}</span>${esc(eff.fineness)}` : esc(e.fineness)}</td>
          <td data-label="Fine" class="n num">${child ? "" : voided ? "0.0000" : esc(eff?.fine_g ?? "")}</td>
          <td data-label="Source" class="small hide-sm">${sourceOf(e)}</td>
          <td>${confState(e)}</td></tr>`;
      }).join("")}</tbody></table></div>`
      : `<div class="empty">${icon("file", "lg")}<h2>No records yet</h2><p>Start with the issue record: how much metal went to the karigar, and at what purity.</p><button class="btn primary" id="addFirst">${icon("plus")}${esc(L("addRecord"))}</button></div>`}
  </section>`;
}

function expState(x, inv) {
  if (!x.alive) return { cls: "ruled-out", label: `<span class="status neutral">${icon("x")}Ruled out by a check</span>` };
  if (inv.status === "resolved" && x.key === inv.best) {
    // "supported" only once a check has actually been recorded; otherwise it is the engine's strong favourite awaiting confirmation
    if (inv.log.length && !inv.next_check) return { cls: "confirmed", label: `<span class="status ok">${icon("check")}Supported by checks</span>` };
    return { cls: "", label: `<span class="status draft">${icon("target")}Leading · confirm with a check</span>` };
  }
  return { cls: "", label: `<span class="status neutral">${icon("ring")}Fits the records</span>` };
}
function explanationsPanel(rep) {
  const inv = rep.investigation, ex = rep.explain || {};
  const xs = rep.explanations.filter(x => !x.last_resort);
  const h9 = rep.explanations.find(x => x.last_resort);
  const alive = xs.filter(x => x.alive).length;
  const item = (x, xi = 0) => {
    const st = expState(x, inv);
    const refs = [...new Map(x.edits.filter(e => e.event_id).map(e => [e.event_id, e.event_label])).entries()];
    const tests = [...new Set(x.edits.map(e => checkText(HYP_CHECK[e.hyp], e.event_label)))];
    const canRecord = x.alive && x.key === inv.best;
    const confirmed = inv.status === "resolved" && inv.log.length > 0 && !inv.next_check;
    return `<li class="${st.cls}" data-key="${esc(x.key)}" style="--i:${xi}">
      <div class="x-top"><h3><span class="x-code">${esc(x.hyps.join("+"))}</span>${esc(x.titles.join(" + "))}</h3>${st.label}</div>
      <p class="x-desc">${esc(x.edits.map(e => e.text).join(" · "))}</p>
      <dl class="x-rows">
        <dt>Records involved</dt><dd>${refs.length ? refs.map(([id, lab]) => `<button type="button" class="chipref" data-open="${esc(id)}">${esc(lab)}</button>`).join("") : "<span class='muted'>An item that has no record yet</span>"}</dd>
        <dt>Would be tested by</dt><dd>${esc(tests.join("; "))}</dd>
      </dl>
      <div class="x-acts"><span class="weight" title="Relative score from the engine; simpler explanations score higher. Not a calibrated probability.">Relative weight <i style="--w:${(x.prob * 100).toFixed(1)}%"></i><span class="num">${(x.prob * 100).toFixed(0)}%</span></span>
        ${x.alive ? `<button class="btn sm quiet" data-preview="${esc(x.key)}">${icon("target", "sm")}Preview on balance</button>` : ""}
        ${canRecord ? `<button class="btn sm ${confirmed ? "primary" : "quiet"}" data-apply="${esc(x.key)}">${icon("edit", "sm")}${confirmed ? L("recordAct") : "Both agree? Record it"}</button>` : ""}</div>
    </li>`;
  };
  const shown = xs.slice(0, 5), rest = xs.slice(5);
  return `<section class="panel" aria-labelledby="expT">
    <div class="panel-head"><h2 id="expT">${esc(L("explanations"))}</h2><span class="sub">${alive} still fit · ${xs.length} found from ${esc(ex.n_candidates ?? "–")} candidate edits</span></div>
    ${xs.length ? `<p class="small muted" style="padding:var(--s3) var(--s5) 0">Each explanation is one small, specific change to the records that would close the difference exactly. Relative weight is the engine's score, favouring simpler explanations; it is not a calibrated probability.</p>
      <ol class="expl">${shown.map(item).join("")}</ol>
      ${rest.length ? `<details class="more" style="padding:0 var(--s5) var(--s4)"><summary>${icon("chevD", "sm")}Show ${rest.length} more</summary><ol class="expl">${rest.map(item).join("")}</ol></details>` : ""}`
      : `<div class="panel-body"><p>No small set of edits to the records explains this difference. Review the records together, or record a correction both sides agree on.</p></div>`}
    ${h9 ? `<p class="small muted" style="padding:0 var(--s5) var(--s4)"><span class="mono">H9</span> ${esc(h9.titles[0])}: offered only once all of the above are ruled out.</p>` : ""}
  </section>`;
}

function nextPanel(rep) {
  const inv = rep.investigation, nc = inv.next_check;
  const best = rep.explanations.find(x => x.key === inv.best);
  const log = inv.log.length ? `<ul class="log">${inv.log.map(l => `<li>${icon("check", "sm")}<span>${esc(l.text)}: <b>${esc(l.outcome)}</b> <span class="muted">· ruled out ${esc(l.eliminated)}, ${esc(l.remaining)} left</span></span></li>`).join("")}</ul>
    <button class="btn quiet sm" id="resetChecks" style="margin-top:var(--s2)">${icon("refresh", "sm")}${esc(L("reset"))}</button>` : "";
  let body;
  if (nc) {
    const tested = rep.explanations.filter(x => x.alive && !x.last_resort && x.edits.some(e => HYP_CHECK[e.hyp] === nc.kind));
    body = `<div class="flip" id="flip" data-flipped="false">
      <div class="face front">
        <p class="next-q">${esc(nc.text)}</p>
        <div class="next-facts"><span class="fact">${icon("clock", "sm")}${esc(nc.minutes)} min</span><span class="fact">Effort ${esc(nc.friction)}/5</span>${nc.confirm ? "" : `<span class="fact">${esc(nc.gain_bits)} bits of information</span>`}</div>
        <div class="next-why">
          <p><b>Why this check:</b> ${nc.confirm ? "One explanation already passes the confidence threshold; this check confirms it before anything is recorded." : `Of the ${esc(inv.ranked?.length || 1)} checks available, it gives the most information per unit of effort (minutes plus how awkward it is for the relationship).`}</p>
          ${tested.length ? `<p><b>Directly tests:</b> ${tested.slice(0, 3).map(x => esc(x.titles.join(" + "))).join("; ")}${tested.length > 3 ? "; …" : ""}</p>` : ""}
        </div>
        <button class="btn primary block" id="flipGo">${icon("arrowR")}Record what the check found</button>
      </div>
      <div class="face back" inert>
        <div class="outcomes" role="group" aria-labelledby="outT"><span class="label" id="outT">${esc(L("outcome"))}</span>
          <p class="small muted">${esc(nc.text)}</p>
          ${nc.outcomes.map(o => `<button class="btn" data-check="${esc(nc.check_id)}" data-outcome="${esc(o)}">${icon("arrowR", "sm")}${esc(o)}</button>`).join("")}</div>
        <button class="btn quiet sm" id="flipBack" style="margin-top:var(--s3)">${icon("chevL", "sm")}Back</button>
      </div>
    </div>
    ${inv.ranked?.length > 1 ? `<details class="more" style="margin-top:var(--s3)"><summary>${icon("chevD", "sm")}Other checks, ranked</summary><ol class="ranked">${inv.ranked.slice(1).map(r => `<li><span>${esc(r.text)}</span><span>${esc(r.minutes)} min · ${esc(r.gain_bits)} bits</span></li>`).join("")}</ol></details>` : ""}`;
  } else if (inv.status === "resolved" && best) {
    body = `<p class="next-q">The checks point to: ${esc(best.titles.join(" + "))}</p>
      <p class="small muted" style="margin-top:var(--s2)">${esc(best.edits.map(e => e.text).join(" · "))}</p>
      <p class="small" style="margin-top:var(--s3)">Record the evidence from the check. It is added as a new record, and the other party confirms it.</p>
      <button class="btn primary block" style="margin-top:var(--s3)" data-apply="${esc(best.key)}">${icon("edit")}${esc(L("recordAct"))}</button>`;
  } else if (inv.status === "abstain") {
    body = `<p class="next-q">Unresolved</p><p class="small" style="margin-top:var(--s2)">No affordable check can separate the explanations that remain, so the engine does not guess. Review the records together or agree a correction.</p>`;
  } else if (inv.status === "unexplained") {
    body = `<p class="next-q">No listed explanation fits what was found</p><p class="small" style="margin-top:var(--s2)">Restart the checks, or record a correction both sides agree on.</p>`;
  } else {
    body = `<p class="small muted">No check is available for this job.</p>`;
  }
  return `<section class="panel next" id="nextCheck" aria-labelledby="ncT" tabindex="-1">
    <div class="panel-head"><h2 id="ncT">${icon("target", "sm")} ${esc(L("nextCheck"))}</h2>${inv.status === "resolved" && !nc ? `<span class="sub">Resolved</span>` : ""}</div>
    <div class="panel-body">${body}${log}</div></section>`;
}

function reviewPanel(d) {
  const rep = d.report, b = rep.balance, set = d.settlements[0];
  const evs = rep.events;
  const both = evs.filter(e => e.approved_jeweller_at && e.approved_karigar_at).length;
  const needJ = evs.filter(e => !e.approved_jeweller_at).length, needK = evs.filter(e => !e.approved_karigar_at).length;
  const balanced = b.verdict === "balanced";
  const live = set && !set.stale ? set : null;
  const mine = live && live[`${S.role}_at`];
  const seal = role => {
    const at = live?.[`${role}_at`];
    const canSign = live && !at && S.role === role && live.status !== "final";
    return `<div class="seal ${at ? "signed" : ""}" data-role="${role}"><div class="wax">${icon(at ? "check" : "ring")}</div><b>${esc(L(role))}</b>
      <span>${at ? `Signed ${esc(when(at, S.lang))}` : live ? "Not signed yet" : "Nothing to sign yet"}</span>
      ${canSign ? `<button class="btn sm primary" data-approve-set="${esc(live.settlement_id)}">${icon("edit", "sm")}Sign as ${esc(L(role).toLowerCase())}</button>` : ""}</div>`;
  };
  let settleBody;
  if (live) {
    const s = live.summary;
    settleBody = `<p>${live.status === "final" ? "Approved by both parties." : "Draft. It becomes final only when both parties sign."}</p>
      <dl class="kv" style="margin-top:var(--s2)"><dt>Fine issued</dt><dd class="num">${esc(s.fine_in_g)} g</dd><dt>Fine returned</dt><dd class="num">${esc(s.fine_out_g)} g</dd>
        <dt>Wastage used</dt><dd class="num">${esc(s.wastage_used_g)} g (${esc(s.wastage_used_pct)}%)</dd></dl>
      ${live.status !== "final" && mine ? `<p class="small muted" style="margin-top:var(--s2)">You have approved. Waiting for the ${esc(S.role === "jeweller" ? L("karigar").toLowerCase() : L("jeweller").toLowerCase())}.</p>` : ""}`;
  } else if (balanced) {
    settleBody = `<p>${set?.stale ? "The records changed after the last draft, so it no longer applies. " : ""}The calculation is within tolerance. Draft a settlement for both parties to sign.</p>
      <button class="btn primary block" style="margin-top:var(--s3)" id="draft">${esc(L("draftAct"))}</button>`;
  } else {
    settleBody = `<p>A settlement can be drafted once the difference is explained, or both parties record an agreed correction.</p>`;
  }
  return `<section class="panel" id="review" aria-labelledby="revT" tabindex="-1">
    <div class="panel-head"><h2 id="revT">${esc(L("review"))}</h2><span class="sub">Both parties see this same screen</span></div>
    <div class="panel-body"><ol class="steps-review">
      <li style="--i:0"><span class="step-ic ${both === evs.length && evs.length ? "done" : "wait"}">${icon(both === evs.length && evs.length ? "check" : "file", "sm")}</span><div><h3>Records confirmed</h3>
        <p>${both} of ${evs.length} confirmed by both.${needJ ? ` Jeweller to confirm: ${needJ}.` : ""}${needK ? ` Karigar to confirm: ${needK}.` : ""}</p></div></li>
      <li style="--i:1"><span class="step-ic ${balanced ? "done" : "wait"}">${icon(balanced ? "check" : "alert", "sm")}</span><div><h3>Calculation</h3>
        <p>${balanced ? "Within measurement tolerance and the agreed wastage." : b.verdict === "surplus" ? "More fine metal was returned than issued. Still to be explained." : "A difference is still open."}</p></div></li>
      <li style="--i:2"><span class="step-ic ${live?.status === "final" ? "done" : live ? "wait" : ""}">${icon(live?.status === "final" ? "check" : "shield", "sm")}</span><div><h3>Settlement</h3>${settleBody}</div></li>
    </ol>
    <div class="seals" aria-label="Signatures">${seal("jeweller")}${seal("karigar")}</div>
    <p class="xs muted" style="margin-top:var(--s3)">A balanced calculation is not an approved settlement. Nothing is final until both parties sign.</p></div></section>`;
}

function bindJob() {
  const d = S.job, jid = d.job.job_id, rep = d.report;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  $("#addRec").addEventListener("click", () => openRecordForm(d));
  $("#addFirst")?.addEventListener("click", () => openRecordForm(d));
  $("#speak").addEventListener("click", async () => { const r = await speak(rep.narration, S.lang); toast(r.note); });
  $("#chgClose")?.addEventListener("click", () => { S.changes = null; $(".changes")?.remove(); });
  $("#goNext")?.addEventListener("click", e => { e.preventDefault(); const n = $("#nextCheck"); n.scrollIntoView({ block: "start" }); n.focus({ preventScroll: true }); });
  $$(".changes a[href='#review']").forEach(a => a.addEventListener("click", e => { e.preventDefault(); const n = $("#review"); n.scrollIntoView({ block: "start" }); n.focus({ preventScroll: true }); }));
  $$("[data-open]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); openRecord(b.dataset.open); }));
  $$(".ledger tbody tr").forEach(tr => tr.addEventListener("click", () => openRecord(tr.dataset.ev)));
  $$("#stripHost .seg[data-ev], #stripHost .strip-key li[data-ev]").forEach(s => s.addEventListener("click", () => openRecord(s.dataset.ev)));

  // preview an explanation on the balance (illustrative; nothing is recorded)
  const live = `${icon("dot", "sm")} Live`;
  const setPreview = key => {
    const x = key && rep.explanations.find(e => e.key === key);
    S.previewKey = x ? key : null;
    S.bench.setPreview(x ? x.titles.join(" + ") : null);
    $$("[data-wi]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.wi === S.previewKey)));
    $("#stage").classList.toggle("is-preview", !!x);
    $("#stageMode").innerHTML = x ? `${icon("target", "sm")} Preview · not recorded` : live;
    if (x) announce(`Previewing: if ${x.titles.join(" + ")} is true, the balance closes. Nothing is recorded.`);
  };
  $$("[data-wi]").forEach(b => b.addEventListener("click", () => setPreview(S.previewKey === b.dataset.wi ? null : b.dataset.wi)));
  $$("[data-preview]").forEach(b => b.addEventListener("click", () => { setPreview(b.dataset.preview); $("#stage").scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" }); }));
  $("#stage").addEventListener("keydown", e => { if (e.key === "Escape" && S.previewKey) setPreview(null); });

  // replay the records in order, each step computed by the engine
  const rin = $("#replayIn");
  if (rin) {
    const roots = replayRoots(rep), n = roots.length, j = d.job;
    let tmr, seqR = 0;
    const enableWhatIf = on => $$("[data-wi]").forEach(b => { b.disabled = !on; });
    const replayTo = async v => {
      const my = ++seqR;
      if (v === n) {
        S.bench.render(rep, { selected: S.selected }); $("#readout").innerHTML = readoutHTML(rep, false);
        $("#stageMode").innerHTML = live; $("#replayNow").hidden = true; $("#stage").classList.remove("is-replay"); enableWhatIf(true);
        return;
      }
      try {
        const r = await api("/api/quick", { method: "POST", body: {
          events: roots.slice(0, v).map(e => ({ event_type: e.event_type, value: String(e.effective.mass_g), unit: "g", fineness: String(e.effective.fineness),
            u_mass_g: String(e.u_mass_g), u_fineness: String(e.u_fineness || "0"), pieces: e.pieces || 0 })),
          metal: j.metal, wastage_min_pct: j.wastage_min_pct, wastage_max_pct: j.wastage_max_pct, pieces_expected: +j.pieces_expected || 0, lang: S.lang } });
        if (my !== seqR) return;
        if (S.previewKey) setPreview(null);
        S.bench.render(r, { replay: true }); $("#readout").innerHTML = readoutHTML(r, true);
        $("#stageMode").innerHTML = `${icon("clock", "sm")} Replay · first ${v} of ${n}`; $("#replayNow").hidden = false; $("#stage").classList.add("is-replay"); enableWhatIf(false);
      } catch (e) { fail(e); rin.value = n; $("#replayOut").textContent = `${n} of ${n} · now`; replayTo(n); }
    };
    rin.addEventListener("input", () => {
      const v = +rin.value;
      $("#replayOut").textContent = v === n ? `${n} of ${n} · now` : `${v} of ${n} · replay`;
      rin.setAttribute("aria-valuetext", `${v} of ${n} records`);
      clearTimeout(tmr); tmr = setTimeout(() => replayTo(v), 220);
    });
    $("#replayNow").addEventListener("click", () => { rin.value = n; rin.dispatchEvent(new Event("input")); });
  }

  // the next-check card turns over to collect the result
  const flip = $("#flip");
  if (flip) {
    const turn = on => {
      flip.dataset.flipped = String(on);
      $(".front", flip).inert = on; $(".back", flip).inert = !on;
      (on ? $(".back [data-check]", flip) : $("#flipGo"))?.focus({ preventScroll: true });
    };
    $("#flipGo").addEventListener("click", () => turn(true));
    $("#flipBack").addEventListener("click", () => turn(false));
  }

  const act = async (btn, fn, desc, extra = {}) => {
    const scope = btn.closest(".panel") || btn;
    scope.classList.add("busy"); btn.disabled = true;
    try { await fn(); await renderJob(jid, { action: desc }); if (extra.signed && S.changes) { S.changes.signed = extra.signed; $(`.seal[data-role="${extra.signed}"]`)?.classList.add("is-changed"); } }
    catch (e) { fail(e); scope.classList.remove("busy"); btn.disabled = false; }
  };
  $$("[data-check]").forEach(b => b.addEventListener("click", () => act(b,
    () => api(`/api/jobs/${jid}/checks`, { method: "POST", body: { check_id: b.dataset.check, outcome: b.dataset.outcome, role: S.role } }),
    `Check recorded: ${rep.investigation.next_check?.text} → ${b.dataset.outcome}`)));
  $("#resetChecks")?.addEventListener("click", e => act(e.currentTarget, () => api(`/api/jobs/${jid}/checks`, { method: "DELETE" }), "Checks restarted"));
  $$("[data-apply]").forEach(b => b.addEventListener("click", () => openApply(d, b.dataset.apply)));
  $("#draft")?.addEventListener("click", e => act(e.currentTarget, () => api(`/api/jobs/${jid}/settlements`, { method: "POST" }), "Settlement drafted"));
  $$("[data-approve-set]").forEach(b => b.addEventListener("click", () => act(b,
    () => api(`/api/settlements/${b.dataset.approveSet}/approve`, { method: "POST", body: { role: S.role } }), `Settlement signed by the ${S.role}`, { signed: S.role })));
}

function selectRecord(eid) {
  S.selected = eid;
  $$(".ledger tbody tr").forEach(tr => tr.classList.toggle("sel", tr.dataset.ev === eid));
  if (S.bench && !S.bench.replay) S.bench.highlight(eid);
  const host = $("#stripHost");
  if (host) { host.innerHTML = balanceStrip(S.job.report, { selected: eid }); $$("#stripHost [data-ev]").forEach(s => s.addEventListener("click", () => openRecord(s.dataset.ev))); }
}

function openRecord(eid) {
  const d = S.job, rep = d.report, e = rep.events.find(x => x.event_id === eid);
  if (!e) return;
  selectRecord(eid);
  const eff = e.effective || {};
  const kids = rep.events.filter(x => x.parent_event_id === eid);
  const mineDone = e[`approved_${S.role}_at`];
  const inst = S.instruments.find(i => i.instrument_id === e.instrument_id);
  const isChild = !!e.parent_event_id;
  openDrawer({
    title: e.label, sub: esc(isChild ? `Correction to ${e.parent_label}` : typeName(e.event_type)),
    body: `
      <div>${confState(e)}${eff.voided ? ` <span class="status neutral">${icon("x")}Voided by a correction</span>` : ""}</div>
      ${!isChild ? `<section><h3 class="label">Contribution to the balance</h3><p class="finding" style="font-size:var(--fs-xl);margin-top:4px">${esc(eff.voided ? "0.0000" : eff.fine_g)} g fine</p>
        <p class="xs muted">${esc(eff.mass_g)} g × purity ${esc(eff.fineness)}${["ISSUE", "ALLOY_ADD"].includes(e.event_type) ? " · counts as metal issued" : e.event_type === "STONE_SET" ? " · deducted from what is owed" : " · counts as metal accounted for"}</p></section>` : ""}
      <section><h3 class="label">As recorded</h3><dl class="kv" style="margin-top:6px">
        <dt>Written as</dt><dd class="num">${e.event_type === "ASSAY" || e.void ? "—" : `${esc(e.value_original)} ${esc(e.unit)}`}</dd>
        <dt>Weight</dt><dd class="num">${esc(e.mass_g)} g${eff.mass_g && eff.mass_g !== e.mass_g ? ` → now ${esc(eff.mass_g)} g` : ""}</dd>
        <dt>Purity</dt><dd class="num">${esc(e.fineness)}${eff.fineness && eff.fineness !== e.fineness ? ` → now ${esc(eff.fineness)}` : ""} <span class="muted">(${esc(e.assay_method || "declared")})</span></dd>
        <dt>Scale bound</dt><dd class="num">± ${(+e.u_mass_g * 1000).toFixed(1)} mg${inst ? ` · ${esc(inst.name)}` : ""}</dd>
        ${e.pieces ? `<dt>Pieces</dt><dd class="num">${esc(e.pieces)}</dd>` : ""}
        <dt>Date on slip</dt><dd>${esc(when(e.timestamp, S.lang)) || "Not given"}</dd>
        <dt>Entered</dt><dd>${esc(when(e.created_at, S.lang))}${e.created_by ? ` by ${esc(e.created_by)}` : ""}</dd>
        ${e.note ? `<dt>Note</dt><dd>${esc(e.note)}</dd>` : ""}
      </dl></section>
      ${e.document_id ? `<section><h3 class="label">Document</h3>${e.document_id.startsWith("doc_") ? `<a class="doc-thumb" href="/api/documents/${esc(e.document_id)}" target="_blank" rel="noopener"><img src="/api/documents/${esc(e.document_id)}" alt="Photo of the slip for ${esc(e.label)}"></a>` : `<p class="small">Slip reference ${esc(e.document_id)} (no photo stored).</p>`}</section>` : ""}
      ${kids.length || eff.history?.length ? `<section><h3 class="label">History</h3><ol class="history" style="margin-top:6px">
        <li><b>Original</b> · ${esc(e.value_original)} ${esc(e.unit)} at ${esc(e.fineness)}</li>
        ${kids.map(k => `<li><b>${esc(k.label)}</b> · ${esc(k.void ? "voided this record" : k.event_type === "ASSAY" ? `assay: purity ${k.fineness}` : `${k.value_original} ${k.unit}`)}${k.note ? ` <span class="muted">— ${esc(k.note)}</span>` : ""}</li>`).join("")}
      </ol></section>` : ""}
      <section><h3 class="label">Confirmations</h3><div class="parties">
        <div class="party ${e.approved_jeweller_at ? "ok" : ""}"><b>${esc(L("jeweller"))}</b><span>${e.approved_jeweller_at ? esc(when(e.approved_jeweller_at, S.lang)) : "pending"}</span></div>
        <div class="party ${e.approved_karigar_at ? "ok" : ""}"><b>${esc(L("karigar"))}</b><span>${e.approved_karigar_at ? esc(when(e.approved_karigar_at, S.lang)) : "pending"}</span></div></div></section>
      <div class="actions">${!mineDone ? `<button class="btn primary" id="recApprove">${icon("check")}${esc(L("approve"))} as ${esc(L(S.role).toLowerCase())}</button>` : ""}
        ${!isChild && !eff.voided ? `<button class="btn" id="recCorrect">${icon("edit")}${esc(L("correct"))}…</button>` : ""}</div>`,
    onMount(dr, close) {
      $("#recApprove", dr)?.addEventListener("click", async ev => {
        ev.currentTarget.disabled = true;
        try { await api(`/api/events/${eid}/approve`, { method: "POST", body: { role: S.role } }); close(false); await renderJob(d.job.job_id, { action: `${e.label} confirmed by the ${S.role}` }); }
        catch (err) { fail(err); ev.currentTarget.disabled = false; }
      });
      $("#recCorrect", dr)?.addEventListener("click", () => { close(false); openCorrect(d, eid); });
    },
    onClose() { selectRecord(""); },
  });
}

/* ---------------------------------------------------------- record form */
function openRecordForm(d) {
  const j = d.job;
  const defType = d.report.events.length ? "RETURN_FINISHED" : "ISSUE";
  openDialog({ title: L("addRecord"), desc: "Copy the slip both sides already write. A photo of it is optional but helps later checks.", wide: true, body: `
  <form class="form" id="f" novalidate>
    <label class="photo-drop" id="drop">${icon("camera", "lg")}<input type="file" accept="image/*" capture="environment" id="photo" class="sr-only"><span id="dropTxt">${esc(L("photo"))} (optional)</span></label>
    <fieldset class="field"><legend>${esc(L("type"))}</legend><div class="choice" id="tc">${TYPES.map(ty => `<button type="button" data-v="${ty}" aria-pressed="${ty === defType}">${esc(typeName(ty))}</button>`).join("")}</div></fieldset>
    <div class="field-row">
      <label class="field"><span>${esc(L("weight"))}</span><input class="big-input" name="value" inputmode="decimal" autocomplete="off" required placeholder="0.000"></label>
      <fieldset class="field"><legend>${esc(L("unit"))}</legend><div class="seg" id="uc">${["g", "tola", "masha", "ratti"].map((u, i) => `<button type="button" data-v="${u}" aria-pressed="${i === 0}">${u}</button>`).join("")}</div>
        <span class="conv" id="conv" aria-live="polite"></span></fieldset>
    </div>
    <div class="field-row">
      <label class="field"><span>${esc(L("fineness"))}</span><input name="fineness" value="${esc(j.fineness_default)}" inputmode="decimal" required><span class="hint">Between 0 and 1, e.g. 0.916 for 22 K</span></label>
      <label class="field" id="pcs"><span>${esc(L("pieces"))}</span><input name="pieces" type="number" min="0" step="1" value="1" inputmode="numeric"></label>
    </div>
    <details class="method"><summary>${icon("chevD", "sm")}Scale, uncertainty and notes</summary><div class="form" style="margin-top:var(--s3)">
      <div class="field-row"><label class="field"><span>Scale</span><select name="instrument_id"><option value="">Default bound ±2 mg</option>${S.instruments.map(i => `<option value="${esc(i.instrument_id)}">${esc(i.name)} (±${(i.u_mass_ug / 1000).toFixed(2)} mg)</option>`).join("")}</select></label>
        <label class="field"><span>Bound override (g)</span><input name="u_mass_g" inputmode="decimal" placeholder="from the scale"></label></div>
      <div class="field-row"><label class="field"><span>Purity from</span><select name="assay_method">${Object.keys(S.meta?.assay_methods || { declared: 1 }).map(m => `<option ${m === "declared" ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></label>
        <label class="field"><span>Date and time on the slip</span><input name="timestamp" type="datetime-local"></label></div>
      <label class="field"><span>Note</span><input name="note" maxlength="300"></label></div></details>
    <div class="form-error" id="err" role="alert"></div>
    <div class="dialog-actions"><button type="button" class="btn" data-close>${esc(L("cancel"))}</button><button class="btn primary" id="sv">${esc(L("save"))}</button></div>
  </form>`, initialFocus: "[name=value]", onMount(m, close) {
    let type = defType, unit = "g", file = null;
    const pick = (sel, cb) => $$(`${sel} button`, m).forEach(b => b.addEventListener("click", () => { $$(`${sel} button`, m).forEach(x => x.setAttribute("aria-pressed", String(x === b))); cb(b.dataset.v); }));
    const showPcs = () => { $("#pcs", m).hidden = type !== "RETURN_FINISHED"; };
    pick("#tc", v => { type = v; showPcs(); }); pick("#uc", v => { unit = v; conv(); });
    showPcs();
    let convSeq = 0;
    const conv = async () => {
      const v = m.querySelector("[name=value]").value.trim(), my = ++convSeq;
      if (!v || isNaN(+v) || unit === "g") { $("#conv", m).textContent = ""; return; }
      try { const r = await api("/api/convert", { method: "POST", body: { value: v, unit } }); if (my === convSeq) $("#conv", m).textContent = `= ${r.units.g} g`; } catch { $("#conv", m).textContent = ""; }
    };
    m.querySelector("[name=value]").addEventListener("input", conv);
    $("#photo", m).addEventListener("change", e => {
      file = e.target.files[0];
      if (file) $("#dropTxt", m).innerHTML = `<img src="${URL.createObjectURL(file)}" alt="Preview of the slip photo"> ${esc(file.name)}`;
    });
    $("#f", m).addEventListener("submit", async e => {
      e.preventDefault(); const f = e.target.elements;
      const errs = [];
      if (!f.value.value.trim() || isNaN(+f.value.value) || +f.value.value < 0) { errs.push("Enter the weight as a number, e.g. 12.345"); f.value.setAttribute("aria-invalid", "true"); } else f.value.removeAttribute("aria-invalid");
      const phi = +f.fineness.value;
      if (f.fineness.value.trim() === "" || isNaN(phi) || phi < 0 || phi > 1) { errs.push("Purity must be between 0 and 1, e.g. 0.916"); f.fineness.setAttribute("aria-invalid", "true"); } else f.fineness.removeAttribute("aria-invalid");
      if (errs.length) { $("#err", m).textContent = errs.join(". ") + "."; (m.querySelector("[aria-invalid=true]") || f.value).focus(); return; }
      $("#sv", m).disabled = true; $("#err", m).textContent = "";
      try {
        let document_id = "";
        if (file && navigator.onLine) {
          const fd = new FormData(); fd.append("file", file); fd.append("job_id", j.job_id);
          document_id = (await api("/api/documents", { method: "POST", form: fd })).document_id;
        }
        const body = { event_type: type, value: f.value.value.trim(), unit, fineness: f.fineness.value.trim(), pieces: type === "RETURN_FINISHED" ? +f.pieces.value || 0 : 0,
          instrument_id: f.instrument_id.value, u_mass_g: f.u_mass_g.value.trim() || null, assay_method: f.assay_method.value,
          timestamp: f.timestamp.value ? new Date(f.timestamp.value).toISOString() : "", note: f.note.value, document_id, role: S.role };
        const r = await postOrQueue(`/api/jobs/${j.job_id}/events`, body);
        close();
        if (r.queued) { toast(L("offlineQueued")); syncStatus(); }
        else await renderJob(j.job_id, { action: `Record added: ${typeName(type)}, ${body.value} ${unit}` });
      } catch (err) { $("#err", m).textContent = err.message; $("#sv", m).disabled = false; }
    });
  } });
}

function openCorrect(d, eid) {
  const e = d.report.events.find(x => x.event_id === eid);
  openDialog({ title: `${L("correct")} · ${e.label}`, desc: "The original record stays. This adds a correction that points at it, and the other party confirms it.", body: `
    <form class="form" id="f" novalidate>
      <fieldset class="field"><legend>What happened?</legend><div class="choice" id="kc">
        <button type="button" data-v="value" aria-pressed="true">Weight or unit keyed wrong</button><button type="button" data-v="reweigh" aria-pressed="false">Reweighed on a second scale</button>
        <button type="button" data-v="assay" aria-pressed="false">Assay result</button><button type="button" data-v="void" aria-pressed="false">Entered twice: void</button></div></fieldset>
      <div id="fv" class="form"><div class="field-row"><label class="field"><span>${esc(L("weight"))}</span><input name="value" inputmode="decimal" value="${esc(e.value_original)}"></label>
        <label class="field"><span>${esc(L("unit"))}</span><select name="unit">${["g", "tola", "masha", "ratti", "mg"].map(u => `<option ${u === e.unit ? "selected" : ""}>${u}</option>`).join("")}</select></label></div>
        <label class="field"><span>${esc(L("fineness"))}</span><input name="fineness" inputmode="decimal" placeholder="${esc(e.fineness)} (unchanged)"></label></div>
      <div id="fr" class="form" hidden><div class="field-row"><label class="field"><span>Reading on the second scale (g)</span><input name="rvalue" inputmode="decimal"></label>
        <label class="field"><span>Scale</span><select name="instrument_id"><option value="">Default bound ±2 mg</option>${S.instruments.map(i => `<option value="${esc(i.instrument_id)}">${esc(i.name)}</option>`).join("")}</select></label></div></div>
      <div id="fa" class="form" hidden><div class="field-row"><label class="field"><span>Measured purity</span><input name="afin" inputmode="decimal" placeholder="e.g. 0.900"></label>
        <label class="field"><span>Method</span><select name="method">${["xrf", "fire assay", "touchstone", "karat meter"].map(x => `<option>${x}</option>`).join("")}</select></label></div></div>
      <label class="field"><span>Reason</span><input name="note" maxlength="300" placeholder="What the slip photo or check showed"></label>
      <div class="form-error" id="err" role="alert"></div>
      <div class="dialog-actions"><button type="button" class="btn" data-close>${esc(L("cancel"))}</button><button class="btn primary">Add correction</button></div>
    </form>`, onMount(m, close) {
    let kind = "value";
    $$("#kc button", m).forEach(b => b.addEventListener("click", () => {
      kind = b.dataset.v; $$("#kc button", m).forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      $("#fv", m).hidden = kind !== "value"; $("#fr", m).hidden = kind !== "reweigh"; $("#fa", m).hidden = kind !== "assay";
    }));
    $("#f", m).addEventListener("submit", async ev => {
      ev.preventDefault(); const f = ev.target.elements;
      const base = { parent_event_id: eid, note: f.note.value, role: S.role };
      let body;
      if (kind === "value") body = { ...base, event_type: "CORRECTION", value: f.value.value.trim(), unit: f.unit.value, fineness: f.fineness.value.trim() || null };
      else if (kind === "reweigh") body = { ...base, event_type: "REWEIGH", value: f.rvalue.value.trim(), unit: "g", instrument_id: f.instrument_id.value };
      else if (kind === "assay") body = { ...base, event_type: "ASSAY", value: "0", fineness: f.afin.value.trim(), assay_method: f.method.value };
      else body = { ...base, event_type: "CORRECTION", value: "0", void: true };
      try { await api(`/api/jobs/${d.job.job_id}/events`, { method: "POST", body }); close(); await renderJob(d.job.job_id, { action: `Correction added to ${e.label}` }); }
      catch (err) { $("#err", m).textContent = err.message; }
    });
  } });
}

function openApply(d, key) {
  const x = d.report.explanations.find(e => e.key === key);
  const single = x.edits.length === 1 ? x.edits[0] : null;
  const massHyp = single && ["H1", "H2", "H3", "H5", "H8"].includes(single.hyp);
  const finHyp = single && single.hyp === "H4";
  const ri = d.report.investigation;
  const resolved = ri.status === "resolved" && ri.best === key && ri.log.length > 0 && !ri.next_check;
  const what = { H1: "Weight of the finished piece found (g)", H2: "Weight of the scrap found (g)", H3: "Weight of the item at the bench (g)", H5: "Reading on the second scale (g)", H8: "Weight of stones and findings (g)" };
  openDialog({ title: "Record the evidence", desc: esc(x.titles.join(" + ")), body: `
    <form class="form" id="f" novalidate>
      <ul class="log" style="margin:0">${x.edits.map(e => `<li>${icon("file", "sm")}<span>${esc(e.text)}</span></li>`).join("")}</ul>
      ${resolved ? "" : `<div class="banner warn" style="margin:0">${icon("alert")}<div>Not yet supported by a check. Record it only if both parties agree.</div></div>`}
      ${massHyp ? `<label class="field"><span>${what[single.hyp]}</span><input name="mass" inputmode="decimal" autocomplete="off" placeholder="as measured"><span class="hint">Enter the weight you measured. If left blank, the engine's estimate in the line above is used.</span></label>` : ""}
      ${finHyp ? `<label class="field"><span>Measured purity from the assay</span><input name="fin" inputmode="decimal" placeholder="e.g. 0.900"><span class="hint">If left blank, the engine's estimate is used.</span></label>` : ""}
      <p class="small muted">This adds new records; nothing existing is changed. The other party confirms them before any settlement.</p>
      <div class="form-error" id="err" role="alert"></div>
      <div class="dialog-actions"><button type="button" class="btn" data-close>${esc(L("cancel"))}</button><button class="btn primary" id="ap">${icon("check")}Add to the records</button></div>
    </form>`, onMount(m, close) {
    $("#f", m).addEventListener("submit", async e => {
      e.preventDefault();
      const mass = e.target.elements.mass?.value.trim() || null, fin = e.target.elements.fin?.value.trim() || null;
      if (mass && (isNaN(+mass) || +mass <= 0)) { $("#err", m).textContent = "Enter the weight as a positive number in grams."; e.target.elements.mass.setAttribute("aria-invalid", "true"); return; }
      if (fin && (isNaN(+fin) || +fin < 0 || +fin > 1)) { $("#err", m).textContent = "Purity must be between 0 and 1."; return; }
      $("#ap", m).disabled = true;
      try {
        const r = await api(`/api/jobs/${d.job.job_id}/apply`, { method: "POST", body: { key, role: S.role, mass_g: mass, fineness: fin } });
        close();
        await renderJob(d.job.job_id, { action: `Evidence recorded for “${x.titles.join(" + ")}”${mass ? ` (${mass} g measured)` : ""}: ${r.created.length} new record${r.created.length > 1 ? "s" : ""}` });
      } catch (err) { $("#err", m).textContent = err.message; $("#ap", m).disabled = false; }
    });
  } });
}

/* ================================================================ instruments */
const isDerived = i => i.calibrations.length > 0 && !/by hand/i.test(i.method || "");
async function renderInstruments(seq = routeSeq) {
  document.title = `${L("instruments")} · Tarazu`;
  const insts = await api("/api/instruments");
  if (stale(seq)) return;
  S.instruments = insts;
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>${esc(L("instruments"))}</h1>
      <p class="lede">Each scale's measurement bound is attached as ± to every weight recorded with it. A bound can be entered by hand or derived from repeat readings of a certified check weight.</p></div>
    <div class="actions"><button class="btn primary" id="addInst">${icon("plus")}${esc(L("addInstrument"))}</button></div></div>
    <div class="panel">${insts.length ? `<div class="inst-head-row"><span>Instrument</span><span>Readability</span><span>Measurement bound</span><span>Calibration evidence</span><span></span></div>
      ${insts.map((i, ii) => {
        const last = i.calibrations[i.calibrations.length - 1];
        return `<div class="inst" data-inst="${esc(i.instrument_id)}" style="--i:${ii}">
          <div><h3>${esc(i.name)}</h3><span class="xs muted">${isDerived(i) ? "Bound derived from recorded readings" : "Bound entered by hand"}</span></div>
          <div class="cell"><span>Readability</span><b>${(i.readability_ug / 1000).toFixed(i.readability_ug < 1000 ? 2 : 1)} mg</b></div>
          <div class="cell"><span>Measurement bound</span><b>± ${(i.u_mass_ug / 1000).toFixed(2)} mg</b></div>
          <div class="cell"><span>Calibration evidence</span><b>${i.calibrations.length ? `${i.calibrations.length} session${i.calibrations.length > 1 ? "s" : ""} · ${esc(when(last.created_at, S.lang))}` : "No readings recorded"}</b></div>
          <div class="actions"><button class="btn sm" data-cal="${esc(i.instrument_id)}">${icon("target", "sm")}${esc(L("calibrate"))}</button>
            ${i.calibrations.length ? `<button class="btn quiet sm" data-detail="${esc(i.instrument_id)}" aria-expanded="false" aria-controls="det-${esc(i.instrument_id)}">${icon("chevD", "sm")}Details</button>` : ""}</div>
          ${i.calibrations.length ? `<div class="inst-detail" id="det-${esc(i.instrument_id)}" hidden>${instDetail(i)}</div>` : ""}
        </div>`;
      }).join("")}` : `<div class="empty">${icon("scale", "lg")}<h2>No instruments yet</h2><p>Add the scales you weigh with. The reweigh check uses a second, independent scale.</p></div>`}</div>
    <details class="method panel panel-body" style="margin-top:var(--s5)"><summary>${icon("chevD", "sm")}How this is calculated</summary><div class="method-body">
      <p>Weigh a certified check weight repeatedly on the scale. For the readings, the server computes the mean deviation from the certified value (bias), the standard deviation (s) and the largest single deviation.</p>
      <p>The bound is the largest of: |bias| + 3s, the largest observed deviation, and the scale's readability. No normal-distribution assumption is needed for that bound.</p>
      <p>The server needs at least 5 readings; the study protocol asks for 30 per check weight, spread across 3 days.</p></div></details>`;
  $("#addInst").addEventListener("click", openAddInstrument);
  $$("[data-cal]").forEach(b => b.addEventListener("click", () => openCalibration(insts.find(i => i.instrument_id === b.dataset.cal))));
  $$("[data-detail]").forEach(b => b.addEventListener("click", () => {
    const det = $(`#det-${CSS.escape(b.dataset.detail)}`); det.hidden = !det.hidden; b.setAttribute("aria-expanded", String(!det.hidden));
  }));
  finishRender();
}
function instDetail(i) {
  const c = i.calibrations[i.calibrations.length - 1];
  const devs = c.readings.map(r => r - c.check_weight_ug);
  const m = Math.max(i.u_mass_ug, ...devs.map(Math.abs)) * 1.15 || 1;
  const X = v => 300 + (v / m) * 270;
  const dots = devs.map((dv, k) => `<circle style="--i:${k}" cx="${X(dv)}" cy="${44 + ((k % 5) - 2) * 5}" r="4.5" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"><title>${dv} µg</title></circle>`).join("");
  return `<figure class="dots" style="margin:0"><svg viewBox="0 0 600 96" role="img" aria-label="Latest session: ${c.readings.length} readings of ${(c.check_weight_ug / 1e6).toFixed(3)} g. Deviations range from ${Math.min(...devs)} to ${Math.max(...devs)} micrograms; the bound is plus or minus ${i.u_mass_ug} micrograms.">
      <line x1="20" x2="580" y1="44" y2="44" stroke="var(--divider)"/>
      <rect x="${X(-i.u_mass_ug)}" y="24" width="${X(i.u_mass_ug) - X(-i.u_mass_ug)}" height="40" rx="6" fill="var(--evidence-tint)" stroke="var(--evidence)" stroke-dasharray="4 3"/>
      <line x1="300" x2="300" y1="16" y2="72" stroke="var(--ink)" stroke-dasharray="2 3"/>${dots}
      <text x="300" y="90" text-anchor="middle">deviation from the certified weight · shaded band = ± ${(i.u_mass_ug / 1000).toFixed(2)} mg</text></svg>
    <figcaption class="xs muted">Latest session: ${c.readings.length} readings of a ${(c.check_weight_ug / 1e6).toFixed(3)} g check weight.</figcaption></figure>
    <div class="table-wrap"><table class="data"><thead><tr><th>Recorded</th><th class="n">Check weight</th><th class="n">Readings</th><th class="n">Bias</th><th class="n">s</th><th class="n">Largest deviation</th><th class="n">Bound</th></tr></thead>
    <tbody>${i.calibrations.slice().reverse().map(k => `<tr><td>${esc(when(k.created_at, S.lang))}</td><td class="n">${(k.check_weight_ug / 1e6).toFixed(3)} g</td><td class="n">${k.result.n}</td><td class="n">${k.result.bias_ug} µg</td><td class="n">${k.result.sd_ug} µg</td><td class="n">${k.result.max_dev_ug} µg</td><td class="n">± ${(k.result.u_mass_ug / 1000).toFixed(2)} mg</td></tr>`).join("")}</tbody></table></div>`;
}
function openAddInstrument() {
  openDialog({ title: L("addInstrument"), desc: "You can start with the bound from the scale's datasheet and replace it later with one derived from your own readings.", body: `
    <form class="form" id="f" novalidate>
      <label class="field"><span>Name</span><input name="name" required placeholder="e.g. Scale A, 0.001 g" maxlength="80"></label>
      <div class="field-row"><label class="field"><span>Readability (g)</span><input name="r" value="0.001" inputmode="decimal"><span class="hint">Smallest step the display shows</span></label>
        <label class="field"><span>Starting bound ± (g)</span><input name="u" value="0.002" inputmode="decimal"><span class="hint">Marked as entered by hand</span></label></div>
      <div class="form-error" id="err" role="alert"></div>
      <div class="dialog-actions"><button type="button" class="btn" data-close>${esc(L("cancel"))}</button><button class="btn primary">Add</button></div></form>`, onMount(m, close) {
    $("#f", m).addEventListener("submit", async e => {
      e.preventDefault(); const f = e.target.elements;
      if (!f.name.value.trim()) { $("#err", m).textContent = "Give the instrument a name."; f.name.focus(); return; }
      if (isNaN(+f.r.value) || +f.r.value <= 0 || isNaN(+f.u.value) || +f.u.value <= 0) { $("#err", m).textContent = "Readability and bound must be positive numbers in grams."; return; }
      try { await api("/api/instruments", { method: "POST", body: { name: f.name.value.trim(), readability_g: f.r.value, u_mass_g: f.u.value } }); close(); toast("Instrument added"); renderInstruments(); }
      catch (err) { $("#err", m).textContent = err.message; }
    });
  } });
}
function openCalibration(inst) {
  const REC = 30, MIN = 5;
  const st = { step: 0, weight: "10.000", readings: [] };
  openDialog({ title: `${L("calibrate")} · ${inst.name}`, desc: "Derive this scale's measurement bound from repeat readings of a certified check weight.", wide: true, body: `<div id="cal"></div>`, onMount(m, close) {
    const host = $("#cal", m);
    const steps = ["Prepare", "Check weight", "Readings", "Review", "Result"];
    const head = () => `<ol class="stepper">${steps.map((s, i) => `<li ${i === st.step ? 'aria-current="step"' : ""} class="${i < st.step ? "done" : ""}">${s}</li>`).join("")}</ol>`;
    const draw = (result) => {
      let body = "";
      if (st.step === 0) body = `<div class="form"><p>You need:</p><ul class="small" style="margin:0;padding-left:20px;display:grid;gap:4px">
          <li>A certified check weight close to the weights you usually record.</li>
          <li>The scale switched on, level and warmed up, on a stable surface away from drafts.</li>
          <li>At least ${MIN} readings now. The study protocol recommends ${REC} per check weight, across 3 days.</li></ul>
        <p class="small muted">The server computes the bound and saves the readings together. The current bound is ± ${(inst.u_mass_ug / 1000).toFixed(2)} mg (${isDerived(inst) ? "derived" : "entered by hand"}).</p>
        <div class="dialog-actions"><button type="button" class="btn" data-close>${esc(L("cancel"))}</button><button type="button" class="btn primary" data-next>Start</button></div></div>`;
      else if (st.step === 1) body = `<div class="form"><label class="field"><span>Certified value of the check weight (g)</span><input id="w" value="${esc(st.weight)}" inputmode="decimal" autocomplete="off"><span class="hint">As printed on its certificate</span></label>
        <div class="form-error" id="err" role="alert"></div>
        <div class="dialog-actions"><button type="button" class="btn" data-back>Back</button><button type="button" class="btn primary" data-next>Continue</button></div></div>`;
      else if (st.step === 2) body = `<div class="form">
        <div class="field-row" style="align-items:end"><label class="field"><span>Reading ${st.readings.length + 1} (g)</span><input id="rd" inputmode="decimal" autocomplete="off" placeholder="${esc(st.weight)}"><span class="hint">Press Enter to add. You can also paste several readings.</span></label>
          <button type="button" class="btn" id="addRd">${icon("plus")}Add reading</button></div>
        <div class="readings" id="rl" aria-label="Readings entered">${st.readings.length ? st.readings.map((r, i) => `<span class="reading">${esc(r)}<button type="button" data-rm="${i}" aria-label="Remove reading ${i + 1}">${icon("x", "sm")}</button></span>`).join("") : `<span class="small muted">No readings yet.</span>`}</div>
        <div><div class="progress" aria-hidden="true"><i style="width:${Math.min(100, st.readings.length / REC * 100)}%"></i></div>
          <p class="small" style="margin-top:6px" aria-live="polite">${st.readings.length} of ${REC} recommended · minimum ${MIN}${st.readings.length < MIN ? ` (${MIN - st.readings.length} more needed)` : ""}</p></div>
        <div class="form-error" id="err" role="alert"></div>
        <div class="dialog-actions"><button type="button" class="btn" data-back>Back</button><button type="button" class="btn primary" data-next ${st.readings.length < MIN ? "disabled" : ""}>Review</button></div></div>`;
      else if (st.step === 3) body = `<div class="form"><dl class="kv"><dt>Instrument</dt><dd>${esc(inst.name)}</dd><dt>Check weight</dt><dd class="num">${esc(st.weight)} g</dd><dt>Readings</dt><dd class="num">${st.readings.length}${st.readings.length < REC ? ` <span class="muted">(fewer than the ${REC} recommended)</span>` : ""}</dd></dl>
        <div class="readings">${st.readings.map(r => `<span class="reading" style="padding-right:8px">${esc(r)}</span>`).join("")}</div>
        <p class="small muted">On submit, the server computes the bound with max(|bias| + 3s, largest deviation, readability) and saves it with these readings.</p>
        <div class="form-error" id="err" role="alert"></div>
        <div class="dialog-actions"><button type="button" class="btn" data-back>Back</button><button type="button" class="btn primary" id="submitCal">${icon("check")}Compute and save</button></div></div>`;
      else body = `<div class="form"><div class="result-grid">
          <div class="main-r"><span>New measurement bound</span><b>± ${(result.u_mass_ug / 1000).toFixed(2)} mg</b><span>${esc(result.method)}</span></div>
          <div><span>Readings</span><b>${result.n}</b></div><div><span>Bias</span><b>${result.bias_ug} µg</b></div><div><span>s</span><b>${result.sd_ug} µg</b></div><div><span>Largest deviation</span><b>${result.max_dev_ug} µg</b></div></div>
        <p class="small muted">Saved. New records weighed on this scale will carry this bound; existing records keep the bound they were recorded with.</p>
        <div class="dialog-actions"><button type="button" class="btn primary" data-close>Done</button></div></div>`;
      host.innerHTML = head() + body;
      $$("[data-close]", host).forEach(b => b.addEventListener("click", () => { close(); renderInstruments(); }));
      $("[data-back]", host)?.addEventListener("click", () => { st.step--; draw(); });
      const next = $("[data-next]", host);
      const addReadings = txt => {
        const parts = txt.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
        const bad = parts.filter(p => isNaN(+p) || +p <= 0);
        if (bad.length) { $("#err", host).textContent = `Not a valid reading in grams: ${bad.join(", ")}`; return false; }
        st.readings.push(...parts); return true;
      };
      if (st.step === 1) {
        $("#w", host).focus();
        next.addEventListener("click", () => { const v = $("#w", host).value.trim(); if (!v || isNaN(+v) || +v <= 0) { $("#err", host).textContent = "Enter the certified weight in grams, e.g. 10.000."; $("#w", host).setAttribute("aria-invalid", "true"); return; } st.weight = v; st.step = 2; draw(); });
      } else if (st.step === 2) {
        const inp = $("#rd", host); inp.focus();
        const add = () => { if (!inp.value.trim()) return; if (addReadings(inp.value)) draw(); };
        inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); add(); } });
        inp.addEventListener("paste", e => { const t = e.clipboardData.getData("text"); if (/[\s,;]/.test(t.trim())) { e.preventDefault(); if (addReadings(t)) draw(); } });
        $("#addRd", host).addEventListener("click", add);
        $$("[data-rm]", host).forEach(b => b.addEventListener("click", () => { st.readings.splice(+b.dataset.rm, 1); draw(); }));
        next.addEventListener("click", () => { st.step = 3; draw(); });
      } else if (next) next.addEventListener("click", () => { st.step++; draw(); });
      $("#submitCal", host)?.addEventListener("click", async e => {
        e.currentTarget.disabled = true;
        try { const r = await api(`/api/instruments/${inst.instrument_id}/calibrate`, { method: "POST", body: { check_weight_g: st.weight, readings_g: st.readings } }); st.step = 4; draw(r); }
        catch (err) { $("#err", host).textContent = err.message; e.currentTarget.disabled = false; }
      });
    };
    draw();
  } });
}

/* ================================================================ evaluation */
async function renderEval(seq = routeSeq) {
  document.title = `${L("evaluation")} · Tarazu`;
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>${esc(L("evaluation"))}</h1>
      <p class="lede">How the engine performs on a seeded, synthetic workshop with faults injected blind, compared with simpler methods. These are simulation results, not measurements from a real workshop.</p></div></div>
    <div class="banner">${icon("info")}<div><b>Simulated.</b> Every number on this page comes from synthetic data generated by the evaluation harness. Real-world accuracy requires a trial with real scales and real disputes.</div></div>
    <form class="panel panel-body eval-form" id="ef" style="margin-bottom:var(--s5)">
      <label class="field"><span>Seed</span><input name="seed" type="number" value="2026"></label>
      <label class="field"><span>Clean runs</span><input name="n_clean" type="number" value="60" min="10" max="200"></label>
      <label class="field"><span>Runs per fault</span><input name="n_per_fault" type="number" value="10" min="2" max="40"></label>
      <label class="field"><span>Sweep runs</span><input name="n_sweep" type="number" value="8" min="2" max="30"></label>
      <button class="btn primary" id="runEval">${icon("refresh")}Run</button></form>
    <div id="evalOut" aria-live="polite"></div>`;
  $("#ef").addEventListener("submit", async e => {
    e.preventDefault(); const f = e.target.elements;
    $("#runEval").disabled = true; $("#evalOut").innerHTML = `<p class="muted">Running the harness. This takes a few seconds…</p>`;
    try { const r = await api("/api/harness/run", { method: "POST", body: { seed: +f.seed.value, n_clean: +f.n_clean.value, n_per_fault: +f.n_per_fault.value, n_sweep: +f.n_sweep.value, n_pairs: 10 } }); showEval(r); }
    catch (err) { $("#evalOut").innerHTML = `<div class="banner warn">${icon("alert")}<div>${esc(err.message)}</div></div>`; }
    finally { $("#runEval").disabled = false; }
  });
  const last = await api("/api/harness/last").catch(() => ({}));
  if (stale(seq)) return;
  if (last && last.label) showEval(last); else $("#evalOut").innerHTML = `<div class="panel empty"><h2>No run yet</h2><p>Press Run to generate the simulated evaluation.</p></div>`;
  finishRender();
}
function showEval(r) {
  if (!$("#evalOut")) return;
  const pct = (k, n) => n ? `${(100 * k / n).toFixed(0)}%` : "–";
  const fa = r.false_alerts, ck = r.checks;
  const mult = [0.5, 1, 2, 5, 10];
  const aggM = (key, m) => { const rows = r.sweep.filter(s => s.multiple === m); return rows.reduce((a, s) => a + s[key], 0) / rows.reduce((a, s) => a + s.n, 0); };
  const det2 = Math.min(...[2, 5, 10].map(m => aggM("tarazu", m))), below1 = aggM("tarazu", 0.5);
  const fewer = ck.fixed.mean_checks ? 1 - ck.best.mean_checks / ck.fixed.mean_checks : 0;
  const criteria = [
    ["False alerts on clean jobs", "≤ 3%", `${pct(fa.tarazu.k, fa.tarazu.n)} (95% upper bound ${(fa.tarazu.upper95 * 100).toFixed(1)}%)`, fa.tarazu.k / fa.tarazu.n <= 0.03],
    ["Detection by fault size", "≥ 90% at ≥ 2×; silent below 1×", `${(det2 * 100).toFixed(0)}% at ≥ 2× · ${(below1 * 100).toFixed(0)}% at 0.5×`, det2 >= 0.9 && below1 <= 0.1],
    ["True cause among explanations", "≥ 85% of single faults", `${pct(r.coverage.k, r.coverage.n)} (${r.coverage.k}/${r.coverage.n})`, r.coverage.k / r.coverage.n >= 0.85],
    ["Correct cause after checks", "≥ 80% of single faults", `${pct(ck.best.resolved_correct, ck.best.n)}`, ck.best.resolved_correct / ck.best.n >= 0.8],
    ["Checks to resolution", "≥ 25% fewer than a fixed checklist", `${ck.best.mean_checks} vs ${ck.fixed.mean_checks} (${(fewer * 100).toFixed(0)}% fewer)`, fewer >= 0.25],
    ["Abstains when it should", "≥ 90%; confidently wrong ≤ 5%", `${pct(r.abstention.k, r.abstention.n)} · wrong ${pct(ck.best.confident_wrong, ck.best.n)}`, r.abstention.k / r.abstention.n >= 0.9 && ck.best.confident_wrong / ck.best.n <= 0.05],
    ["Interval contains the truth", "≥ 95% of clean jobs", pct(r.interval_coverage.k, r.interval_coverage.n), r.interval_coverage.k / r.interval_coverage.n >= 0.95],
    ["Speed", "< 2 s for 30 records", `${r.latency.ms} ms`, r.latency.under_2s],
  ];
  $("#evalOut").innerHTML = `
    <div class="tiles">
      <div class="panel tile"><span class="v">${fa.tarazu.k}/${fa.tarazu.n}</span><span class="k">False alerts on clean jobs</span><span class="s">Fixed tolerance: ${fa.B1_fixed_tol.k}/${fa.B1_fixed_tol.n} · plain ledger: ${fa.B0_point.k}/${fa.B0_point.n}</span></div>
      <div class="panel tile"><span class="v">${pct(r.coverage.k, r.coverage.n)}</span><span class="k">True cause among the explanations</span><span class="s">Single best guess only: ${pct(r.single_best_guess.k, r.single_best_guess.n)}</span></div>
      <div class="panel tile"><span class="v">${ck.best.mean_checks}</span><span class="k">Checks to resolution, on average</span><span class="s">Fixed checklist ${ck.fixed.mean_checks} · random order ${ck.random.mean_checks}</span></div>
      <div class="panel tile"><span class="v">${r.pairs.abstained_or_asked}/${r.pairs.n}</span><span class="k">Two-fault cases handled safely</span><span class="s">Both listed ${r.pairs.both_listed} · confidently wrong ${r.pairs.confident_wrong}</span></div>
    </div>
    <div class="grid2">
      <section class="panel chart-panel"><div class="panel-head"><h2>Detection versus fault size</h2><span class="sub">Simulated</span></div><div class="panel-body">
        <div class="legend" id="lg1"></div><svg id="c1"></svg><div class="tooltip" id="tp1" hidden></div>
        <p class="small muted" style="margin-top:var(--s2)">Faults F1, F2, F3 and F5 pooled, at multiples of each run's noise half-width. The engine should stay silent below 1× and detect above 2×.</p></div></section>
      <section class="panel chart-panel"><div class="panel-head"><h2>Checks needed to resolve</h2><span class="sub">Simulated</span></div><div class="panel-body">
        <div class="legend" id="lg2"></div><svg id="c2"></svg>
        <p class="small muted" style="margin-top:var(--s2)">Same detected single faults for every policy. The fixed and random baselines skip checks that cannot change anything, which flatters them.</p></div></section>
    </div>
    <section class="panel" style="margin-top:var(--s5)"><div class="panel-head"><h2>Proposed pass criteria</h2><span class="sub">Protocol section 7.2 · simulated, not the physical trial</span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Measure</th><th>Criterion</th><th>Observed</th><th>Result</th></tr></thead><tbody>
      ${criteria.map(([a, b, c, ok]) => `<tr><td>${a}</td><td class="muted">${b}</td><td class="num">${c}</td><td class="${ok ? "pass" : "miss"}">${icon(ok ? "check" : "x", "sm")} ${ok ? "Pass" : "Miss"}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="xs muted" style="padding:var(--s3) var(--s5)">Not run here: ${Object.entries(r.not_run).map(([k, v]) => `${esc(k)} (${esc(v)})`).join("; ")}. Generator ${esc(r.generator)}, seed ${esc(r.seed)}, ${esc(r.elapsed_s)} s.</p></section>
    <section class="panel" style="margin-top:var(--s5)"><div class="panel-head"><h2>By fault class</h2><span class="sub">Counts out of runs; coverage and resolution out of detected runs</span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Fault</th><th>Expected cause</th><th class="n">Runs</th><th class="n">Detected</th><th class="n">Fixed tol. detected</th><th class="n">Covered</th><th class="n">Best guess right</th><th class="n">Resolved right</th></tr></thead><tbody>
      ${Object.entries(r.per_class).map(([f, v]) => `<tr><td class="mono">${esc(f)}</td><td>${esc(v.hyp)}</td><td class="n">${v.n}</td><td class="n">${v.detected}</td><td class="n">${v.b1_detected}</td><td class="n">${v.covered}</td><td class="n">${v.top1}</td><td class="n">${v.resolved_correct}</td></tr>`).join("")}
      </tbody></table></div></section>`;
  const css = getComputedStyle(document.documentElement);
  const c1 = css.getPropertyValue("--series-1").trim(), c2 = css.getPropertyValue("--series-2").trim(), c3 = css.getPropertyValue("--series-3").trim();
  drawLines($("#c1"), { width: 560, height: 280, xs: mult.map(m => `${m}×`), yLabel: "fault size (× noise half-width)", tip: $("#tp1"), legend: $("#lg1"),
    series: [
      { name: "Tarazu", color: c1, values: mult.map(m => aggM("tarazu", m)) },
      { name: "Fixed tolerance", color: c2, values: mult.map(m => aggM("b1", m)), dash: "6 4" },
      { name: "Plain ledger", color: c3, values: mult.map(m => aggM("b0", m)), dash: "2 4" },
    ] });
  drawBars($("#c2"), { width: 520, legend: $("#lg2"), series: [{ name: "Mean checks", color: c1 }, { name: "Mean minutes ÷ 10", color: c2 }],
    rows: [["Information per effort", ck.best], ["Fixed checklist", ck.fixed], ["Random order", ck.random]].map(([label, v]) => ({ label, values: [v.mean_checks, +(v.mean_minutes / 10).toFixed(2)] })) });
}

/* ================================================================ settings */
function renderSettings() {
  document.title = `${L("settings")} · Tarazu`;
  const n = outboxCount();
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>${esc(L("settings"))}</h1><p class="lede">Unit conversion, language, sample data and offline sync.</p></div></div>
  <div class="settings-grid">
    <section class="panel" aria-labelledby="cvT"><div class="panel-head"><h2 id="cvT">${esc(L("units"))}</h2><span class="sub">Computed by the server</span></div>
      <div class="panel-body form">
        <div class="field-row"><label class="field"><span>${esc(L("weight"))}</span><input class="big-input" id="cv" value="1" inputmode="decimal" autocomplete="off"></label>
          <label class="field"><span>${esc(L("fineness"))} <span class="hint">optional</span></span><input id="cf" value="0.916" inputmode="decimal"></label></div>
        <fieldset class="field"><legend>From unit</legend><div class="seg" id="cu">${["tola", "masha", "ratti", "g", "mg"].map((u, i) => `<button type="button" data-v="${u}" aria-pressed="${i === 0}">${u}</button>`).join("")}</div></fieldset>
        <div class="table-wrap"><table class="data conv-table"><tbody id="ct"></tbody></table></div>
        <p class="small muted">1 tola = 11.6638 g, 1 masha = 1/12 tola, 1 ratti = 1/8 masha. Reading a masha as a gram, or a tola as 10 g, is one of the errors the engine looks for, and it names the unit when it finds one.</p>
      </div></section>
    <div class="stack">
      <section class="panel" aria-labelledby="prefT"><div class="panel-head"><h2 id="prefT">Language</h2></div><div class="panel-body form">
        <div class="seg" id="langSeg">${[["en", "English"], ["hi", "हिन्दी"], ["pa", "ਪੰਜਾਬੀ"]].map(([k, l]) => `<button type="button" data-lang="${k}" lang="${k}" aria-pressed="${S.lang === k}">${l}</button>`).join("")}</div>
        <p class="small muted">Engine findings, explanations and checks are written by the server in the chosen language, and read-aloud uses the same sentences. Some interface help text is in English only.</p></div></section>
      <section class="panel" aria-labelledby="syncT"><div class="panel-head"><h2 id="syncT">Offline and sync</h2></div><div class="panel-body form">
        <dl class="kv"><dt>Connection</dt><dd>${esc(navigator.onLine ? L("online") : L("offline"))}</dd><dt>Saved on this device</dt><dd>${n ? `${n} record${n > 1 ? "s" : ""} ${esc(L("waiting"))}` : esc(L("allSynced"))}</dd></dl>
        <p class="small muted">With no connection, new records are kept on this device and sent when the connection returns. Investigations and approvals need the server.</p>
        <div><button class="btn" id="syncNow" ${n && navigator.onLine ? "" : "disabled"}>${icon("refresh")}Send now</button></div></div></section>
      <section class="panel" aria-labelledby="dataT"><div class="panel-head"><h2 id="dataT">Data</h2></div><div class="panel-body form">
        <p class="small">Records are stored by the server on this computer in an SQLite file. The database refuses edits and deletions of records; corrections are added as new rows.</p>
        <div class="actions"><button class="btn" id="peopleS">${icon("users")}${esc(L("people"))}</button><button class="btn" id="seedS">${esc(L("demo"))}</button><a class="btn quiet" href="/demo.html">${icon("book")}${esc(L("walkthrough"))}</a></div>
        <p class="xs muted">The sample workshop adds five synthetic jobs, each labelled Sample. It never alters your own jobs.</p></div></section>
    </div>
  </div>`;
  let unit = "tola", seq = 0;
  const run = async () => {
    const my = ++seq, fin = $("#cf").value.trim();
    try {
      const r = await api("/api/convert", { method: "POST", body: { value: $("#cv").value || "0", unit, fineness: fin || null } });
      if (my !== seq) return;
      $("#ct").innerHTML = Object.entries(r.units).map(([u, v]) => `<tr><td>${u}</td><td class="n">${esc(v)}</td></tr>`).join("") +
        (r.fine_g ? `<tr><td><b>Fine metal at ${esc(fin)}</b></td><td class="n"><b>${esc(r.fine_g)} g</b></td></tr>` : "");
      $$("#ct tr").forEach(tr => tr.classList.add("is-changed"));
    } catch (e) { if (my === seq) $("#ct").innerHTML = `<tr><td colspan="2" class="form-error">${esc(e.message)}</td></tr>`; }
  };
  $$("#cu button").forEach(b => b.addEventListener("click", () => { unit = b.dataset.v; $$("#cu button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); run(); }));
  $("#cv").addEventListener("input", run); $("#cf").addEventListener("input", run);
  $$("#langSeg button").forEach(b => b.addEventListener("click", () => { S.lang = b.dataset.lang; store.set("lang", S.lang); applyChrome(); renderSettings(); }));
  $("#syncNow").addEventListener("click", async () => { await syncNow(); renderSettings(); });
  $("#peopleS").addEventListener("click", openPeople);
  $("#seedS").addEventListener("click", seedDemo);
  run();
  finishRender();
}

/* ================================================================ command palette + shortcuts */
let cmdItems = [], cmdIdx = 0, cmdOpener = null;
function commands() {
  const go = (t, ic, hash) => ({ g: "Go to", t, ic, run: () => { location.hash = hash; } });
  const items = [go(L("jobs"), "jobs", "#jobs"), go(L("instruments"), "scale", "#instruments"), go(L("evaluation"), "chart", "#eval"), go(L("settings"), "settings", "#settings"),
    { g: "Go to", t: L("walkthrough"), ic: "book", run: () => { location.href = "/demo.html"; } }];
  if (S.job && location.hash.startsWith("#job/")) items.unshift({ g: "This job", t: `${L("addRecord")} · ${S.job.job.title}`, ic: "plus", run: () => openRecordForm(S.job) });
  if (S.role === "jeweller") items.push({ g: "Actions", t: L("newJob"), ic: "plus", run: openNewJob }, { g: "Actions", t: L("people"), ic: "users", run: openPeople }, { g: "Actions", t: L("demo"), ic: "layers", run: seedDemo });
  (S.jobs || []).forEach(j => items.push({ g: "Jobs", t: j.title, sub: `${j.karigar_name} · ${diffLabel(j)}`, ic: "file", run: () => { location.hash = `#job/${j.job_id}`; } }));
  items.push({ g: "View as", t: L("workshopView"), ic: "user", run: () => switchView("jeweller") });
  S.parties.filter(p => p.role === "karigar").forEach(k => items.push({ g: "View as", t: `${L("karigar")} · ${k.name}`, ic: "user", run: () => switchView(`k:${k.party_id}`) }));
  [["en", "English"], ["hi", "हिन्दी"], ["pa", "ਪੰਜਾਬੀ"]].forEach(([k, l]) => items.push({ g: "Language", t: l, ic: "compass", run: () => { S.lang = k; store.set("lang", k); applyChrome(); route(); } }));
  items.push({ g: "Help", t: L("tour"), ic: "compass", run: () => $("#tourBtn").click() }, { g: "Help", t: "Keyboard shortcuts", ic: "info", run: openKeys });
  return items;
}
function drawCmd() {
  const q = $("#cmdIn").value.trim().toLowerCase();
  cmdItems = commands().filter(it => !q || `${it.t} ${it.sub || ""} ${it.g}`.toLowerCase().includes(q)).slice(0, 40);
  cmdIdx = Math.min(cmdIdx, Math.max(0, cmdItems.length - 1));
  let last = "", html = "";
  cmdItems.forEach((it, i) => {
    if (it.g !== last) { html += `<li class="grp" role="presentation">${esc(it.g)}</li>`; last = it.g; }
    html += `<li role="option" id="cmd-${i}" data-i="${i}" aria-selected="${i === cmdIdx}">${icon(it.ic)}<span>${esc(it.t)}</span>${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</li>`;
  });
  $("#cmdList").innerHTML = html || `<li class="none">Nothing matches “${esc(q)}”.</li>`;
  $("#cmdIn").setAttribute("aria-activedescendant", cmdItems.length ? `cmd-${cmdIdx}` : "");
  $(`#cmd-${cmdIdx}`)?.scrollIntoView({ block: "nearest" });
}
async function openCmd() {
  if (!$("#cmdk").hidden) return;
  cmdOpener = document.activeElement; closeAcct();
  $("#cmdk").hidden = false; $("#cmdIn").value = ""; cmdIdx = 0; drawCmd(); $("#cmdIn").focus();
  if (!S.jobs) { try { S.jobs = await api(`/api/jobs${S.role === "karigar" ? `?karigar_id=${encodeURIComponent(S.viewer)}` : ""}`); if (!$("#cmdk").hidden) drawCmd(); } catch { /* jobs stay unlisted */ } }
}
function closeCmd() { if ($("#cmdk").hidden) return; $("#cmdk").hidden = true; cmdOpener?.focus?.(); }
function runCmd(i) { const it = cmdItems[i]; if (!it) return; closeCmd(); it.run(); }
$("#cmdIn").addEventListener("input", () => { cmdIdx = 0; drawCmd(); });
$("#cmdIn").addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { e.preventDefault(); cmdIdx = Math.min(cmdItems.length - 1, cmdIdx + 1); drawCmd(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); cmdIdx = Math.max(0, cmdIdx - 1); drawCmd(); }
  else if (e.key === "Enter") { e.preventDefault(); runCmd(cmdIdx); }
  else if (e.key === "Escape") { e.preventDefault(); closeCmd(); }
  else if (e.key === "Tab") e.preventDefault();
});
$("#cmdList").addEventListener("mousemove", e => { const li = e.target.closest("[data-i]"); if (li && +li.dataset.i !== cmdIdx) { cmdIdx = +li.dataset.i; drawCmd(); } });
$("#cmdList").addEventListener("click", e => { const li = e.target.closest("[data-i]"); if (li) runCmd(+li.dataset.i); });
$("#cmdk").addEventListener("mousedown", e => { if (e.target.id === "cmdk") closeCmd(); });

function openKeys() {
  openDialog({ title: "Keyboard shortcuts", body: `<dl class="keys">
    <dt><kbd>Ctrl</kbd> <kbd>K</kbd> or <kbd>/</kbd></dt><dd>Search jobs, pages and actions</dd>
    <dt><kbd>g</kbd> then <kbd>j</kbd> <kbd>i</kbd> <kbd>e</kbd> <kbd>s</kbd></dt><dd>Go to jobs, instruments, evaluation or settings</dd>
    <dt><kbd>n</kbd></dt><dd>New record on a job, or a new job in the workshop</dd>
    <dt><kbd>Esc</kbd></dt><dd>Close a dialog, drawer or preview</dd>
    <dt><kbd>?</kbd></dt><dd>This list</dd></dl>
    <div class="dialog-actions" style="margin-top:var(--s4)"><button class="btn primary" data-close>Done</button></div>` });
}
let gPending = 0;
addEventListener("keydown", e => {
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#cmdk").hidden ? openCmd() : closeCmd(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || !$("#cmdk").hidden || $(".dialog-back, .drawer, .tour")) return;
  if (e.key === "/") { e.preventDefault(); openCmd(); }
  else if (e.key === "?") { e.preventDefault(); openKeys(); }
  else if (e.key === "n") { if (S.job && location.hash.startsWith("#job/")) openRecordForm(S.job); else if (S.role === "jeweller" && (location.hash || "#jobs") === "#jobs") openNewJob(); }
  else if (e.key === "g") { gPending = Date.now(); }
  else if (Date.now() - gPending < 1200 && "jies".includes(e.key)) { gPending = 0; location.hash = { j: "#jobs", i: "#instruments", e: "#eval", s: "#settings" }[e.key]; }
});

/* ================================================================ boot */
async function loadParties() { S.parties = await api("/api/parties"); applyChrome(); }
(async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  syncStatus();
  try {
    [S.meta] = await Promise.all([api("/api/meta"), loadParties()]);
    S.instruments = await api("/api/instruments");
  } catch { /* route() shows the error state */ }
  applyChrome();
  route();
})();
