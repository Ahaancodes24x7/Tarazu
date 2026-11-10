// Hand-written SVG charts. Text uses text tokens; colour carries identity only.
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const fmt = (x, d = 3) => (Math.abs(x) < 1e-12 ? 0 : x).toFixed(d);

/**
 * Gap chart: the unaccounted fine metal as an interval (gold bar + point) against
 * the agreed-wastage band. Balanced when the bar touches the band.
 */
export function drawGap(svg, b, { width = 600, height = 92 } = {}) {
  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const bandLo = +b.band_lo_g, bandHi = +b.band_hi_g;
  const rawLo = +b.residual_lo_g + bandHi, rawHi = +b.residual_hi_g + bandLo, raw = +b.raw_g;
  let lo = Math.min(0, rawLo, bandLo), hi = Math.max(0, rawHi, bandHi);
  let span = hi - lo;
  if (span < 0.01) { lo -= 0.005; hi += 0.005; span = hi - lo; }
  lo -= span * 0.18; hi += span * 0.18;
  const L = 16, R = width - 16, y = 46;
  const X = v => L + ((v - lo) / (hi - lo)) * (R - L);

  el("line", { x1: L, x2: R, y1: y, y2: y, stroke: "#DCDDD4", "stroke-width": 1 }, svg);
  // band
  const bw = Math.max(X(bandHi) - X(bandLo), 2);
  el("rect", { x: X(bandLo), y: y - 18, width: bw, height: 36, rx: 6, fill: "rgba(127,199,154,.14)", stroke: "rgba(127,199,154,.55)", "stroke-dasharray": "3 3" }, svg);
  const bl = el("text", { x: X(bandLo) + bw / 2, y: y + 32, "text-anchor": "middle", fill: "#59645E", "font-size": 11 }, svg);
  bl.textContent = bandHi > bandLo ? `agreed wastage ${fmt(bandLo)}–${fmt(bandHi)} g` : "agreed wastage 0 g";
  // zero
  el("line", { x1: X(0), x2: X(0), y1: 10, y2: y + 20, stroke: "#17231F", "stroke-dasharray": "2 3", "stroke-width": 1 }, svg);
  const z = el("text", { x: X(0), y: 9, "text-anchor": "middle", fill: "#17231F", "font-size": 11 }, svg);
  z.textContent = "0";
  // interval
  const color = b.verdict === "balanced" ? "#7fc79a" : b.verdict === "surplus" ? "#7fb2e5" : "#e7b65a";
  // keep a narrow interval visible: never thinner than 14px, centred on its true midpoint
  let ix = X(rawLo), iw = X(rawHi) - X(rawLo);
  if (iw < 14) { ix -= (14 - iw) / 2; iw = 14; }
  const bar = el("rect", { x: ix, y: y - 7, width: iw, height: 14, rx: 7, fill: color, opacity: .9 }, svg);
  bar.style.transition = "all .5s";
  el("circle", { cx: X(raw), cy: y, r: 3, fill: "#FFFEFA" }, svg);
  const t1 = el("text", { x: Math.min(Math.max(ix + iw / 2, 60), width - 60), y: y - 14, "text-anchor": "middle", fill: "#17231F", "font-size": 12, "font-family": "IBM Plex Mono, monospace" }, svg);
  t1.textContent = `[${fmt(rawLo)}, ${fmt(rawHi)}] g`;
  const title = el("title", {}, svg);
  title.textContent = `Gap ${fmt(raw)} g fine, interval ${fmt(rawLo)} to ${fmt(rawHi)} g; agreed wastage ${fmt(bandLo)} to ${fmt(bandHi)} g`;
}

/**
 * Line chart with crosshair tooltip. series: [{name, color, values:[0..1], dash}]
 * xs: category labels. Direct labels at line ends (<=4 series) plus a legend.
 */
