// The Bench: interactive instruments for the workbench. Geometry is display only;
// every quantity drawn or labelled comes from the engine's response.
import { esc, g3 } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------------ tilt */
// unaccounted: issued side (left) heavier, beam dips left (negative). surplus: dips right.
export function tiltFor(verdict, rawG, refG = 100) {
  if (verdict === "balanced" || !rawG) return 0;
  const mag = clamp(4 + Math.log10(1 + Math.abs(rawG) / Math.max(refG, 1e-9) * 1000) * 3.2, 4, 15);
  return rawG > 0 ? -mag : mag;
}
export function tiltForJob(j) {
  if (j.verdict === "balanced" || j.verdict === "error") return 0;
  const mag = clamp(5 + Math.log10(1 + Math.abs(+j.excess_g) * 10) * 5, 5, 18);
  return +j.excess_g > 0 ? -mag : mag;
}

/* ------------------------------------------------------------ mini balance */
export function miniBalance(angle, cls = "") {
  const r = angle * Math.PI / 180, P = { x: 60, y: 14 }, A = 42;
  const L = { x: P.x - A * Math.cos(r), y: P.y - A * Math.sin(r) }, R = { x: P.x + A * Math.cos(r), y: P.y + A * Math.sin(r) };
  const pan = p => `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"><line x1="0" y1="0" x2="-10" y2="22"/><line x1="0" y1="0" x2="10" y2="22"/><path d="M-14 22 Q0 31 14 22 Z"/></g>`;
  return `<svg class="mini-bal ${cls}" viewBox="0 0 120 64" aria-hidden="true">
    <g class="mb-sway"><line class="mb-post" x1="60" y1="14" x2="60" y2="58"/><path class="mb-base" d="M46 60 Q60 54 74 60"/>
    <line class="mb-beam" x1="${L.x.toFixed(1)}" y1="${L.y.toFixed(1)}" x2="${R.x.toFixed(1)}" y2="${R.y.toFixed(1)}"/>${pan(L)}${pan(R)}<circle class="mb-piv" cx="60" cy="14" r="2.6"/></g></svg>`;
}

