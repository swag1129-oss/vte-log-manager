(function (root) {
  "use strict";
  const KP = "vte.chamber.vac", KT = "vte.chamber.temp";
  const DEF_P = 1e-6, DEF_T = 40;
  const SRC = Array.from({length: 9}, (_, i) => `O-${i + 1}`);
  const numLS = (k, d) => { const v = Number(localStorage.getItem(k)); return Number.isFinite(v) && v > 0 ? v : d; };
  const limP = () => numLS(KP, DEF_P), limT = () => numLS(KT, DEF_T);
  const fmtP = p => { if (!(p > 0)) return "–"; const e = Math.floor(Math.log10(p)); let m = p / 10 ** e; if (Math.round(m * 10) / 10 >= 10) return `1.0×10${sup(e + 1)}`; return `${m.toFixed(1)}×10${sup(e)}`; };
  const sup = n => String(n).replace(/-/g, "⁻").replace(/\d/g, d => "⁰¹²³⁴⁵⁶⁷⁸⁹"[d]);
  // temp hist: {src: [[tsSec, pv]]}; pres hist: [[tsSec, torr]]
  const H = {temps: {}, pres: []}, WIN_T = 600, WIN_P = 1800;
  const push = (arr, ts, v, win) => { if (!arr.length || ts > arr[arr.length - 1][0]) arr.push([ts, v]); while (arr.length && arr[0][0] < ts - win - 60) arr.shift(); };
  function slope(pts, win) { // least squares dy/dt per minute over last win sec
    const n = pts.length; if (n < 3) return null;
    const t1 = pts[n - 1][0], p = pts.filter(q => q[0] >= t1 - win);
    if (p.length < 3 || p[p.length - 1][0] - p[0][0] < Math.min(win * 0.3, 20)) return null;
    const mt = p.reduce((a, q) => a + q[0], 0) / p.length, my = p.reduce((a, q) => a + q[1], 0) / p.length;
    let sxy = 0, sxx = 0; for (const q of p) { sxy += (q[0] - mt) * (q[1] - my); sxx += (q[0] - mt) ** 2; }
    return sxx ? sxy / sxx * 60 : null;
  }
  function trend(pts) { const s = slope(pts, WIN_T); if (s === null) return "→"; return s > 1 ? "↑" : s < -1 ? "↓" : "→"; }
  // Newton cooling toward ambient: T-Ta = A e^{-t/tau}; fit ln(T-Ta) linear over last 10 min. Returns minutes until T<=lim or null.
  function etaCool(pts, lim, amb = 22) {
    const q = pts.filter(r => r[1] - amb > 3).map(r => [r[0], Math.log(r[1] - amb)]);
    const cur = pts.length ? pts[pts.length - 1][1] : null;
    if (cur === null || cur <= lim) return 0;
    if (lim - amb <= 1) return null;
    const s = slope(q, WIN_T); // ln per min
    if (s === null || s > -0.003) return null;
    const y = q[q.length - 1][1];
    const m = (Math.log(lim - amb) - y) / s;
    return m > 0 && m < 1000 ? m : null;
  }
  function etaVac(pts, lim) {
    const q = pts.filter(r => r[1] > 0).map(r => [r[0], Math.log10(r[1])]);
    const cur = q.length ? q[q.length - 1][1] : null;
    if (cur === null) return null;
    if (cur <= Math.log10(lim)) return 0;
    const s = slope(q, 900); // decades per min
    if (s === null || s > -0.002) return null;
    const m = (Math.log10(lim) - cur) / s;
    return m > 0 && m < 1000 ? m : null;
  }
  const fmtMin = m => (m < 1 ? "1분 미만" : m < 90 ? `약 ${Math.round(m)}분` : `약 ${(m / 60).toFixed(1)}시간`);
  const $ = s => document.querySelector(s);
  let timer = null, seeded = false, mats = {}, busy = false, lastLive = null;

  function chart(canvas, pts, lim) {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const g = canvas.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
    if (pts.length < 2) return;
    const ls = pts.map(r => [r[0], Math.log10(r[1])]);
    const t1 = ls[ls.length - 1][0], t0 = t1 - WIN_P;
    let lo = Math.min(...ls.map(r => r[1]), Math.log10(lim)), hi = Math.max(...ls.map(r => r[1]), Math.log10(lim));
    lo = Math.floor(lo - 0.2); hi = Math.ceil(hi + 0.2);
    const X = t => 28 + (t - t0) / WIN_P * (w - 34), Y = v => 6 + (hi - v) / (hi - lo) * (h - 18);
    g.font = "10px sans-serif"; g.fillStyle = "#718096"; g.strokeStyle = "#e2e8f0"; g.lineWidth = 1;
    for (let d = lo; d <= hi; d++) { g.beginPath(); g.moveTo(28, Y(d)); g.lineTo(w - 6, Y(d)); g.stroke(); g.fillText(`1e${d}`, 0, Y(d) + 3); }
    g.setLineDash([4, 3]); g.strokeStyle = "#2f855a"; g.beginPath(); g.moveTo(28, Y(Math.log10(lim))); g.lineTo(w - 6, Y(Math.log10(lim))); g.stroke(); g.setLineDash([]);
    g.strokeStyle = "#2b6cb0"; g.lineWidth = 2; g.beginPath();
    ls.forEach((r, i) => { const x = X(Math.max(r[0], t0)), y = Y(r[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    g.fillStyle = "#718096"; g.fillText("-30분", 28, h - 2); g.fillText("지금", w - 28, h - 2);
  }

  function render() {
    const lp = lastLive, now = Date.now() / 1000;
    const P = lp && lp.pressure, vacCard = $("#chVac");
    const lv = limP(), lt = limT();
    if (!P || P.ok === false || !(Number(P.torr) > 0)) {
      vacCard.innerHTML = `<h2>진공도</h2><p class="hint">게이지 연결 대기</p>`;
    } else {
      const p = Number(P.torr), ok = p <= lv, stale = now - P.ts > 30;
      const e = etaVac(H.pres, lv);
      vacCard.innerHTML = `<h2>진공도</h2><div class="ch-big">${fmtP(p)} <small>Torr</small></div>
        <span class="ch-badge ${ok ? "ok" : "warn"}">${ok ? "증착 가능" : "펌핑 중"}</span>${stale ? ' <span class="hint">(데이터 지연)</span>' : ""}
        ${!ok && e ? `<p class="hint">기준 ${fmtP(lv)} 까지 ${fmtMin(e)}</p>` : `<p class="hint">기준 ${fmtP(lv)} Torr 이하</p>`}
        <canvas class="ch-canvas" id="chVacCanvas"></canvas>`;
      chart($("#chVacCanvas"), H.pres, lv);
    }
    const T = lp && lp.temps;
    const card = $("#chTemp");
    if (!T) { card.innerHTML = `<h2>소스 온도</h2><p class="hint">서버 연결 안 됨</p>`; return; }
    let hot = null, sum = "";
    const cells = SRC.map(s => {
      const r = T[s], v = r && r.ok !== false && Number.isFinite(Number(r.pv)) && now - r.ts < 60 ? Number(r.pv) : null;
      if (v !== null && (!hot || v > hot.v)) hot = {s, v};
      const cls = v === null ? "na" : v >= lt * 3 ? "hot" : v >= lt ? "warm" : "cool";
      return `<div class="ch-cell ${cls}"><b>${s}</b><span class="ch-v">${v === null ? "–" : Math.round(v)}<small>°C</small> ${v === null ? "" : trend(H.temps[s] || [])}</span><span class="ch-m">${mats[s] ? mats[s].replace(/</g, "&lt;") : ""}</span></div>`;
    }).join("");
    const warm = SRC.filter(s => { const r = T[s]; return r && r.ok !== false && Number(r.pv) >= lt; });
    if (!hot) sum = `<span class="ch-badge na">온도 데이터 없음</span>`;
    else if (!warm.length) sum = `<span class="ch-badge ok">챔버 열어도 됨</span> <span class="hint">전체 &lt; ${lt} °C</span>`;
    else {
      let mx = 0, ok = true;
      for (const s of warm) { const e = etaCool(H.temps[s] || [], lt); if (e === null) { ok = false; break; } mx = Math.max(mx, e); }
      sum = `<span class="ch-badge warn">냉각 중 · 최고 ${hot.s} ${Math.round(hot.v)} °C${ok ? ` · ${fmtMin(mx)}` : ""}</span>`;
    }
    card.innerHTML = `<h2>소스 온도</h2><div>${sum}</div><div class="ch-grid">${cells}</div><p class="hint">M-1~M-3 온도계 없음 · 기준 ${lt} °C</p>`;
  }

  async function poll() {
    if (busy || document.hidden) return; busy = true;
    try {
      const j = await VTEThick.getJson("/live", 4000);
      lastLive = j;
      if (j) {
        const t = j.temps || {};
        for (const s of SRC) if (t[s] && t[s].ok !== false && Number.isFinite(Number(t[s].pv))) push(H.temps[s] = H.temps[s] || [], t[s].ts, Number(t[s].pv), WIN_T);
        if (j.pressure && j.pressure.ok !== false && Number(j.pressure.torr) > 0) push(H.pres, j.pressure.ts, Number(j.pressure.torr), WIN_P);
      }
      render();
    } finally { busy = false; }
  }
  async function seed() {
    if (seeded || !VTEThick.enabled()) return; seeded = true;
    const to = Date.now(), from = to - WIN_T * 1000;
    await Promise.all(SRC.map(async s => {
      const rows = await VTEThick.getJson(`/temp_range?source=${s}&from=${Math.floor(from / 1000)}&to=${Math.ceil(to / 1000)}`, 8000);
      const arr = H.temps[s] = (H.temps[s] || []).slice();
      const old = ((rows && rows.rows) || []).filter(r => r.ok !== false && Number.isFinite(Number(r.pv))).filter((r, i) => i % 5 === 0).map(r => [r.ts, Number(r.pv)]);
      H.temps[s] = old.concat(arr.filter(r => !old.length || r[0] > old[old.length - 1][0]));
    }));
  }
  async function loadMats(getDraft) {
    mats = {};
    try {
      const d = await getDraft();
      for (const l of (d && d.layers) || []) { const m = /^O-\d$/.exec(String(l.port || "").trim().toUpperCase()); if (m && l.material && !mats[m[0]]) mats[m[0]] = String(l.material).split(":")[0]; }
    } catch (e) { /* ignore */ }
  }
  async function start(getDraft) {
    stop();
    await loadMats(getDraft);
    render();
    await seed();
    poll();
    timer = setInterval(poll, 2000);
  }
  function stop() { clearInterval(timer); timer = null; }
  document.addEventListener("visibilitychange", () => { if (timer && !document.hidden) poll(); });
  root.VTEChamber = {start, stop, limP, limT, KP, KT, DEF_P, DEF_T, fmtP, etaCool, etaVac, trend};
})(typeof globalThis !== "undefined" ? globalThis : this);