export function drawLines(svg, { xs, series, yLabel = "", width = 640, height = 280, tip, legend }) {
  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const L = 52, R = width - 120, T = 16, B = height - 40;
  const X = i => L + (i / (xs.length - 1)) * (R - L);
  const Y = v => B - v * (B - T);
  for (const g of [0, .25, .5, .75, 1]) {
    el("line", { x1: L, x2: R, y1: Y(g), y2: Y(g), stroke: "#DCDDD4" }, svg);
    const t = el("text", { x: L - 8, y: Y(g) + 4, "text-anchor": "end", fill: "#59645E", "font-size": 11 }, svg);
    t.textContent = `${Math.round(g * 100)}%`;
  }
  xs.forEach((x, i) => {
    const t = el("text", { x: X(i), y: B + 18, "text-anchor": "middle", fill: "#59645E", "font-size": 11 }, svg);
    t.textContent = x;
  });
  const xl = el("text", { x: (L + R) / 2, y: height - 4, "text-anchor": "middle", fill: "#59645E", "font-size": 11 }, svg);
  xl.textContent = yLabel;
  const ends = [];
  series.forEach(s => {
    const d = s.values.map((v, i) => `${i ? "L" : "M"}${X(i)},${Y(v)}`).join(" ");
    el("path", s.dash ? { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-dasharray": s.dash, "stroke-linejoin": "round", class: "fade-line" }
      : { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", pathLength: 1, class: "draw-line" }, svg);
    s.values.forEach((v, i) => el("circle", { cx: X(i), cy: Y(v), r: 4, fill: s.color, stroke: "#FFFEFA", "stroke-width": 2 }, svg));
    ends.push({ s, y: Y(s.values[s.values.length - 1]) });
  });
  // direct labels, nudged apart
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  ends.forEach(e => {
    const t = el("text", { x: R + 10, y: e.y + 4, fill: "#17231F", "font-size": 12 }, svg);
    t.textContent = e.s.name;
  });
  if (legend) legend.innerHTML = series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("");
  // hover layer
  const cross = el("line", { x1: 0, x2: 0, y1: T, y2: B, stroke: "#17231F", "stroke-dasharray": "2 3", opacity: 0 }, svg);
  const hit = el("rect", { x: L - 20, y: T, width: R - L + 40, height: B - T, fill: "transparent" }, svg);
  const show = (evt) => {
    const pt = svg.createSVGPoint();
    const src = evt.touches ? evt.touches[0] : evt;
    pt.x = src.clientX; pt.y = src.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    const i = Math.max(0, Math.min(xs.length - 1, Math.round(((p.x - L) / (R - L)) * (xs.length - 1))));
    cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("opacity", 1);
    if (tip) {
      tip.hidden = false;
      tip.innerHTML = `<b>${xs[i]}</b><br>` + series.map(s => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:6px"></span>${s.name}: ${Math.round(s.values[i] * 100)}%${s.counts ? ` <span style="color:#59645E">(${s.counts[i]})</span>` : ""}`).join("<br>");
      const box = svg.getBoundingClientRect(), host = tip.offsetParent ? tip.offsetParent.getBoundingClientRect() : box;
      const sx = box.left - host.left + (X(i) / width) * box.width;
      tip.style.left = `${Math.min(sx + 14, box.right - host.left - 170)}px`;
      tip.style.top = `${box.top - host.top + 20}px`;
    }
  };
  hit.addEventListener("mousemove", show);
  hit.addEventListener("touchstart", show, { passive: true });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("opacity", 0); if (tip) tip.hidden = true; });
}

/** Horizontal grouped bars: rows [{label, values:[...]}], series [{name,color}] */
export function drawBars(svg, { rows, series, width = 640, rowH = 46, max, unit = "", tip, legend }) {
  const height = rows.length * rowH + 24;
  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const L = Math.min(150, width * 0.3), R = width - 60;
  const m = max || Math.max(...rows.flatMap(r => r.values), 1e-9);
  const bh = Math.min(12, (rowH - 14) / series.length - 2);
  rows.forEach((r, ri) => {
    const y0 = ri * rowH + 10;
    const lt = el("text", { x: L - 10, y: y0 + rowH / 2 - 2, "text-anchor": "end", fill: "#17231F", "font-size": 12 }, svg);
    lt.textContent = r.label;
    series.forEach((s, si) => {
      const v = r.values[si];
      const y = y0 + si * (bh + 2);
      const w = Math.max(((v || 0) / m) * (R - L), 2);
      const rect = el("rect", { x: L, y, width: w, height: bh, rx: 4, fill: s.color, class: "grow-bar", style: `--i:${ri * series.length + si}` }, svg);
      const vt = el("text", { x: L + w + 6, y: y + bh - 2, fill: "#17231F", "font-size": 12, "font-family": "IBM Plex Mono, monospace" }, svg);
      vt.textContent = v == null ? "–" : `${v}${unit}`;
      const tt = el("title", {}, rect);
      tt.textContent = `${r.label} · ${s.name}: ${v}${unit}`;
    });
  });
  if (legend) legend.innerHTML = series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("");
}