/* --------------------------------------------------------------- spectrum */
// signed symmetric-log axis: unaccounted to the left of zero, surplus to the right.
export const SPEC = { W: 1000, H: 140, cx: 500, half: 440, y: 78 };
/** Narrow screens get a narrower drawing so marks and labels stay legible. */
export function fitSpectrum(px) {
  const W = px < 640 ? 440 : 1000;
  Object.assign(SPEC, { W, cx: W / 2, half: W / 2 - (W < 600 ? 30 : 60), H: W < 600 ? 150 : 140 });
}
export function specX(excessG, maxAbs) {
  const k = 100, m = Math.log10(1 + Math.max(maxAbs, 0.01) * k);
  const v = Math.log10(1 + Math.abs(excessG) * k) / m;
  return SPEC.cx - Math.sign(excessG) * v * SPEC.half;
}
export function spectrumSVG(jobs, { brush = null, catOf, label }) {
  const maxAbs = Math.max(0.05, ...jobs.map(j => Math.abs(+j.excess_g || 0)));
  const ticks = (SPEC.W < 600 ? [0.1, 10] : [0.01, 0.1, 1, 10, 100]).filter(v => v <= maxAbs * 1.01);
  const pos = jobs.map(j => ({ j, x: j.verdict === "balanced" ? SPEC.cx : specX(+j.excess_g, maxAbs) }));
  // beeswarm: stack marks that would overlap
  const placed = [];
  pos.sort((a, b) => a.x - b.x).forEach(p => {
    let lvl = 0;
    while (placed.some(q => Math.abs(q.x - p.x) < 20 && q.lvl === lvl)) lvl++;
    p.lvl = lvl; placed.push(p);
  });
  const inBrush = x => !brush || (x >= brush[0] && x <= brush[1]);
  const tick = (v, s) => { const x = specX(s * v, maxAbs); return `<line class="sp-tick" x1="${x}" x2="${x}" y1="${SPEC.y - 4}" y2="${SPEC.y + 4}"/><text class="sp-tl" x="${x}" y="${SPEC.y + 22}">${v} g</text>`; };
  return `<svg class="spectrum-svg" id="specSvg" viewBox="0 0 ${SPEC.W} ${SPEC.H}" role="group" aria-label="Difference spectrum: each job placed by its fine-metal difference. Drag across the line to filter the list.">
    <defs><linearGradient id="spGrad" x1="0" x2="1"><stop offset="0" stop-color="var(--attention)" stop-opacity=".55"/><stop offset=".47" stop-color="var(--attention)" stop-opacity="0"/><stop offset=".53" stop-color="var(--info)" stop-opacity="0"/><stop offset="1" stop-color="var(--info)" stop-opacity=".55"/></linearGradient></defs>
    <rect class="sp-hit" x="0" y="0" width="${SPEC.W}" height="${SPEC.H}"/>
    <line class="sp-axis" x1="${SPEC.cx - SPEC.half}" x2="${SPEC.cx + SPEC.half}" y1="${SPEC.y}" y2="${SPEC.y}" stroke="url(#spGrad)"/>
    <rect class="sp-band" x="${SPEC.cx - 14}" y="${SPEC.y - 34}" width="28" height="44" rx="6"/>
    <text class="sp-cap" x="${SPEC.cx}" y="${SPEC.y + 40}">within tolerance</text>
    <text class="sp-side" x="${SPEC.cx - SPEC.half}" y="${SPEC.H - 6}" text-anchor="start">← ${SPEC.W < 600 ? "unaccounted" : "fine metal unaccounted"}</text>
    <text class="sp-side" x="${SPEC.cx + SPEC.half}" y="${SPEC.H - 6}" text-anchor="end">${SPEC.W < 600 ? "surplus" : "returned beyond issue"} →</text>
    ${ticks.map(v => tick(v, 1) + tick(v, -1)).join("")}
    <rect class="sp-brush" id="spBrush" x="${brush ? brush[0] : 0}" y="8" width="${brush ? brush[1] - brush[0] : 0}" height="${SPEC.H - 30}" rx="6" ${brush ? "" : 'visibility="hidden"'}/>
    ${placed.map((p, k) => {
      const cat = catOf(p.j), cy = SPEC.y - 16 - p.lvl * 18;
      return `<a class="sp-mk cat-${cat} ${inBrush(p.x) ? "" : "out"}" href="#job/${esc(p.j.job_id)}" style="--i:${k}" aria-label="${esc(p.j.title)}: ${esc(label(p.j))}">
        <line class="sp-stem" x1="${p.x}" x2="${p.x}" y1="${cy + 7}" y2="${SPEC.y}"/>
        <circle cx="${p.x}" cy="${cy}" r="7"/>${p.j.settlement === "final" ? `<path class="sp-ok" d="M${p.x - 3} ${cy} l2 2.4 4-4.6"/>` : ""}
        <title>${esc(p.j.title)} — ${esc(label(p.j))}</title></a>`;
    }).join("")}
  </svg>`;
}

/* ------------------------------------------------------------ big balance */
const OUT = { RETURN_FINISHED: "finished", RETURN_SCRAP: "scrap", WIP_HOLD: "wip", TRANSFER: "transfer" };
const KIND_LABEL = { issue: "Issued", alloy: "Alloy added", finished: "Finished pieces", scrap: "Scrap & sweepings", wip: "Work in progress", transfer: "Transferred", deduct: "Stones deducted" };

