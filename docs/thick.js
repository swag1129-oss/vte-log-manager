/* Thickness-monitor server client (Telemark loggers on the evaporator PC). All calls fail soft: no server means manual entry only. */
(function (root) {
  "use strict";
  const Core = root.VTECore || (typeof require === "function" ? require("../core/vte-core.js") : null);
  const KEY = "vte.thickUrl";
  const SENSORS = ["A", "B", "C", "D"];
  const DEFAULT_URL = "https://thermalevaporator.tail95c053.ts.net";
  const url = () => (localStorage.getItem(KEY) || DEFAULT_URL).trim().replace(/\/+$/, "");
  const enabled = () => Boolean(url());

  async function getJson(path, ms = 3500) {
    const base = url();
    if (!base) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(base + path, {signal: ac.signal, cache: "no-store"});
      return r.ok ? await r.json() : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  const live = async () => (await getJson("/live"))?.ports || null;
  async function range(port, fromMs, toMs) {
    const j = await getJson(`/range?port=${encodeURIComponent(port)}&from=${Math.floor(fromMs / 1000)}&to=${Math.ceil(toMs / 1000)}`, 8000);
    return j ? (j.rows || []) : null;
  }
  const num = v => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
  // Values for the form: thickness (5 s median) in nm, rate_fit (10 s slope of it) in Å/s, power in %. Raw RS232 `rate` is never used for autofill.
  async function snapshot(port) {
    const p = (await live())?.[port];
    if (!p || !p.ok) return null;
    // Port D power is a manual knob (always 0 on the wire): never autofill it.
    return {thk: num(p.thk_med ?? p.thk_nm), rate: num(p.rate_fit), power: port === "D" ? null : num(p.power)};
  }

  const fmtNum = (v, d) => (v === null || v === undefined ? "" : String(Math.round(v * 10 ** d) / 10 ** d));
  const hms = ms => new Date(ms).toTimeString().slice(0, 8);

  // ---------- chart ----------
  const PANELS = [
    {key: "thk_med", label: "두께", unit: "nm", color: "#2b6cb0", slope: true, zero: 0.3},
    {key: "rate_fit", label: "레이트", unit: "Å/s", color: "#c05621", dots: "rate", zero: 1},
    {key: "power", label: "파워", unit: "%", color: "#2f855a", zero: 1}
  ];
  const hm = ms => new Date(ms).toTimeString().slice(0, 5);
  function niceStep(span, n) {
    const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  const MIN_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360];
  // opts.panels: keys to draw (default: those with data). opts.title: header text (time range is appended). The y axis follows the fitted line only; gray raw RS232 dots are clipped to it.
  function drawChart(canvas, rows, t0, t1, startMs, endMs, port, opts = {}) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300;
    const wanted = opts.panels ? PANELS.filter(p => opts.panels.includes(p.key)) : PANELS.filter(p => rows.some(r => num(r[p.key]) !== null) && !(p.key === "power" && port === "D"));
    const show = wanted.length ? wanted : PANELS.slice(0, 2);
    const ph = opts.height || 92, titleH = 18, gap = 26, top = titleH;
    const h = top + show.length * (ph + gap) - gap + 22;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + "px";
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cs = getComputedStyle(canvas), fg = cs.color || "#444";
    const grid = "rgba(128,128,128,.32)", gridMinor = "rgba(128,128,128,.14)", axis = "rgba(128,128,128,.9)";
    const left = 46, right = w - 8, x = ms => left + (ms - t0) / Math.max(1, t1 - t0) * (right - left);
    const marks = rows.filter(r => r.flag).map(r => ({ms: r.ts * 1000, flag: r.flag}));
    const spanMin = (t1 - t0) / 60000;
    const stepMin = MIN_STEPS.find(s => spanMin / s <= Math.max(2, Math.floor((right - left) / 50))) || 360;
    const xticks = [];
    for (let m = Math.ceil(t0 / 60000 / stepMin) * stepMin; m * 60000 <= t1; m += stepMin) xticks.push(m * 60000);
    g.font = "11px sans-serif";
    g.textBaseline = "alphabetic";
    g.fillStyle = fg;
    g.textAlign = "center";
    g.font = "bold 12px sans-serif";
    const range = `${hm(startMs || t0)}–${hm(endMs || t1)}`;
    g.fillText([opts.title, range].filter(Boolean).join("  "), (left + right) / 2, 12);
    g.font = "11px sans-serif";
    show.forEach((p, k) => {
      const y0 = top + k * (ph + gap);
      const pts = rows.map(r => [r.ts * 1000, num(r[p.key])]).filter(q => q[1] !== null && q[0] >= t0);
      const dots = p.dots && port !== "D" ? rows.map(r => [r.ts * 1000, num(r[p.dots])]).filter(q => q[1] !== null && q[0] >= t0) : [];
      let lo = pts.length ? Math.min(...pts.map(q => q[1])) : 0, hi = pts.length ? Math.max(...pts.map(q => q[1])) : 1;
      if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
      if (lo > 0 && lo < hi * p.zero) lo = 0;
      const pad = (hi - lo) * 0.06;
      hi += pad;
      lo = lo === 0 ? -pad : lo - pad;
      const y = v => y0 + ph - (v - lo) / (hi - lo) * ph;
      g.save();
      g.beginPath();
      g.rect(left, y0, right - left, ph);
      g.clip();
      if (startMs) {
        g.fillStyle = "rgba(237,137,54,.14)";
        const a = Math.max(left, x(startMs)), b = Math.min(right, x(endMs || t1));
        if (b > a) g.fillRect(a, y0, b - a, ph);
      }
      g.restore();
      // grid
      const ystep = niceStep(hi - lo, Math.max(2, Math.floor(ph / 26)));
      const dec = ystep >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(ystep)));
      g.strokeStyle = gridMinor;
      g.lineWidth = 1;
      g.beginPath();
      for (let v = Math.ceil(lo / (ystep / 2)) * (ystep / 2); v <= hi; v += ystep / 2) { g.moveTo(left, Math.round(y(v)) + .5); g.lineTo(right, Math.round(y(v)) + .5); }
      for (let m = Math.ceil(t0 / 60000 / (stepMin / 2)) * (stepMin / 2); m * 60000 <= t1; m += stepMin / 2) { const xm = Math.round(x(m * 60000)) + .5; g.moveTo(xm, y0); g.lineTo(xm, y0 + ph); }
      g.stroke();
      g.strokeStyle = grid;
      g.beginPath();
      for (let v = Math.ceil(lo / ystep) * ystep; v <= hi; v += ystep) { g.moveTo(left, Math.round(y(v)) + .5); g.lineTo(right, Math.round(y(v)) + .5); }
      for (const m of xticks) { g.moveTo(Math.round(x(m)) + .5, y0); g.lineTo(Math.round(x(m)) + .5, y0 + ph); }
      g.stroke();
      g.strokeStyle = axis;
      g.strokeRect(left + .5, y0 + .5, right - left - 1, ph - 1);
      g.fillStyle = fg;
      g.textAlign = "right";
      g.textBaseline = "middle";
      for (let v = Math.ceil(lo / ystep) * ystep; v <= hi; v += ystep) g.fillText((Math.abs(v) < ystep / 1e6 ? 0 : v).toFixed(dec), left - 4, y(v));
      g.textAlign = "center";
      g.textBaseline = "alphabetic";
      for (const m of xticks) g.fillText(hm(m), x(m), y0 + ph + 13);
      g.save();
      g.translate(9, y0 + ph / 2);
      g.rotate(-Math.PI / 2);
      g.fillText(`${p.label} (${p.unit})`, 0, 3);
      g.restore();
      // y = 0 baseline
      if (lo < 0 && hi > 0) {
        g.strokeStyle = "rgba(60,60,60,.85)";
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(left, y(0));
        g.lineTo(right, y(0));
        g.stroke();
      }
      g.save();
      g.beginPath();
      g.rect(left, y0, right - left, ph);
      g.clip();
      if (startMs) {
        g.strokeStyle = "rgba(237,137,54,.9)";
        g.lineWidth = 1;
        g.beginPath();
        for (const m of [startMs, endMs]) if (m && m >= t0 && m <= t1) { g.moveTo(x(m), y0); g.lineTo(x(m), y0 + ph); }
        g.stroke();
      }
      if (opts.detMs && opts.detMs >= t0 && opts.detMs <= t1) {
        g.strokeStyle = "rgba(47,133,90,.95)";
        g.setLineDash([3, 2]);
        g.beginPath();
        g.moveTo(x(opts.detMs), y0);
        g.lineTo(x(opts.detMs), y0 + ph);
        g.stroke();
        g.setLineDash([]);
      }
      for (const m of marks) {
        if (m.ms < t0 || m.ms > t1) continue;
        g.strokeStyle = m.flag === "reset" ? "rgba(197,48,48,.8)" : "rgba(214,158,46,.8)";
        g.beginPath();
        g.moveTo(x(m.ms), y0);
        g.lineTo(x(m.ms), y0 + 6);
        g.stroke();
      }
      if (pts.length) {
        g.fillStyle = "rgba(128,128,128,.6)";
        for (const q of dots) if (q[1] >= lo && q[1] <= hi) g.fillRect(x(q[0]) - 1, y(q[1]) - 1, 2, 2);
        g.strokeStyle = p.color;
        g.lineWidth = 1.6;
        g.lineJoin = "round";
        g.beginPath();
        pts.forEach((q, n) => { if (n) g.lineTo(x(q[0]), y(q[1])); else g.moveTo(x(q[0]), y(q[1])); });
        g.stroke();
        if (p.slope) {
          // tangent over the last 10 s: slope = rate_fit (A/s) = rate/10 nm/s
          const last = rows[rows.length - 1], rf = last && num(last.rate_fit), lv = last && num(last.thk_med);
          if (rf !== null && lv !== null && last.ts * 1000 <= t1) {
            g.strokeStyle = "#e53e3e";
            g.lineWidth = 2.2;
            g.beginPath();
            g.moveTo(x(last.ts * 1000 - 10000), y(lv - rf / 10 * 10));
            g.lineTo(x(last.ts * 1000), y(lv));
            g.stroke();
          }
        }
      }
      g.restore();
      // legend (top-left inside the panel)
      if (p.dots || p.slope) {
        g.font = "10.5px sans-serif";
        const items = p.dots ? (dots.length ? [["dot", "RS232 원값"], ["line", "10초 기울기"]] : [["line", "10초 기울기"]]) : [["line", "두께 (5초 중앙값)"]];
        let lx = left + 6;
        g.textAlign = "left";
        g.textBaseline = "middle";
        for (const [kind, text] of items) {
          const tw = g.measureText(text).width;
          g.fillStyle = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "rgba(30,30,30,.78)" : "rgba(255,255,255,.78)";
          g.fillRect(lx - 2, y0 + 3, tw + 22, 14);
          if (kind === "dot") { g.fillStyle = "rgba(110,110,110,.9)"; g.beginPath(); g.arc(lx + 4, y0 + 10, 2.2, 0, 7); g.fill(); }
          else { g.strokeStyle = kind === "tan" ? "#e53e3e" : p.color; g.lineWidth = kind === "tan" ? 2.2 : 1.6; g.beginPath(); g.moveTo(lx, y0 + 10); g.lineTo(lx + 9, y0 + 10); g.stroke(); }
          g.fillStyle = fg;
          g.fillText(text, lx + 12, y0 + 10);
          lx += tw + 28;
        }
        g.font = "11px sans-serif";
      }
      g.textBaseline = "alphabetic";
      g.lineWidth = 1;
    });
  }

  // First row at or after `ms` (fallback: last row before it), so start/end values come from the server's clock at the click, not from whenever the app got an answer.
  function rowAt(rows, ms, field, maxLagMs = 60000) {
    const t = ms / 1000;
    let best = null;
    for (const r of rows) if (r.ts >= t - 1 && r.ts <= t + maxLagMs / 1000 && num(r[field]) !== null) { best = r; break; }
    return best;
  }
  const mmss = sec => `${Math.floor(sec / 60)}:${String(Math.max(0, Math.round(sec % 60))).padStart(2, "0")}`;

  // Everything the page does with a running or finished layer, from one server fetch: chart, big numbers, delayed start/end values, start detection, heat check, one-touch result.
  // ctx: {layers(): draft layers, set(i, patch)}
  function analyze(l, i, rows, now, ctx) {
    const out = {};
    const patch = {};
    const startMs = l.started_ms, endMs = l.ended_ms;
    if (startMs && (l.start_pending || !l.start_thk)) {
      const t = rowAt(rows, startMs, "thk_med"), r = rowAt(rows, startMs, "rate_fit", 120000);
      if (t && !l.start_thk) patch.start_thk = fmtNum(t.thk_med, 2);
      if (r && !l.start_rate) patch.start_rate = fmtNum(r.rate_fit, 3);
      const need = [!(l.start_thk || patch.start_thk), !(l.start_rate || patch.start_rate)];
      if (!need[0] && (!need[1] || now - startMs > 120000)) patch.start_pending = "";
    }
    if (endMs && (l.end_pending || !l.end_thk)) {
      const t = rowAt(rows, endMs, "thk_med"), r = rowAt(rows, endMs, "rate_fit", 120000);
      if (t && !l.end_thk) patch.end_thk = fmtNum(t.thk_med, 2);
      if (r && !l.end_rate) patch.end_rate = fmtNum(r.rate_fit, 3);
      const need = [!(l.end_thk || patch.end_thk), !(l.end_rate || patch.end_rate)];
      if (!need[0] && (!need[1] || now - endMs > 120000)) patch.end_pending = "";
    }
    const merged = {...l, ...patch};
    if (endMs && merged.start_thk && merged.end_thk && !merged.mon_diff) {
      const res = Core.thickResult({startThk: merged.start_thk, endThk: merged.end_thk, startMs, endMs});
      if (res) { patch.mon_diff = fmtNum(res.diff, 2); patch.avg_rate = fmtNum(res.avgRate, 3); }
    }
    if (startMs && !l.det_ms) {
      const hit = Core.detectStart(rows.filter(r => r.ts >= startMs / 1000 && (!endMs || r.ts <= endMs / 1000)));
      if (hit) {
        const row = rows.find(r => r.ts === hit.start);
        Object.assign(patch, {det_ms: Math.round(hit.start * 1000), det_power: l.det_power || l.start_power || (l.sensor_port !== "D" && row && num(row.power) !== null ? fmtNum(row.power, 1) : ""), det_temp: l.det_temp || l.start_temp || ""});
      }
    }
    if (endMs && !l.heat && merged.end_thk) {
      if (now >= endMs + 185000) {
        const res = Core.heatCheck(rows.filter(r => r.ts * 1000 > endMs), merged.end_thk);
        if (res) Object.assign(patch, {heat: res.suspect ? "1" : "0", heat_delta: fmtNum(res.delta, 2)});
      } else out.heatWait = Math.ceil((endMs + 180000 - now) / 1000);
    }
    return {patch, out, merged: {...merged, ...patch}};
  }

  function chartTitle(port, rows, material) {
    const no = [...rows].reverse().map(r => r.material_no).find(v => v !== null && v !== undefined);
    return `${port}${no !== undefined ? " #" + no : ""}${material ? "/" + material : ""}`;
  }
  // Redraws every chart canvas ([data-thickchart]) on the page and updates the big numbers next to it.
  const cache = new Map();
  let timer = null;
  async function refresh(ctx, root = document) {
    if (!enabled()) return;
    for (const canvas of root.querySelectorAll("canvas[data-thickchart]")) {
      const i = Number(canvas.dataset.i);
      const l = ctx.layers()[i];
      const box = canvas.closest("[data-thickbox]");
      const label = box && box.querySelector("[data-thickstatus]");
      if (!l || !l.sensor_port) continue;
      const now = Date.now();
      const running = l.started_ms && !l.ended_ms;
      const t0 = l.started_ms ? l.started_ms - 180000 : now - 180000;
      const t1 = l.ended_ms ? Math.min(now, l.ended_ms + 180000) : now;
      const settled = l.ended_ms && now > l.ended_ms + 190000;
      const id = `${l.sensor_port}|${t0}|${l.ended_ms || ""}`;
      let hit = cache.get(id);
      if (!hit || !settled) {
        const rows = await range(l.sensor_port, t0, t1 + 2000);
        if (rows) hit = {rows};
        else if (!hit) { if (label) label.textContent = "서버 연결 안 됨"; continue; }
        cache.set(id, hit);
      }
      const {patch, out, merged} = analyze(l, i, hit.rows, now, ctx);
      if (Object.keys(patch).length) ctx.set(i, patch);
      if (label) label.textContent = hit.rows.length ? `${hit.rows.length}점 · ${running ? "실시간" : l.ended_ms ? "구간 기록" : "최근 3분"}` : "데이터 없음";
      drawChart(canvas, hit.rows, t0, Math.max(t1, t0 + 1000), l.started_ms, l.ended_ms, l.sensor_port, {detMs: merged.det_ms, title: chartTitle(l.sensor_port, hit.rows, l.material)});
      updateLive(box, merged, hit.rows, running, out, now);
    }
  }
  function updateLive(box, l, rows, running, out, now) {
    if (!box) return;
    const set = (k, v) => { const el = box.querySelector(`[data-live="${k}"]`); if (el && el.textContent !== v) el.textContent = v; };
    const last = [...rows].reverse().find(r => num(r.thk_med) !== null) || null;
    const cur = rows[rows.length - 1];
    const rate = cur && num(cur.rate_fit);
    set("rate", rate === null || rate === undefined ? "측정 중" : fmtNum(rate, 2));
    const startThk = num(l.start_thk);
    let layerThk = null;
    if (l.ended_ms && num(l.mon_diff) !== null) layerThk = num(l.mon_diff);
    else if (running && startThk !== null && last) layerThk = num(last.thk_med) - startThk;
    set("thk", layerThk === null ? (l.started_ms && !l.start_thk ? "측정 중" : "–") : fmtNum(layerThk, 2));
    let eta = "–";
    const target = num(l.monitor);
    if (running && layerThk !== null && target !== null) {
      if (layerThk >= target) eta = "도달";
      else if (rate && rate > 0.02) eta = mmss((target - layerThk) * 10 / rate);
    }
    set("eta", eta);
    const notes = [];
    if (l.ended_ms) {
      if (l.mon_diff) notes.push(`모니터 ${l.mon_diff} nm · 평균 ${l.avg_rate || "–"} Å/s · 끝 ${l.end_rate || "측정 중"} Å/s`);
      if (out.heatWait) notes.push(`열 영향 관찰 중 ${mmss(out.heatWait)}`);
      else if (l.heat === "1") notes.push(`열 영향 의심: 끝난 뒤 ${l.heat_delta} nm 감소`);
      else if (l.heat === "0") notes.push("끝난 뒤 두께 변화 없음");
    } else if (l.started_ms) {
      if (l.start_pending) notes.push("시작값 측정 중 (리셋 후 10초)");
      notes.push(l.det_ms ? `증착 시작 ${hms(l.det_ms)} · P ${l.det_power || "–"} · T ${l.det_temp || "–"}` : "증착 시작 대기 (rate 0.1 Å/s 이상 10초)");
    }
    const flags = rows.filter(r => r.flag && (!l.started_ms || r.ts * 1000 >= l.started_ms) && (!l.ended_ms || r.ts * 1000 <= l.ended_ms));
    const resets = flags.filter(r => r.flag === "reset").length, spikes = flags.filter(r => r.flag === "spike").length;
    if (resets) notes.push(`층 도중 리셋 ${resets}회 — 두께차 신뢰 불가`);
    if (spikes) notes.push(`스파이크 ${spikes}점 제외`);
    set("note", notes.join(" · "));
  }
  function watch(ctx, active) {
    clearInterval(timer);
    timer = null;
    if (!enabled()) return;
    refresh(ctx);
    timer = setInterval(() => { if (active() && !document.hidden) refresh(ctx); }, 2000);
  }
  function stop() { clearInterval(timer); timer = null; }

  // Series for the xlsx extra sheet, thinned to at most `max` rows.
  async function series(port, fromMs, toMs, max = 600) {
    const rows = await range(port, fromMs, toMs);
    if (!rows) return null;
    const step = Math.max(1, Math.ceil(rows.length / max));
    return rows.filter((r, i) => i % step === 0 || r.flag);
  }

  root.VTEThick = {analyze, rowAt, SENSORS, enabled, url, KEY, getJson, live, range, snapshot, series, watch, stop, refresh, drawChart, chartTitle, fmtNum};
})(typeof globalThis !== "undefined" ? globalThis : this);
