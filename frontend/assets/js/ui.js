// Shared components for the workbench and the landing page.
// Every number shown here comes from the engine's response; nothing is recomputed authoritatively.
import { icon } from "./icons.js";

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Show an engine quantity string as grams, keeping its own precision. */
export const grams = (x, unit = "g") => `${esc(String(x ?? "–"))} ${unit}`;
/** Display-only rounding (labels, chart annotations). */
export const g3 = x => (Math.abs(+x) < 5e-5 ? 0 : +x).toFixed(3);

export function when(iso, lang = "en") {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  const loc = { en: "en-IN", hi: "hi-IN", pa: "pa-IN" }[lang] || "en-IN";
  return d.toLocaleString(loc, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (isNaN(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/* ------------------------------------------------------------- status */
export const VERDICT = {
  balanced: { cls: "ok", ic: "check", en: "Within measurement tolerance" },
  unaccounted: { cls: "attention", ic: "alert", en: "Difference found" },
  surplus: { cls: "surplus", ic: "info", en: "More returned than issued" },
  error: { cls: "error", ic: "alert", en: "Could not compute" },
};
export function statusLabel(verdict, label) {
  const v = VERDICT[verdict] || VERDICT.error;
  return `<span class="status ${v.cls}">${icon(v.ic)}${esc(label || v.en)}</span>`;
}

/* ------------------------------------------------------- balance strip */
const OUT = { RETURN_FINISHED: "finished", RETURN_SCRAP: "scrap", WIP_HOLD: "wip", TRANSFER: "transfer" };
const SEG_LABEL = { finished: "Finished pieces", scrap: "Scrap & sweepings", wip: "Work in progress", transfer: "Transferred", deduct: "Stones & fixtures deducted" };
let uid = 0;

/**
 * Material-accounting strip: issued fine metal as the full track, each accounted record as a segment,
 * and the unresolved (or surplus) portion hatched and labelled. Widths are display geometry only.
 */
export function balanceStrip(rep, { selected = "", compact = false } = {}) {
  const b = rep.balance, id = `bs${++uid}`;
  const fin = +b.fine_in_g, fout = +b.fine_out_g, fded = +b.fine_deduct_g, raw = +b.raw_g;
  const segs = [];
  for (const e of rep.events) {
    if (e.parent_event_id || e.effective?.voided) continue;
    const kind = OUT[e.event_type] || (e.event_type === "STONE_SET" ? "deduct" : null);
    if (!kind) continue;
    const g = Math.abs(+(e.effective?.fine_g ?? 0));
    if (g > 0) segs.push({ kind, g, ev: e.event_id, label: e.label, fine: e.effective.fine_g });
  }
  const total = Math.max(fin, fout + fded, 1e-9);
  const W = 1000, H = compact ? 46 : 56, y = 8, h = compact ? 24 : 30;
  const X = g => (g / total) * W;
  let x = 0, rects = "";
  segs.forEach((s, k) => {
    const w = Math.max(X(s.g) - 2, 1.5);
    rects += `<rect style="--i:${k}" class="seg seg-${s.kind}${selected && selected !== s.ev ? " dim" : ""}${selected === s.ev ? " sel" : ""}" data-ev="${esc(s.ev)}" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"><title>${esc(s.label)}: ${esc(s.fine)} g fine</title></rect>`;
    x += X(s.g);
  });
  const issuedX = X(fin);
  let gapNote = "", gapKey = "";
  if (b.verdict !== "balanced" && raw > 0) {
    const realW = X(raw), w = Math.max(realW, 16);
    if (w > realW + 0.5) gapNote = "Unresolved portion enlarged so it stays visible; widths are otherwise to scale.";
    rects += `<rect class="seg seg-gap" x="${issuedX - w}" y="${y}" width="${w}" height="${h}" rx="3" fill="url(#${id}h)"><title>Unresolved: ${esc(b.raw_g)} g fine</title></rect>`;
    gapKey = `<li class="key-gap"><i class="sw sw-gap"></i><span>Not yet accounted for</span><b class="qty">${esc(b.raw_g)} g</b></li>`;
  } else if (b.verdict === "surplus" || raw < 0) {
    const realW = Math.abs(X(raw)), w = Math.max(realW, 16);
    if (w > realW + 0.5) gapNote = "Surplus portion enlarged so it stays visible; widths are otherwise to scale.";
    rects += `<rect class="seg seg-surplus" x="${issuedX}" y="${y}" width="${Math.min(w, W - issuedX + 16)}" height="${h}" rx="3" fill="url(#${id}s)"><title>Surplus: ${g3(-raw)} g fine more returned than issued</title></rect>`;
    gapKey = `<li class="key-surplus"><i class="sw sw-surplus"></i><span>Returned beyond what was issued</span><b class="qty">${g3(-raw)} g</b></li>`;
  }
  const marker = `<line class="issued-mark" x1="${issuedX}" x2="${issuedX}" y1="2" y2="${y + h + 6}"/>`;
  const keyItems = segs.map((s, k) => `<li style="--i:${k}" data-ev="${esc(s.ev)}" class="${selected === s.ev ? "sel" : ""}"><i class="sw sw-${s.kind}"></i><span>${esc(SEG_LABEL[s.kind])} <span class="muted">· ${esc(s.label)}</span></span><b class="qty">${esc(s.fine)} g</b></li>`).join("");
  const sentence = b.verdict === "balanced"
    ? `Issued ${b.fine_in_g} g fine. Accounted ${b.fine_out_g} g returned${fded ? ` and ${b.fine_deduct_g} g deducted` : ""}. The remainder is within measurement tolerance and agreed wastage.`
    : b.verdict === "surplus"
      ? `Issued ${b.fine_in_g} g fine. Accounted ${b.fine_out_g} g, which is ${g3(-raw)} g more than was issued.`
      : `Issued ${b.fine_in_g} g fine. Accounted ${b.fine_out_g} g returned${fded ? ` and ${b.fine_deduct_g} g deducted` : ""}. ${b.raw_g} g is not yet accounted for.`;
  return `<figure class="strip${compact ? " compact" : ""}">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(sentence)}">
      <defs>
        <pattern id="${id}h" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="8" class="hatch-line"/></pattern>
        <pattern id="${id}s" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="8" height="8" class="hatch-bg-s"/><line x1="0" y1="0" x2="0" y2="8" class="hatch-line-s"/></pattern>
      </defs>
      <rect class="track" x="0" y="${y}" width="${issuedX}" height="${h}" rx="3"/>
      ${rects}${marker}
    </svg>
    <figcaption class="sr-only">${esc(sentence)}</figcaption>
    ${compact ? "" : `<ul class="strip-key">${keyItems}${gapKey}</ul>${gapNote ? `<p class="strip-note">${esc(gapNote)}</p>` : ""}`}
  </figure>`;
}

/* ------------------------------------------------------ tolerance line */
/** Difference as an interval against zero and the agreed-wastage band, matching the engine's interval model. */
export function toleranceLine(b) {
  const W = 640, H = 128, y = 52, L = 16, R = W - 16;
  const bandLo = +b.band_lo_g, bandHi = +b.band_hi_g;
  const lo = +b.residual_lo_g + bandHi, hi = +b.residual_hi_g + bandLo, raw = +b.raw_g;
  let a = Math.min(0, lo, bandLo), z = Math.max(0, hi, bandHi);
  let span = z - a; if (span < 0.01) { a -= 0.005; z += 0.005; span = z - a; }
  a -= span * 0.15; z += span * 0.15;
  const X = v => L + ((v - a) / (z - a)) * (R - L);
  let ix = X(lo), iw = X(hi) - X(lo); const enlarged = iw < 10; if (enlarged) { ix -= (10 - iw) / 2; iw = 10; }
  const bw = Math.max(X(bandHi) - X(bandLo), 2);
  const cls = b.verdict === "balanced" ? "ok" : b.verdict === "surplus" ? "surplus" : "attention";
  const rangeLabel = `measured difference ${g3(lo)} to ${g3(hi)} g`;
  const bandLabel = bandHi > bandLo ? `agreed wastage ${g3(bandLo)}–${g3(bandHi)} g` : "no wastage agreed";
  const cx = Math.min(Math.max(ix + iw / 2, 140), W - 140);
  const bx = Math.min(Math.max(X(bandLo) + bw / 2, 80), W - 80);
  const rangeBelow = Math.abs(cx - X(0)) < 120;
  const sentence = `The difference lies between ${g3(lo)} and ${g3(hi)} grams of fine metal once scale and purity uncertainty are included. ${bandLabel[0].toUpperCase() + bandLabel.slice(1)}. ${b.verdict === "balanced" ? "The range reaches the allowance, so it is within tolerance." : "The whole range is outside the allowance."}`;
  return `<figure class="tol">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(sentence)}">
      <line class="tol-axis" x1="${L}" x2="${R}" y1="${y}" y2="${y}"/>
      <rect class="tol-band" x="${X(bandLo)}" y="${y - 16}" width="${bw}" height="32" rx="4"/>
      <line class="tol-zero" x1="${X(0)}" x2="${X(0)}" y1="${y - 26}" y2="${y + 26}"/>
      <text class="tol-t" x="${X(0)}" y="${y - 32}" text-anchor="middle">0 · exact balance</text>
      <rect class="tol-range ${cls}" x="${ix}" y="${y - 6}" width="${iw}" height="12" rx="6"/>
      <circle class="tol-pt" cx="${X(raw)}" cy="${y}" r="3"/>
      <text class="tol-t strong" x="${cx}" y="${rangeBelow ? y + 40 : y - 32}" text-anchor="middle">${esc(rangeLabel)}</text>
      <text class="tol-t band" x="${bx}" y="${rangeBelow && Math.abs(cx - bx) < 220 ? y + 64 : y + 40}" text-anchor="middle">${esc(bandLabel)}</text>
    </svg>
    <figcaption class="small muted">${esc(sentence)}${enlarged ? " The range is drawn wider than scale so it stays visible." : ""}</figcaption>
  </figure>`;
}

/* ------------------------------------------------------------- toasts */
export function toast(msg, kind = "") {
  let host = $("#toasts");
  if (!host) { host = document.createElement("div"); host.id = "toasts"; host.className = "toasts"; host.setAttribute("role", "status"); host.setAttribute("aria-live", "polite"); document.body.appendChild(host); }
  const n = document.createElement("div");
  n.className = `toast ${kind}`;
  n.innerHTML = `${icon(kind === "error" ? "alert" : "check")}<span>${esc(msg)}</span>`;
  host.appendChild(n);
  setTimeout(() => n.remove(), kind === "error" ? 8000 : 4800);
}

/* -------------------------------------------- dialog + drawer (focus-managed) */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function trap(root, onEsc) {
  const h = e => {
    if (e.key === "Escape") { e.stopPropagation(); onEsc(); return; }
    if (e.key !== "Tab") return;
    const f = $$(FOCUSABLE, root).filter(n => n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  root.addEventListener("keydown", h);
}

export function openDialog({ title, desc = "", body, wide = false, onMount, initialFocus }) {
  const opener = document.activeElement;
  const back = document.createElement("div");
  back.className = "dialog-back";
  const tid = `dlg${++uid}`;
  back.innerHTML = `<div class="dialog${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="${tid}" tabindex="-1">
    <div class="dialog-head"><div><h2 id="${tid}">${esc(title)}</h2>${desc ? `<p>${desc}</p>` : ""}</div>
      <button type="button" class="btn quiet icon-only" data-close aria-label="Close">${icon("x")}</button></div>
    <div class="dialog-body">${body}</div></div>`;
  document.body.appendChild(back);
  document.body.style.overflow = "hidden";
  const dlg = $(".dialog", back);
  const close = () => { back.remove(); if (!$(".dialog-back, .drawer")) document.body.style.overflow = ""; opener?.focus?.(); };
  $$("[data-close]", back).forEach(b => b.addEventListener("click", close));
  back.addEventListener("mousedown", e => { if (e.target === back) close(); });
  trap(dlg, close);
  onMount?.(dlg, close);
  const f = (initialFocus && $(initialFocus, dlg)) || $$(FOCUSABLE, $(".dialog-body", dlg))[0] || dlg;
  f.focus();
  return close;
}

export function openDrawer({ title, sub = "", body, onMount, onClose }) {
  $(".drawer")?.dispatchEvent(new Event("drawer-close"));
  const opener = document.activeElement;
  const back = document.createElement("div"); back.className = "drawer-back";
  const d = document.createElement("aside");
  const tid = `drw${++uid}`;
  d.className = "drawer"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.setAttribute("aria-labelledby", tid); d.tabIndex = -1;
  d.innerHTML = `<div class="drawer-head"><div>${sub ? `<div class="eyebrow">${sub}</div>` : ""}<h2 id="${tid}">${esc(title)}</h2></div>
    <button type="button" class="btn quiet icon-only" data-close aria-label="Close details">${icon("x")}</button></div>
    <div class="drawer-body">${body}</div>`;
  document.body.append(back, d);
  const close = (refocus = true) => { back.remove(); d.remove(); onClose?.(); if (refocus) opener?.focus?.(); };
  d.addEventListener("drawer-close", () => close(false));
  back.addEventListener("click", () => close());
  $("[data-close]", d).addEventListener("click", () => close());
  trap(d, () => close());
  onMount?.(d, close);
  $("[data-close]", d).focus();
  return close;
}
