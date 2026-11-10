// Landing stage: a live line-art balance, the name, one line in three languages, two doors.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const NS = "http://www.w3.org/2000/svg";

/* ---------------------------------------------------------------- atmosphere: slow brass motes */
const fx = (() => {
  const c = $("#fx"), ctx = c.getContext("2d");
  let W = 0, H = 0, dpr = 1, motes = [], sparks = [];
  const mouse = { x: -1e4, y: -1e4 };
  const sprite = document.createElement("canvas"); sprite.width = sprite.height = 48;
  { const s = sprite.getContext("2d"), g = s.createRadialGradient(24, 24, 0, 24, 24, 24);
    g.addColorStop(0, "rgba(246,226,176,1)"); g.addColorStop(.25, "rgba(201,164,92,.7)"); g.addColorStop(1, "rgba(201,164,92,0)");
    s.fillStyle = g; s.fillRect(0, 0, 48, 48); }
  const mote = any => ({ x: Math.random() * W, y: any ? Math.random() * H : H + 10, r: (Math.random() ** 2 * 2 + .5) * dpr,
    vy: -(.08 + Math.random() * .25) * dpr, vx: (Math.random() - .5) * .08 * dpr, tw: Math.random() * 6.3, d: .35 + Math.random() * .65 });
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2); W = c.width = innerWidth * dpr; H = c.height = innerHeight * dpr;
    motes = Array.from({ length: Math.round(Math.min(90, innerWidth * innerHeight / 16000)) }, () => mote(true));
  }
  addEventListener("resize", resize); resize();
  addEventListener("pointermove", e => { mouse.x = e.clientX * dpr; mouse.y = e.clientY * dpr; });
  function burst(x, y, n = 22) {
    for (let i = 0; i < n; i++) { const a = Math.random() * 6.283, v = (1 + Math.random() * 3) * dpr;
      sparks.push({ x: x * dpr, y: y * dpr, vx: Math.cos(a) * v, vy: Math.sin(a) * v - dpr, life: 1, r: (1 + Math.random() * 1.6) * dpr }); }
  }
  function tick() {
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    for (const p of motes) {
      p.tw += .02;
      const dx = p.x - mouse.x, dy = p.y - mouse.y, d2 = dx * dx + dy * dy, R = 130 * dpr;
      if (d2 < R * R) { const d = Math.sqrt(d2) + 1, f = (1 - d / R) * .25; p.vx += dx / d * f; p.vy += dy / d * f; }
      p.vx *= .97; p.vy = p.vy * .97 + (-.16 * dpr * p.d) * .03; p.x += p.vx; p.y += p.vy;
      if (p.y < -10 || p.x < -20 || p.x > W + 20) Object.assign(p, mote(false));
      const s = p.r * 7; ctx.globalAlpha = (.25 + .45 * (.5 + .5 * Math.sin(p.tw))) * p.d;
      ctx.drawImage(sprite, p.x - s / 2, p.y - s / 2, s, s);
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]; s.vy += .06 * dpr; s.x += s.vx; s.y += s.vy; s.life -= .022;
      if (s.life <= 0) { sparks.splice(i, 1); continue; }
      const z = s.r * 7 * s.life; ctx.globalAlpha = s.life; ctx.drawImage(sprite, s.x - z / 2, s.y - z / 2, z, z);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    if (!reduced || sparks.length) requestAnimationFrame(tick);
  }
  tick();
  return { burst: (x, y, n) => { fx.burstRaw(x, y, n); }, burstRaw: burst, kick: () => { if (reduced) requestAnimationFrame(tick); } };
})();

