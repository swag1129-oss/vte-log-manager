/* Thickness-monitor server client (Telemark loggers on the evaporator PC). All calls fail soft: no server means manual entry only. */
(function (root) {
  "use strict";
  const Core = root.VTECore || (typeof require === "function" ? require("../core/vte-core.js") : null);
  const KEY = "vte.thickUrl";
  const SENSORS = ["A", "B", "C", "D"];
  // Evaporation source -> [monitor port, sensor number on that port]. Single place to edit when the monitor wiring changes.
  const SOURCE_SENSOR = {"M-1": ["A", 1], "M-2": ["A", 2], "M-3": ["B", 1], "O-1": ["B", 2], "O-2": ["B", 2], "O-3": ["C", 1], "O-4": ["C", 1], "O-5": ["C", 2], "O-6": ["D", 1], "O-7": ["D", 1], "O-8": ["D", 2], "O-9": ["D", 2]};
  const sensorFor = src => { const m = SOURCE_SENSOR[String(src || "").trim().toUpperCase()]; return m ? {port: m[0], sensor: m[1]} : null; };
  const sourceNames = (port, sensor) => Object.keys(SOURCE_SENSOR).filter(k => SOURCE_SENSOR[k][0] === port && SOURCE_SENSOR[k][1] === sensor).join("/");
  // Sets layer.sensor_port from its source unless the user picked one by hand (or an existing log already has one).
  function autoSensor(layer, editing) {
    if (layer.sensor_manual || (editing && layer.sensor_port)) return false;
    const m = sensorFor(layer.port);
    if (!m || layer.sensor_port === m.port) return false;
    layer.sensor_port = m.port;
    return true;
  }
  // Fills only blank sensor_port on every layer (loaded presets/logs/drafts); keeps existing and manual values.
  function fillSensors(layers) {
    let n = 0;
    for (const l of layers || []) if (!l.sensor_port && !l.sensor_manual && autoSensor(l, false)) n++;
    return n;
  }
  // Warning when the monitor port's active sensor differs from the one wired to the layer's source. `livePorts` = /live `ports`.
  function sensorWarning(layer, livePorts) {
    const m = sensorFor(layer.port);
    if (!m || layer.sensor_port !== m.port) return "";
    const p = livePorts && livePorts[m.port];
    if (!p || p.sensor === null || p.sensor === undefined || Number(p.sensor) === m.sensor) return "";
    return `${m.port}는 지금 센서 ${p.sensor}(${sourceNames(m.port, Number(p.sensor)) || "?"}) — ${layer.port}는 센서 ${m.sensor}`;
  }
  // Layers of one co-dep block that share a physical sensor (e.g. O-1 + O-2) read the summed thickness.
  function sharedSensorNote(layers) {
    if (!layers || layers.length < 2) return "";
    const seen = new Map();
    for (const l of layers) { const m = sensorFor(l.port); if (m) { const k = m.port + m.sensor; seen.set(k, [...(seen.get(k) || []), l.port]); } }
    const hit = [...seen.values()].find(a => new Set(a).size > 1);
    return hit ? `센서 공유(${[...new Set(hit)].join("+")}) — 두께 합산` : "";
  }
  const DEFAULT_URL = "https://thermalevaporator.tail95c053.ts.net";
  const url = () => (localStorage.getItem(KEY) || DEFAULT_URL).trim().replace(/\/+$/, "");
  const enabled = () => Boolean(url());

  async function getJson(path, ms = 8000) {
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
  // Tells the alert service which thickness a layer must reach (best effort; failures ignored).
  async function postJson(path, body) {
    const base = url();
    if (!base) return;
    try { await fetch(base + path, {method: "POST", body: JSON.stringify(body), keepalive: true}); } catch (e) { /* ignore */ }
  }
  const setTarget = (port, label, targetNm, startNm, logId) => {
    const t = Number(targetNm), s = Number(startNm);
    return t > 0 && Number.isFinite(s) ? postJson("/target", {port, layer_label: label || "", target_monitor_nm: t, start_thk_nm: s, log_id: logId || ""}) : null;
  };
  const clearTarget = (port, label) => postJson("/target/clear", {port, layer_label: label || ""});
  const healthBadge = h => (h === null || h === undefined || Number.isNaN(Number(h)) ? null : {text: `health ${Math.round(Number(h))}%`, color: Number(h) <= 70 ? "#d33" : Number(h) <= 80 ? "#e8890c" : ""});
  const live = async () => (await getJson("/live"))?.ports || null;
  async function range(port, fromMs, toMs) {
    const j = await getJson(`/range?port=${encodeURIComponent(port)}&from=${Math.floor(fromMs / 1000)}&to=${Math.ceil(toMs / 1000)}`, 8000);
    return j ? (j.rows || []) : null;
  }
  const num = v => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
  // Values for the form: thickness (5 s median) in nm, rate_fit (adaptive 10-60 s slope of it) in Å/s, power in %. Raw RS232 `rate` is never used for autofill.
  async function snapshot(port) {
    let lp = await live();
    if (!lp) lp = await live();
    const p = lp?.[port];
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
    const SER = opts.series || [{rows, color: null, name: ""}], multi = Boolean(opts.series);
    const marks = (multi ? SER.flatMap(s => s.rows) : rows).filter(r => r.flag).map(r => ({ms: r.ts * 1000, flag: r.flag}));
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
      const sers = SER.map(s => ({...s, pts: s.rows.map(r => [r.ts * 1000, num(r[p.key])]).filter(q => q[1] !== null && q[0] >= t0)}));
      const pts = multi ? sers.flatMap(s => s.pts) : sers[0].pts;
      const dots = !multi && p.dots && port !== "D" ? rows.map(r => [r.ts * 1000, num(r[p.dots])]).filter(q => q[1] !== null && q[0] >= t0) : [];
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
        for (const s of sers) {
          g.strokeStyle = s.color || p.color;
          g.lineWidth = 1.6;
          g.lineJoin = "round";
          g.beginPath();
          s.pts.forEach((q, n) => { if (n) g.lineTo(x(q[0]), y(q[1])); else g.moveTo(x(q[0]), y(q[1])); });
          g.stroke();
        }
        if (p.slope && !multi) {
          // tangent over the server's adaptive window (10-60 s): slope = rate_fit (A/s) = rate/10 nm/s
          const last = rows[rows.length - 1], rf = last && num(last.rate_fit), lv = last && num(last.thk_med);
          const win = num(last && last.rate_win) || 10;
          if (rf !== null && lv !== null && last.ts * 1000 <= t1) {
            g.strokeStyle = "#e53e3e";
            g.lineWidth = 2.2;
            g.beginPath();
            g.moveTo(x(last.ts * 1000 - win * 1000), y(lv - rf / 10 * win));
            g.lineTo(x(last.ts * 1000), y(lv));
            g.stroke();
          }
        }
      }
      g.restore();
      // legend (top-left inside the panel)
      if (multi ? k === 0 : (p.dots || p.slope)) {
        g.font = "10.5px sans-serif";
        const items = multi ? SER.map(s => ["line", s.name, s.color]) : p.dots ? (dots.length ? [["dot", "RS232 원값"], ["line", "기울기(10–60초)"]] : [["line", "기울기(10–60초)"]]) : [["line", "두께 (5초 중앙값)"]];
        const lum = (fg.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).reduce((a, v, n) => a + v * [.2126, .7152, .0722][n], 0);
        const legendBg = lum > 128 ? "rgba(24,24,24,.82)" : "rgba(255,255,255,.85)";  // chart text light => dark theme
        let lx = left + 6;
        g.textAlign = "left";
        g.textBaseline = "middle";
        for (const [kind, text, col] of items) {
          const tw = g.measureText(text).width;
          g.fillStyle = legendBg;
          g.fillRect(lx - 2, y0 + 3, tw + 22, 14);
          if (kind === "dot") { g.fillStyle = "rgba(110,110,110,.9)"; g.beginPath(); g.arc(lx + 4, y0 + 10, 2.2, 0, 7); g.fill(); }
          else { g.strokeStyle = kind === "tan" ? "#e53e3e" : col || p.color; g.lineWidth = kind === "tan" ? 2.2 : 1.6; g.beginPath(); g.moveTo(lx, y0 + 10); g.lineTo(lx + 9, y0 + 10); g.stroke(); }
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

  const MEMBER_COLORS = ["#2b6cb0", "#dd6b20", "#2f855a"];
  const nf = v => (v === null || v === undefined || String(v).trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  // Co-dep doping ratio. members: [{port, sensor_port, ratio, vol, dThk (monitor nm gained), rate (monitor A/s)}].
  // Real thickness = monitor value x ratio (actual/monitor); cum = share of each member in the summed real thickness gained since the start, inst = same with current rates.
  // Two sources on one sensor read a summed thickness, so no ratio can be computed (shared).
  function codepDoping(members) {
    const keys = members.map(m => { const s = sensorFor(m.port); return s ? s.port + s.sensor : "p" + (m.sensor_port || ""); });
    const shared = new Set(keys).size < keys.length;
    const rat = m => { const r = nf(m.ratio); return r !== null && r > 0 ? r : null; };
    const assumed = members.some(m => rat(m) === null);
    const share = f => {
      const a = members.map(m => { const v = nf(m[f]); return v === null ? null : v * (rat(m) ?? 1); });
      if (a.some(v => v === null || v < 0)) return null;
      const sum = a.reduce((x, y) => x + y, 0);
      return sum > 0 ? a.map(v => v / sum * 100) : null;
    };
    const target = members.map(m => nf(m.vol));
    const base = target.every(v => v !== null) ? target : null;
    const cum = shared ? null : share("dThk"), inst = shared ? null : share("rate");
    const ref = base || cum || inst || members.map(() => 0);
    const host = ref.indexOf(Math.max(...ref));
    return {shared, assumed, cum, inst, target: base, host};
  }
  const pct = v => (Math.round(v * 10) / 10).toFixed(1);
  // Short readout lines for the non-host members: "Ir(ppy)3 누적 7.2% (목표 7%)" and "지금 6.8%".
  function dopingTexts(members, d) {
    if (d.shared) return {cum: "센서 공유 — 도핑비 계산 불가", inst: ""};
    const others = members.map((m, k) => k).filter(k => k !== d.host);
    const line = (arr, word, tgt) => (arr ? others.map(k => `${members[k].material || "?"} ${word} ${pct(arr[k])}%${tgt && d.target ? ` (목표 ${fmtNum(d.target[k], 1)}%)` : ""}`).join(" · ") : "");
    return {cum: (d.cum ? line(d.cum, "누적", true) : "누적 도핑비 –") + (d.cum && d.assumed ? " · ratio 없음(1 가정)" : ""), inst: d.inst ? line(d.inst, "지금", false) : ""};
  }
  function chartTitle(port, rows, material) {
    const no = [...rows].reverse().map(r => r.material_no).find(v => v !== null && v !== undefined);
    return `${port}${no !== undefined ? " #" + no : ""}${material ? "/" + material : ""}`;
  }
  // Redraws every chart canvas ([data-thickchart]) on the page and updates the big numbers next to it.
  const cache = new Map();
  let timer = null, wakeBound = false, curCtx = null, curActive = null;
  async function refresh(ctx, root = document) {
    if (!enabled()) return;
    const warns = [...root.querySelectorAll("[data-thickwarn]")];
    const badges = [...root.querySelectorAll("[data-thickhealth]")];
    if (warns.length || badges.length) {
      const lp = await live();
      for (const el of badges) {
        const b = healthBadge(lp?.[el.dataset.thickhealth]?.health);
        el.textContent = b ? b.text : ""; el.style.color = b ? b.color : "";
      }
      for (const el of warns) {
        const idx = String(el.dataset.thickwarn).split(",").map(Number), ls = ctx.layers();
        const own = ls[idx[0]];
        el.textContent = [own ? sensorWarning(own, lp) : "", sharedSensorNote(idx.map(j => ls[j]).filter(Boolean))].filter(Boolean).join(" · ");
      }
    }
    const allLayers = ctx.layers(), nextPre = new Set();
    for (const port of new Set(allLayers.filter(x => x && x.sensor_port && !x.started_ms).map(x => x.sensor_port))) nextPre.add(allLayers.findIndex(x => x && x.sensor_port === port && !x.started_ms));
    for (const canvas of root.querySelectorAll("canvas[data-thickchart], canvas[data-thickco]")) {
      if (canvas.dataset.thickco) { await refreshCodep(canvas, root, allLayers, nextPre, ctx); continue; }
      const i = Number(canvas.dataset.i);
      const l = allLayers[i];
      const box = canvas.closest("[data-thickbox]");
      const label = root.querySelector(`[data-thickstatus][data-i="${i}"]`) || (box && box.querySelector("[data-thickstatus]")) || (box && box.parentElement && box.parentElement.querySelector("[data-thickstatus]")) || canvas.closest("section,article,.card,.layer")?.querySelector("[data-thickstatus]") || null;
      const r = await serve(l, i, nextPre, ctx, label);
      if (!r) continue;
      drawChart(canvas, thin(r.hit.rows), r.t0, Math.max(r.t1, r.t0 + 1000), l.started_ms, l.ended_ms, l.sensor_port, {detMs: r.merged.det_ms, title: chartTitle(l.sensor_port, r.hit.rows, l.material)});
      updateLive(box, r.merged, r.hit.rows, r.running, r.out, r.now);
    }
  }
  const thin = rows => (rows.length > 3000 ? rows.filter((r, k) => k % Math.ceil(rows.length / 3000) === 0 || r.flag || k === rows.length - 1) : rows);
  // Fetches (cached) and analyzes one layer; returns null while there is nothing to show.
  async function serve(l, i, nextPre, ctx, label) {
    if (!l || !l.sensor_port) return null;
    const now = Date.now();
    const running = l.started_ms && !l.ended_ms;
    const t0 = l.started_ms ? l.started_ms - 180000 : now - 180000;
    const t1 = l.ended_ms ? Math.min(now, l.ended_ms + 180000) : now;
    const settled = l.ended_ms && now > l.ended_ms + 190000;
    const pre = !l.started_ms;
    if (pre && !nextPre.has(i)) { if (label) label.textContent = "시작 전"; return null; }
    const id = pre ? `${l.sensor_port}|pre` : `${l.sensor_port}|${t0}|${l.ended_ms || ""}`;
    let hit = cache.get(id);
    if (!hit) { hit = {rows: [], lastTs: 0, okAt: 0, nextAt: 0, fails: 0, busy: false, full: false, done: false}; cache.set(id, hit); }
    if (!hit.done && !hit.busy && now >= hit.nextAt) {
      hit.busy = true;
      try {
        const rows = hit.full ? await range(l.sensor_port, hit.lastTs * 1000, t1 + 2000) : await range(l.sensor_port, t0, t1 + 2000);
        if (rows) {
          if (!hit.full) hit.rows = rows;
          else { for (const r of rows) if (r.ts > hit.lastTs) hit.rows.push(r); }
          if (pre) { const cut = (now - 200000) / 1000; if (hit.rows.length && hit.rows[0].ts < cut) hit.rows = hit.rows.filter(r => r.ts >= cut); }
          if (hit.rows.length) hit.lastTs = hit.rows[hit.rows.length - 1].ts;
          hit.full = true; hit.fails = 0; hit.okAt = Date.now(); hit.nextAt = hit.okAt + 1800;
          if (settled) hit.done = true;
        } else { hit.fails++; hit.nextAt = Date.now() + Math.min(5000, 1000 * hit.fails); }
      } finally { hit.busy = false; }
    }
    if (!hit.okAt) { if (label) label.textContent = hit.fails >= 3 ? "서버 연결 안 됨" : "연결 중…"; return null; }
    const {patch, out, merged} = analyze(l, i, hit.rows, now, ctx);
    if (Object.keys(patch).length) ctx.set(i, patch);
    const age = Math.max(0, Math.round((Date.now() - hit.okAt) / 1000));
    if (label) {
      label.textContent = (hit.rows.length ? `${hit.rows.length}점 · ${running ? "실시간" : l.ended_ms ? "구간 기록" : "최근 3분"}` : "데이터 없음") + (hit.done ? "" : ` · 갱신 ${age}초 전`);
      label.style.color = !hit.done && age > 10 ? "#e8890c" : "";
      if (!hit.done && (hit.fails >= 3 || age > 15)) label.textContent = "서버 연결 안 됨";
    }
    return {hit, t0, t1, running, merged, out, now};
  }
  // One chart + one doping readout for a co-deposition block (canvas[data-thickco="i,j,.."]).
  async function refreshCodep(canvas, root, allLayers, nextPre, ctx) {
    const idx = canvas.dataset.thickco.split(",").map(Number);
    const box = canvas.closest("[data-thickbox]");
    const rs = [];
    for (const j of idx) rs.push(await serve(allLayers[j], j, nextPre, ctx, root.querySelector(`[data-thickstatus][data-i="${j}"]`)));
    const ok = rs.map((r, k) => r && {r, l: allLayers[idx[k]], k}).filter(Boolean);
    if (!ok.length) return;
    const l0 = allLayers[idx[0]];
    const t0 = Math.min(...ok.map(o => o.r.t0)), t1 = Math.max(...ok.map(o => o.r.t1));
    const series = ok.map(o => ({name: `${o.l.material || "?"} · ${o.l.sensor_port}`, color: MEMBER_COLORS[o.k % MEMBER_COLORS.length], rows: thin(o.r.hit.rows)}));
    drawChart(canvas, [], t0, Math.max(t1, t0 + 1000), l0.started_ms, l0.ended_ms, l0.sensor_port, {series, panels: ["thk_med", "rate_fit"], detMs: ok[0].r.merged.det_ms, title: idx.map(j => allLayers[j].material || "?").join(":")});
    const parts = idx.map((j, k) => {
      const r = rs[k];
      return r ? {...liveParts(r.merged, r.hit.rows, r.running, r.out), l: r.merged} : null;
    });
    if (!box) return;
    const set = (k, v) => { const el = box.querySelector(`[data-co="${k}"]`); if (el && el.textContent !== v) el.textContent = v; };
    const ms = idx.map((j, k) => ({...allLayers[j], dThk: parts[k] && parts[k].layerThk, rate: parts[k] && parts[k].rate}));
    set("rates", idx.map((j, k) => `${allLayers[j].material || "?"}: ${parts[k] && parts[k].rate !== null ? fmtNum(parts[k].rate, 2) : "–"}`).join("  ·  ") + " Å/s");
    const d = codepDoping(ms);
    const txt = dopingTexts(ms, d);
    set("dope", txt.cum);
    set("inst", txt.inst);
    set("note", parts.flatMap((p, k) => (p ? p.warns.map(w => (idx.length > 1 ? `${allLayers[idx[k]].material}: ` : "") + w) : [])).join(" · "));
    const done = idx.every(j => allLayers[j].ended_ms) && d.cum && !d.shared && idx.every((j, k) => parts[k] && parts[k].layerThk !== null);
    if (done) {
      d.cum.forEach((v, k) => { const cv = fmtNum(v, 2); if (allLayers[idx[k]].codep_cv !== cv) ctx.set(idx[k], {codep_cv: cv}); });
    }
  }
  function liveParts(l, rows, running, out) {
    const last = [...rows].reverse().find(r => num(r.thk_med) !== null) || null;
    const cur = rows[rows.length - 1];
    const rate = cur ? num(cur.rate_fit) : null;
    const startThk = num(l.start_thk);
    let layerThk = null;
    if (l.ended_ms && num(l.mon_diff) !== null) layerThk = num(l.mon_diff);
    else if (running && startThk !== null && last) layerThk = num(last.thk_med) - startThk;
    const notes = [], warns = [];
    const warn = t => { notes.push(t); warns.push(t); };
    if (l.ended_ms) {
      if (l.mon_diff) notes.push(`모니터 ${l.mon_diff} nm · 평균 ${l.avg_rate || "–"} Å/s · 끝 ${l.end_rate || "측정 중"} Å/s`);
      if (out.heatWait) notes.push(`열 영향 관찰 중 ${mmss(out.heatWait)}`);
      else if (l.heat === "1") warn(`열 영향 의심: 끝난 뒤 ${l.heat_delta} nm 감소`);
      else if (l.heat === "0") notes.push("끝난 뒤 두께 변화 없음");
    } else if (l.started_ms) {
      if (l.start_pending) notes.push("시작값 측정 중 (리셋 후 10초)");
      notes.push(l.det_ms ? `증착 시작 ${hms(l.det_ms)} · P ${l.det_power || "–"} · T ${l.det_temp || "–"}` : "증착 시작 대기 (rate 0.1 Å/s 이상 10초)");
    }
    const flags = rows.filter(r => r.flag && (!l.started_ms || r.ts * 1000 >= l.started_ms) && (!l.ended_ms || r.ts * 1000 <= l.ended_ms));
    const resets = flags.filter(r => r.flag === "reset").length, spikes = flags.filter(r => r.flag === "spike").length;
    if (resets) warn(`층 도중 리셋 ${resets}회 — 두께차 신뢰 불가`);
    if (spikes) notes.push(`스파이크 ${spikes}점 제외`);
    return {rate, layerThk, notes, warns};
  }
  function updateLive(box, l, rows, running, out, now) {
    if (!box) return;
    const set = (k, v) => { const el = box.querySelector(`[data-live="${k}"]`); if (el && el.textContent !== v) el.textContent = v; };
    const {rate, layerThk, notes} = liveParts(l, rows, running, out);
    set("rate", rate === null ? "측정 중" : fmtNum(rate, 2));
    set("thk", layerThk === null ? (l.started_ms && !l.start_thk ? "측정 중" : "–") : fmtNum(layerThk, 2));
    let eta = "–";
    const target = num(l.monitor);
    if (running && layerThk !== null && target !== null) {
      if (layerThk >= target) eta = "도달";
      else if (rate && rate > 0.02) eta = mmss((target - layerThk) * 10 / rate);
    }
    set("eta", eta);
    set("note", notes.join(" · "));
  }
  function watch(ctx, active) {
    clearInterval(timer);
    timer = null;
    if (!enabled()) return;
    curCtx = ctx; curActive = active;
    refresh(ctx);
    timer = setInterval(() => { if (active() && !document.hidden) refresh(ctx); }, 1000);
    if (typeof document !== "undefined" && !wakeBound) {
      wakeBound = true;
      const wake = () => { if (timer && !document.hidden) { for (const h of cache.values()) h.nextAt = 0; if (curActive()) refresh(curCtx); } };
      document.addEventListener("visibilitychange", wake);
      window.addEventListener("pageshow", wake);
    }
  }
  function stop() { clearInterval(timer); timer = null; }

  // Series for the xlsx extra sheet, thinned to at most `max` rows.
  // One series per started layer over [t0-3min, t1+3min], all in parallel, each retried once and capped at capMs. Returns {rows: [rows|null per item], failed}.
  async function layerSeries(items, capMs = 15000) {
    const one = async l => {
      const to = l.ended_ms ? Math.min(Date.now(), l.ended_ms + 180000) : Date.now();
      for (let a = 0; a < 2; a++) {
        const r = await Promise.race([series(l.sensor_port, l.started_ms - 180000, to).catch(() => null), new Promise(res => setTimeout(() => res(null), capMs))]);
        if (r) return r;
      }
      return null;
    };
    const rows = await Promise.all(items.map(one));
    return {rows, failed: rows.filter(r => !r).length};
  }
  async function series(port, fromMs, toMs, max = 600) {
    const rows = await range(port, fromMs, toMs);
    if (!rows) return null;
    const step = Math.max(1, Math.ceil(rows.length / max));
    return rows.filter((r, i) => i % step === 0 || r.flag);
  }

  root.VTEThick = {SOURCE_SENSOR, sensorFor, autoSensor, fillSensors, sensorWarning, sharedSensorNote, analyze, rowAt, codepDoping, dopingTexts, MEMBER_COLORS, SENSORS, enabled, url, KEY, getJson, live, range, snapshot, setTarget, clearTarget, healthBadge, series, layerSeries, watch, stop, refresh, drawChart, chartTitle, fmtNum};
})(typeof globalThis !== "undefined" ? globalThis : this);