export class Bench {
  constructor(host, { onPick } = {}) {
    this.host = host; this.onPick = onPick;
    this.a = 0; this.v = 0; this.target = 0; this.raf = 0; this.preview = null;
    this.P = { x: 380, y: 64 }; this.ARM = 250;
  }
  render(rep, { replay = false, selected = "" } = {}) {
    this.rep = rep; this.replay = replay;
    const b = rep.balance, fin = +b.fine_in_g, fout = +b.fine_out_g, fded = +b.fine_deduct_g, raw = +b.raw_g;
    const left = [], right = [];
    for (const e of rep.events) {
      if (e.parent_event_id || e.effective?.voided) continue;
      const g = Math.abs(+(e.effective?.fine_g ?? 0)); if (!g) continue;
      const item = { ev: e.event_id, label: e.label, fine: e.effective.fine_g, g };
      if (e.event_type === "ISSUE") left.push({ ...item, kind: "issue" });
      else if (e.event_type === "ALLOY_ADD") left.push({ ...item, kind: "alloy" });
      else if (OUT[e.event_type]) right.push({ ...item, kind: OUT[e.event_type] });
      else if (e.event_type === "STONE_SET") right.push({ ...item, kind: "deduct" });
    }
    const MAXH = 132, total = Math.max(fin, fout + fded, 1e-9), hs = MAXH / total;
    const stack = (items, ghost) => {
      let y = 0, out = "";
      items.forEach((it, k) => {
        const h = Math.max(it.g * hs, 5);
        y += h;
        out += `<g class="blk k-${it.kind}${selected === it.ev ? " sel" : ""}" data-ev="${esc(it.ev)}" ${replay ? "" : `tabindex="0" role="button"`} aria-label="${esc(it.label)}: ${esc(it.fine)} g fine" style="--i:${k}">
          <rect x="-58" y="${-y}" width="116" height="${h - 1.5}" rx="3"/>${h > 34
          ? `<text x="0" y="${-y + h / 2 - 3}">${esc(it.label.length > 17 ? it.label.slice(0, 16) + "…" : it.label)}</text><text class="blk-g" x="0" y="${-y + h / 2 + 11}">${esc(g3(it.fine))} g</text>`
          : h > 15 ? `<text x="0" y="${-y + h / 2 + 4}">${esc(g3(it.fine))} g</text>` : ""}<title>${esc(KIND_LABEL[it.kind])} · ${esc(it.label)}: ${esc(it.fine)} g fine</title></g>`;
      });
      if (ghost) {
        const h = Math.max(ghost.g * hs, 14);
        out += `<g class="ghost ${ghost.cls}" id="ghost"><rect x="-58" y="${-y - h}" width="116" height="${h}" rx="3"/><text class="ghost-t" x="0" y="${-y - h - 8}">${esc(ghost.text)}</text></g>`;
      }
      return out;
    };
    const ghostR = b.verdict !== "balanced" && raw > 0 ? { g: raw, cls: "g-un", text: `${b.raw_g} g not accounted for` } : null;
    const ghostL = b.verdict !== "balanced" && raw < 0 ? { g: -raw, cls: "g-sur", text: `${g3(-raw)} g returned beyond issue` } : null;
    this.host.innerHTML = `<svg class="bench-svg" viewBox="0 0 760 380" role="img" aria-label="${esc(this.sentence(b))}">
      <defs><pattern id="ghHatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" class="gh-line"/></pattern></defs>
      <g class="bench-dial"><path d="M250 330 A130 130 0 0 1 510 330" class="dial-arc"/>${Array.from({ length: 13 }, (_, k) => { const th = Math.PI + k / 12 * Math.PI, r1 = 130, r2 = k % 3 ? 123 : 116; return `<line class="dial-tick" x1="${380 + r1 * Math.cos(th)}" y1="${330 + r1 * Math.sin(th)}" x2="${380 + r2 * Math.cos(th)}" y2="${330 + r2 * Math.sin(th)}"/>`; }).join("")}
        <line id="bNeedle" class="needle" x1="380" y1="330" x2="380" y2="220"/></g>
      <line class="post" x1="380" y1="64" x2="380" y2="352"/><path class="base" d="M318 360 Q380 340 442 360"/>
      <g id="bBeam"><line class="beam" x1="130" y1="64" x2="630" y2="64"/><circle class="end" cx="130" cy="64" r="4"/><circle class="end" cx="630" cy="64" r="4"/></g>
      <circle class="pivot" cx="380" cy="64" r="7"/>
      <g id="bPanL" class="bpan"><line class="str" x1="0" y1="0" x2="-70" y2="190"/><line class="str" x1="0" y1="0" x2="70" y2="190"/><g transform="translate(0 188)">${stack(left, ghostL)}</g><path class="bowl" d="M-86 190 Q0 222 86 190 Z"/>
        <text class="pan-cap" x="0" y="246">Issued · ${esc(b.fine_in_g)} g fine</text></g>
      <g id="bPanR" class="bpan"><line class="str" x1="0" y1="0" x2="-70" y2="190"/><line class="str" x1="0" y1="0" x2="70" y2="190"/><g transform="translate(0 188)">${stack(right, ghostR)}</g><path class="bowl" d="M-86 190 Q0 222 86 190 Z"/>
        <text class="pan-cap" x="0" y="246">Accounted · ${esc(b.fine_out_g)} g${fded ? ` + ${esc(b.fine_deduct_g)} g deducted` : ""}</text></g>
    </svg>`;
    this.svg = this.host.firstElementChild;
    this.refG = fin;
    this.base = tiltFor(b.verdict, raw, fin);
    this.target = this.preview ? 0 : this.base;
    if (!replay) this.host.querySelectorAll(".blk").forEach(g => {
      const pick = () => this.onPick?.(g.dataset.ev);
      g.addEventListener("click", pick);
      g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    });
    if (this.preview) this.applyPreviewLabel();
    if (reduced()) { this.a = this.target; this.place(); } else this.kick();
  }
  sentence(b) {
    if (b.verdict === "balanced") return `Balance level: issued ${b.fine_in_g} g fine, accounted ${b.fine_out_g} g. Within tolerance.`;
    if (+b.raw_g > 0) return `Balance dips to the issued side: ${b.raw_g} g of fine metal is not accounted for.`;
    return `Balance dips to the returned side: ${g3(-b.raw_g)} g more fine metal was returned than issued.`;
  }
  highlight(eid) {
    this.host.querySelectorAll(".blk").forEach(g => { g.classList.toggle("sel", g.dataset.ev === eid); g.classList.toggle("dim", !!eid && g.dataset.ev !== eid); });
  }
  /** Preview an explanation: illustrative only, the ghost fills and the beam levels. */
  setPreview(title) {
    this.preview = title || null;
    this.target = this.preview ? 0 : this.base;
    this.host.classList.toggle("previewing", !!this.preview);
    this.applyPreviewLabel();
    if (reduced()) { this.a = this.target; this.place(); } else this.kick();
  }
  applyPreviewLabel() {
    const t = this.host.querySelector(".ghost-t"); if (!t) return;
    const g = this.host.querySelector("#ghost");
    if (!t.dataset.orig) t.dataset.orig = t.textContent;
    t.textContent = this.preview ? `If: ${this.preview.length > 34 ? this.preview.slice(0, 33) + "…" : this.preview}` : t.dataset.orig;
    g?.classList.toggle("filled", !!this.preview);
  }
  place() {
    const r = this.a * Math.PI / 180, { x, y } = this.P, A = this.ARM;
    const s = this.svg; if (!s) return;
    s.querySelector("#bBeam").setAttribute("transform", `rotate(${this.a} ${x} ${y})`);
    s.querySelector("#bPanL").setAttribute("transform", `translate(${x - A * Math.cos(r)} ${y - A * Math.sin(r)})`);
    s.querySelector("#bPanR").setAttribute("transform", `translate(${x + A * Math.cos(r)} ${y + A * Math.sin(r)})`);
    s.querySelector("#bNeedle").setAttribute("transform", `rotate(${this.a * 3.2} 380 330)`);
  }
  kick() {
    cancelAnimationFrame(this.raf);
    let t0 = performance.now();
    const step = now => {
      const dt = Math.min(2.5, (now - t0) / 16.7 || 1); t0 = now;
      this.v = (this.v + (this.target - this.a) * .05 * dt) * Math.pow(.86, dt);
      this.a += this.v * dt;
      this.place();
      if (Math.abs(this.target - this.a) > .01 || Math.abs(this.v) > .01) this.raf = requestAnimationFrame(step);
      else { this.a = this.target; this.place(); }
    };
    if (!this.started) { this.a = this.target * 0 + (this.target ? 0 : -6); this.started = true; }
    this.raf = requestAnimationFrame(step);
  }
}