/* ---------------------------------------------------------------- cursor glow, magnetic doors, ruler */
const glow = $("#glow"), rulerMark = $("#rulerMark"), ruler = $("#ruler");
addEventListener("pointermove", e => {
  glow.style.setProperty("--mx", `${e.clientX}px`); glow.style.setProperty("--my", `${e.clientY}px`);
  rulerMark.style.left = `${(e.clientX / innerWidth) * 100}%`;
});
$$(".cta .btn").forEach(b => {
  b.classList.add("magnetic");
  b.addEventListener("pointermove", e => {
    if (e.pointerType !== "mouse" || reduced) return;
    const r = b.getBoundingClientRect();
    b.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * .15}px, ${(e.clientY - r.top - r.height / 2) * .25}px)`;
  });
  b.addEventListener("pointerleave", () => { b.style.transform = ""; });
});

/* ---------------------------------------------------------------- title + rotating line */
{
  const t = $("#heroTitle"), word = t.textContent; t.textContent = "";
  [...word].forEach((ch, i) => { const s = document.createElement("span"); s.className = "ch"; s.style.setProperty("--i", i); s.textContent = ch; s.setAttribute("aria-hidden", "true"); t.appendChild(s); });
}
{
  // Hindi and Punjabi renderings of the tagline: please have a native speaker review.
  const LINES = [
    ["A difference in weight shouldn’t become a difference in trust.", ""],
    ["वज़न का फ़र्क़ भरोसे का फ़र्क़ न बने।", "hi"],
    ["ਵਜ਼ਨ ਦਾ ਫ਼ਰਕ ਭਰੋਸੇ ਦਾ ਫ਼ਰਕ ਨਾ ਬਣੇ।", "pa"],
    ["Trace the records. Compare explanations. Check together.", ""],
  ];
  const tag = $("#tag"); let i = 0;
  if (!reduced) setInterval(() => {
    tag.classList.add("out");
    setTimeout(() => { i = (i + 1) % LINES.length; tag.textContent = LINES[i][0]; LINES[i][1] ? tag.setAttribute("lang", LINES[i][1]) : tag.removeAttribute("lang"); tag.classList.remove("out"); }, 460);
  }, 5200);
}

/* ---------------------------------------------------------------- the balance */
const svg = $(".scale-svg");
const PIV = { x: 220, y: 58 }, ARM = 150;
const beam = { a: reduced ? 0 : -10, v: 0 };
const loads = { L: 0, R: 0 };
let mouseBias = 0, lastTouch = 0;
// dial ticks
{
  const g = $("#ticks");
  for (let k = 0; k <= 18; k++) {
    const th = Math.PI + (k / 18) * Math.PI, major = k % 3 === 0;
    const r1 = 100, r2 = major ? 90 : 94;
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", 220 + r1 * Math.cos(th)); l.setAttribute("y1", 214 + r1 * Math.sin(th));
    l.setAttribute("x2", 220 + r2 * Math.cos(th)); l.setAttribute("y2", 214 + r2 * Math.sin(th));
    l.setAttribute("class", `tick${major ? " major" : ""}`); l.style.animationDelay = `${.5 + k * .03}s`;
    g.appendChild(l);
  }
}
addEventListener("pointermove", e => { if (e.pointerType === "mouse") mouseBias = ((e.clientX / innerWidth) - .5) * 5; });

function target() { return Math.max(-16, Math.min(16, (loads.R - loads.L) * 4.2)) + mouseBias; }
function stateText() {
  const st = $("#scaleState");
  st.classList.remove("even", "off");
  if (!loads.L && !loads.R) { st.textContent = "Tap a pan"; return; }
  if (loads.L === loads.R) { st.textContent = "Balanced"; st.classList.add("even"); return; }
  st.textContent = loads.L > loads.R ? "Issued side heavier" : "Returned side heavier"; st.classList.add("off");
}
function place(side) {
  if (loads[side] >= 5) return;
  const g = $(side === "L" ? "#loadL" : "#loadR"), k = loads[side]++;
  const r = document.createElementNS(NS, "rect");
  const w = 22 - k * 3;
  r.setAttribute("x", -w / 2); r.setAttribute("y", 91 - (k + 1) * 6.5); r.setAttribute("width", w); r.setAttribute("height", 6); r.setAttribute("rx", 1.5);
  r.setAttribute("class", "weight drop"); g.appendChild(r);
  beam.v += (side === "L" ? -1 : 1) * 1.4;
  lastTouch = performance.now();
  stateText();
  if (loads.L === loads.R) celebrate();
}
function celebrate() {
  const sheen = $("#sheen");
  sheen.style.opacity = "1";
  sheen.animate([{ transform: "translateX(0)" }, { transform: "translateX(280px)" }], { duration: 900, easing: "ease-in-out" }).onfinish = () => { sheen.style.opacity = "0"; };
  const ctm = svg.getScreenCTM(); if (!ctm) return;
  const pt = svg.createSVGPoint(); pt.x = PIV.x; pt.y = PIV.y; const s = pt.matrixTransform(ctm);
  fx.burstRaw(s.x, s.y, 26); fx.kick();
}
function clearLoads() {
  for (const id of ["#loadL", "#loadR"]) $$("rect", $(id)).forEach(r => r.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-12px)" }], { duration: 400, fill: "forwards" }));
  setTimeout(() => { $("#loadL").innerHTML = ""; $("#loadR").innerHTML = ""; loads.L = loads.R = 0; stateText(); }, 420);
}
$$(".pan-hit").forEach(h => h.addEventListener("click", () => place(h.dataset.pan)));
// keyboard: the instrument is focusable; arrows place weights, Escape clears
const inst = $("#scale");
inst.tabIndex = 0;
inst.setAttribute("aria-label", "A goldsmith's balance. Press the left or right arrow key, or tap a pan, to place a weight. Escape clears.");
inst.addEventListener("keydown", e => {
  if (e.key === "ArrowLeft") { e.preventDefault(); place("L"); }
  else if (e.key === "ArrowRight") { e.preventDefault(); place("R"); }
  else if (e.key === "Escape") clearLoads();
});

let t0 = performance.now();
(function frame(now) {
  const dt = Math.min(2.5, (now - t0) / 16.7 || 1); t0 = now;
  if ((loads.L || loads.R) && now - lastTouch > 9000) { lastTouch = now; clearLoads(); }
  const sway = reduced ? 0 : Math.sin(now / 1700) * .35;
  beam.v = (beam.v + (target() + sway - beam.a) * .028 * dt) * Math.pow(.9, dt);
  beam.a += beam.v * dt;
  const r = beam.a * Math.PI / 180;
  $("#beam").setAttribute("transform", `rotate(${beam.a} ${PIV.x} ${PIV.y})`);
  for (const [id, side, lbl] of [["#panL", -1, "#lblL"], ["#panR", 1, "#lblR"]]) {
    const x = PIV.x + side * ARM * Math.cos(r), y = PIV.y + side * ARM * Math.sin(r);
    $(id).setAttribute("transform", `translate(${x} ${y})`);
    $(lbl).setAttribute("x", x); $(lbl).setAttribute("y", y + 136);
  }
  $("#needle").setAttribute("transform", `rotate(${beam.a * 3} 220 214)`);
  if (!matchMedia("(pointer: fine)").matches) rulerMark.style.left = `${50 + beam.a * 2.5}%`;
  requestAnimationFrame(frame);
})(t0);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
