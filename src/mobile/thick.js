/* Thickness-monitor server client (Telemark loggers on the evaporator PC). All calls fail soft: no server means manual entry only. */
(function (root) {
  "use strict";
  const KEY = "vte.thickUrl";
  const SENSORS = ["A", "B", "C", "D"];
  const url = () => (localStorage.getItem(KEY) || "").trim().replace(/\/+$/, "");
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
    return j ? j.rows || [] : null;
  }
  const num = v => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
  // Values for the form: thickness in nm, rate in Å/s, power in %.
  async function snapshot(port) {
    const p = (await live())?.[port];
    if (!p || !p.ok) return null;
    return {thk: num(p.thk_nm), rate: num(p.rate), power: num(p.power)};
  }

  const fmtNum = (v, d) => (v === null || v === undefined ? "" : String(Math.round(v * 10 ** d) / 10 ** d));
  const hms = ms => new Date(ms).toTimeString().slice(0, 8);

  // ---------- chart ----------
  const PANELS = [
    {key: "thk_nm", label: "두께 nm", color: "#2b6cb0"},
    {key: "rate", label: "레이트 Å/s", color: "#c05621"},
    {key: "power", label: "파워 %", color: "#2f855a"}
  ];
  function drawChart(canvas, rows, t0, t1, startMs, endMs) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300;
    const panels = PANELS.filter(p => rows.some(r => num(r[p.key]) !== null));
    const show = panels.length ? panels : PANELS.slice(0, 2);
    const ph = 64, top = 4, h = top + show.length * (ph + 6) + 14;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + "px";
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const fg = getComputedStyle(canvas).color || "#444";
    const left = 38, right = w - 6, x = ms => left + (ms - t0) / Math.max(1, t1 - t0) * (right - left);
    g.font = "10px sans-serif";
    show.forEach((p, k) => {
      const y0 = top + k * (ph + 6);
      const pts = rows.map(r => [r.ts * 1000, num(r[p.key])]).filter(q => q[1] !== null);
      g.fillStyle = "rgba(128,128,128,.08)";
      g.fillRect(left, y0, right - left, ph);
      if (startMs) {
        g.fillStyle = "rgba(237,137,54,.18)";
        const a = Math.max(left, x(startMs)), b = Math.min(right, x(endMs || t1));
        if (b > a) g.fillRect(a, y0, b - a, ph);
        g.strokeStyle = "rgba(237,137,54,.9)";
        g.beginPath();
        for (const m of [startMs, endMs]) if (m && m >= t0 && m <= t1) { g.moveTo(x(m), y0); g.lineTo(x(m), y0 + ph); }
        g.stroke();
      }
      g.fillStyle = fg;
      g.textAlign = "left";
      g.fillText(p.label, left + 3, y0 + 10);
      if (!pts.length) return;
      let lo = Math.min(...pts.map(q => q[1])), hi = Math.max(...pts.map(q => q[1]));
      if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
      const y = v => y0 + ph - 3 - (v - lo) / (hi - lo) * (ph - 8);
      g.textAlign = "right";
      g.fillText(fmtNum(hi, 2), left - 3, y0 + 9);
      g.fillText(fmtNum(lo, 2), left - 3, y0 + ph);
      g.strokeStyle = p.color;
      g.lineWidth = 1.5;
      g.beginPath();
      pts.forEach((q, j) => (j ? g.lineTo(x(q[0]), y(q[1])) : g.moveTo(x(q[0]), y(q[1]))));
      g.stroke();
      g.lineWidth = 1;
    });
    g.fillStyle = fg;
    g.textAlign = "left";
    g.fillText(hms(t0), left, h - 3);
    g.textAlign = "right";
    g.fillText(hms(t1), right, h - 3);
  }

  // Redraws every chart canvas ([data-thickchart]) on the page; `getLayer(i)` returns the draft layer behind a canvas.
  const cache = new Map();
  let timer = null;
  async function refresh(getLayer, root = document) {
    if (!enabled()) return;
    for (const canvas of root.querySelectorAll("canvas[data-thickchart]")) {
      const l = getLayer(Number(canvas.dataset.i));
      const label = canvas.parentElement.querySelector("[data-thickstatus]");
      if (!l || !l.sensor_port) continue;
      const now = Date.now();
      const running = l.started_ms && !l.ended_ms;
      const t0 = (l.started_ms || now - 600000) - 60000;
      const t1 = l.ended_ms ? l.ended_ms + 30000 : now;
      const id = `${l.sensor_port}|${t0}|${l.ended_ms || ""}`;
      let hit = cache.get(id);
      if (!hit || running || !l.started_ms) {
        const rows = await range(l.sensor_port, t0, t1);
        if (rows) hit = {rows};
        else if (!hit) { if (label) label.textContent = "서버 연결 안 됨"; continue; }
        cache.set(id, hit);
      }
      if (label) label.textContent = hit.rows.length ? `${hit.rows.length}점 · ${running ? "실시간" : l.ended_ms ? "구간 기록" : "최근 10분"}` : "데이터 없음";
      drawChart(canvas, hit.rows, t0, t1, l.started_ms, l.ended_ms);
    }
  }
  function watch(getLayer, active) {
    clearInterval(timer);
    timer = null;
    if (!enabled()) return;
    refresh(getLayer);
    timer = setInterval(() => { if (active() && !document.hidden) refresh(getLayer); }, 2000);
  }
  function stop() { clearInterval(timer); timer = null; }

  // Series for the xlsx extra sheet, thinned to at most `max` rows.
  async function series(port, fromMs, toMs, max = 600) {
    const rows = await range(port, fromMs, toMs);
    if (!rows) return null;
    const step = Math.max(1, Math.ceil(rows.length / max));
    return rows.filter((_, i) => i % step === 0);
  }

  root.VTEThick = {SENSORS, enabled, url, KEY, getJson, live, range, snapshot, series, watch, stop, refresh, drawChart, fmtNum};
})(typeof globalThis !== "undefined" ? globalThis : this);
