/*
 * VTE Log Manager core: parsing, calibration, and workbook layouts shared by the desktop app and the mobile PWA.
 * No DOM, no file system. Every reader takes the sheet as an array of rows (SheetJS `header: 1`, `defval: null`).
 * Loads as a classic browser script (window.VTECore) or as a CommonJS module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VTECore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ORGANIC_PORTS = Array.from({length: 9}, (_, i) => `O-${i + 1}`);
  const METAL_PORTS = ["M-1", "M-2", "M-3"];
  const ALL_PORTS = [...ORGANIC_PORTS, ...METAL_PORTS];
  const MASKS = ["1", "2", "3"];
  const LOG_COLUMN_WIDTHS = [20, 9, 22, 20, 14, 12, 15, 11, 15, 18, 30, 8, 14, 14, 12, 12, 16, 12, 16, 18, 20, 20];
  const STRUCTURE_KEYS = ["mode", "mat1", "src1", "tf1", "vol1", "mat2", "src2", "tf2", "vol2", "mat3", "src3", "tf3", "vol3", "thick", "rate", "mask"];
  const STRUCTURE_DEFAULTS = {mode: "single", mat1: "", src1: "", tf1: "", vol1: "100", mat2: "", src2: "", tf2: "", vol2: "", mat3: "", src3: "", tf3: "", vol3: "", thick: "", rate: "", mask: "1"};

  // ---------- values ----------
  function toFloat(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const text = String(value).trim().replaceAll(",", "");
    if (!text) return null;
    const m = text.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }
  function fmt(value, ndigits = 4) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value !== "number") {
      const n = toFloat(value);
      if (n === null || String(value).trim() !== String(n)) return String(value);
      value = n;
    }
    return Number(value).toFixed(ndigits).replace(/\.?0+$/, "");
  }
  function dateStrFromName(filename, relPath = "") {
    const base = filename.replace(/\.[^.]+$/, "");
    let m = base.match(/(\d{6})/);
    if (m) return m[1];
    m = relPath.match(/(?:^|\/)(\d{6})(?:\/|$)/);
    if (m) return m[1];
    return "";
  }
  function splitPair(value) {
    const text = String(value || "").trim();
    if (!text) return ["", ""];
    const parts = text.split(/\s*(?:\/|,|→|->|~)\s*/, 2);
    return parts.length === 1 ? [parts[0].trim(), parts[0].trim()] : [parts[0].trim(), parts[1].trim()];
  }
  function pressureX1e7(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (/x10|e-/i.test(text)) return text;
    return `${text}x10-7`;
  }
  function sameNumeric(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    const av = toFloat(a), bv = toFloat(b);
    if (av === null || bv === null) return String(a).trim() === String(b).trim();
    return Math.abs(av - bv) <= 1e-9;
  }
  function parseDateKey(s) {
    const text = String(s || "").trim();
    let y, m, d;
    if (/^\d{6}$/.test(text)) {
      y = 2000 + Number(text.slice(0, 2)); m = Number(text.slice(2, 4)); d = Number(text.slice(4, 6));
    } else {
      const mt = text.match(/(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})/);
      if (!mt) return null;
      y = Number(mt[1]); m = Number(mt[2]); d = Number(mt[3]);
    }
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : dt.getTime();
  }
  function displayDate(yymmdd) {
    return /^\d{6}$/.test(yymmdd) ? `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}` : yymmdd;
  }
  function safeSheetTitle(text) {
    return String(text || "Sheet1").replace(/[\[\]:*?/\\]/g, "_").slice(0, 31) || "Sheet1";
  }
  function calcRequiredMonitor(targetActual, ratio) {
    const target = toFloat(targetActual), r = toFloat(ratio);
    return target === null || !r ? null : target / r;
  }
  function calcMonitorRate(actualRate, ratio) {
    const rate = toFloat(actualRate), r = toFloat(ratio);
    return rate === null || !r ? null : rate / r;
  }
  function getCell(row, idx) { return row && row[idx] !== undefined ? row[idx] : null; }
  function norm(v) { return v === null || v === undefined ? "" : String(v).trim().toLowerCase(); }
  function currentYYMMDD(d = new Date()) {
    return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  }

  // Same shaping the v10 reader applied per call: optional row limit, then pad/trim every row to maxCols.
  function shapeRows(rows, maxRows = null, maxCols = null) {
    let out = rows || [];
    if (maxRows) out = out.slice(0, maxRows);
    if (maxCols) out = out.map(r => Array.from({length: maxCols}, (_, i) => (r || [])[i] ?? null));
    return out;
  }

  // ---------- process logs ----------
  function parseProcessRows(rawRows) {
    const rows = shapeRows(rawRows, null, 24);
    const material_list = [];
    const layers = {};
    let currentMat = null;
    let pending = null;
    let sequence = 0;
    for (const row0 of rows) {
      const values = Array.from({length: 24}, (_, i) => row0[i] ?? null);
      const [a, b] = [values[0], values[1]];
      const d = values[3];
      let skip = false;
      if (typeof a === "string" && a.trim() && !a.toLowerCase().includes("tooling") && !a.toLowerCase().includes("tooing") && typeof b === "string" && (/^O-|^M-/.test(b))) {
        if (!material_list.some(x => x.material === a.trim())) material_list.push({material: a.trim(), port: b.trim()});
      }
      if (typeof d === "string") {
        const label = d.trim(), low = label.toLowerCase();
        if (!label || low.includes("pressure") || low.includes("material") || low.includes("layer") || low.includes("log type") || label.includes("재료")) skip = true;
        else { currentMat = label; if (!layers[currentMat]) layers[currentMat] = []; }
      }
      const pressure = values[4], power = values[5], temp = values[6], rate = values[7], monitor = values[8];
      const actual = toFloat(values[9]);
      const notes = values[10] ?? (typeof values[9] === "string" ? values[9] : null);
      const item = {
        pressure, power, temp, rate,
        monitor_thickness: monitor,
        actual_thickness: actual,
        notes,
        mask: values[11],
        start_pressure: values[12] || pressure,
        end_pressure: values[13],
        start_power: values[14] || power,
        end_power: values[15],
        ratio: toFloat(values[16]),
        tooling_factor: values[17],
        target_actual: values[18],
        required_monitor: values[19] ?? (norm(monitor) === "start" ? null : monitor),
        sequence: sequence++,
        port: b,
        start_temp: values[20] || temp,
        end_temp: values[21]
      };
      const hasData = values.slice(4, 22).some(v => v !== null && v !== "");
      // Only join an adjacent end row to an explicit v9+ start row.
      const isStart = norm(monitor) === "start" && values.slice(11, 22).some(v => v !== null && v !== "");
      const isEnd = pending && !skip && currentMat === pending.material &&
        norm(monitor) !== "start" && values.slice(11, 22).every(v => v === null || v === "") &&
        (d === null || norm(d) === norm(pending.material)) && hasData;
      if (isEnd) {
        const start = pending.item;
        start.monitor_thickness = monitor;
        start.end_pressure ??= pressure;
        start.end_power ??= power;
        start.end_temp ??= temp;
        // The generated tooling end row contains the target, not a measurement.
        if (notes && !String(notes).startsWith("Monitor target from ratio ")) {
          start.notes = [start.notes, notes].filter(Boolean).join(" / ");
        }
        pending = null;
        continue;
      }
      pending = null;
      if (!skip && currentMat && hasData) {
        layers[currentMat].push(item);
        if (isStart) pending = {material: currentMat, item};
      }
    }
    return {material_list, layers};
  }

  // ---------- calibration ----------
  function updateMeasurementHeaderMap(headerMap, row, monitorWordMatches = false) {
    row.forEach((cell, cidx) => {
      if (cidx < 3) return;
      const text = norm(cell);
      if (!text) return;
      if ((text.includes("pressure") || text.includes("진공")) && !text.includes("start") && !text.includes("end")) headerMap.pressure = cidx;
      else if ((text.includes("power") || text.includes("파워")) && !text.includes("start") && !text.includes("end")) headerMap.power = cidx;
      else if (text.includes("temperature") || text.includes("temp") || text.includes("온도")) headerMap.temp = cidx;
      else if (text.includes("rate") || text.includes("속도")) headerMap.rate = cidx;
      else if ((text.includes("actual") || text.includes("실제")) && (text.includes("thick") || text.includes("두께"))) headerMap.actual_thickness = cidx;
      else if ((text.includes("thickness") || text.includes("두께") || (monitorWordMatches && text.includes("monitor"))) && !text.includes("actual") && !text.includes("실제")) headerMap.monitor_thickness = cidx;
    });
  }
  function rowHasDepositionContext(row, headerMap) {
    for (const key of ["pressure", "power"]) {
      const col = headerMap[key];
      if (col !== undefined && row[col] !== null && row[col] !== "") return true;
    }
    return false;
  }
  function measurementFromRow(row, headerMap, meta) {
    const mc = headerMap.monitor_thickness, ac = headerMap.actual_thickness;
    if (mc === undefined || ac === undefined) return null;
    const monitor = toFloat(row[mc]), actual = toFloat(row[ac]);
    if (monitor === null || monitor === 0 || actual === null) return null;
    if (!rowHasDepositionContext(row, headerMap)) return null;
    const item = {...meta, monitor_thickness: monitor, actual_thickness: actual, ratio: actual / monitor};
    for (const key of ["pressure", "power", "temp", "rate"]) {
      const col = headerMap[key];
      if (col !== undefined && row[col] !== null && row[col] !== "") item[key] = row[col];
    }
    return item;
  }
  // Process_Tooling logs in the manager layout (D=Layer, E..J measurements, header anywhere, many materials).
  function findMeasurementHeader(rows) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || [];
      if (norm(getCell(row, 3)) === "layer" && row.some((cell, c) => c >= 4 && norm(cell).includes("pressure") && !norm(cell).includes("start"))) return i;
    }
    return -1;
  }
  function pickCoValue(value, idx, count) {
    if (count <= 1 || value === null || value === undefined) return value;
    const parts = String(value).split("/").map(s => s.trim());
    return parts.length === count ? parts[idx] : value;
  }
  function fileDate(file) {
    return file.dateStr || dateStrFromName(file.name, file.relPath);
  }
  function emptyCalibrationMeta(file) {
    return {date: fileDate(file), relPath: file.relPath, fileName: file.name, handle: file.handle,
      source: null, density: null, acoustic_imp: null, tooling_factor: null, monitor_thickness: null, actual_thickness: null, ratio: null,
      pressure: null, power: null, temp: null, rate: null, notes: null};
  }
  // Returns null when the sheet is not in the layered manager layout.
  function layeredToolingMeasurements(rawRows, file) {
    const rows = shapeRows(rawRows, null, 24);
    const hdr = findMeasurementHeader(rows);
    if (hdr < 0) return null;
    const want = norm(file.material);
    const ports = new Map(), tfs = new Map();
    rows.slice(0, hdr).forEach(row => {
      const a = getCell(row, 0), b = getCell(row, 1);
      if (typeof a !== "string" || !a.trim()) return;
      const low = a.toLowerCase();
      if (low.includes("tooling factor") || low.includes("tooing factor")) tfs.set(norm(a.replace(/\s*too(l)?ing factor.*$/i, "")), b);
      else if (typeof b === "string" && /^[OM]-\d+/i.test(b.trim())) { if (!ports.has(norm(a))) ports.set(norm(a), b.trim()); }
    });
    const date = fileDate(file);
    const out = [], seen = new Set();
    let label = null;
    for (let i = hdr + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const d = getCell(row, 3);
      if (typeof d === "string" && d.trim()) label = d.trim();
      if (!label) continue;
      const parts = label.split(":").map(norm);
      const idx = parts.indexOf(want);
      if (idx < 0) continue;
      const pick = v => pickCoValue(v, idx, parts.length);
      let monitorCell, pairedRun = false;
      if (norm(getCell(row, 8)) === "start") {
        // Start row: measured actual is on this row (J); the paired end row holds the monitor thickness (I).
        // The end row's J is the target actual written by v9, never a measurement.
        const next = rows[i + 1] || [];
        const nextLabel = getCell(next, 3);
        const nextIsEnd = (nextLabel === null || nextLabel === "" || norm(nextLabel) === norm(label)) &&
          norm(getCell(next, 8)) !== "start" && next.slice(11, 22).every(v => v === null || v === "");
        if (!nextIsEnd) continue;
        monitorCell = getCell(next, 8);
        pairedRun = true;
        i++;
      } else {
        monitorCell = getCell(row, 8);
      }
      const monitor = toFloat(pick(monitorCell));
      if (monitor === null || monitor === 0) continue;
      const actual = toFloat(pick(getCell(row, 9)));
      // Ramp rows of converted tooling sheets are only calibration points when an actual thickness was measured.
      if (!pairedRun && actual === null) continue;
      const item = {
        date, relPath: file.relPath, fileName: file.name, handle: file.handle, material: file.material,
        source: (typeof getCell(row, 1) === "string" && getCell(row, 1).trim()) || ports.get(want) || null,
        density: null, acoustic_imp: null,
        tooling_factor: pick(getCell(row, 17)) ?? tfs.get(want) ?? null,
        monitor_thickness: monitor,
        actual_thickness: actual,
        ratio: actual !== null ? actual / monitor : null,
        pressure: pick(getCell(row, 4)), power: pick(getCell(row, 5)), temp: pick(getCell(row, 6)), rate: pick(getCell(row, 7)),
        notes: actual === null ? "실측 없음 (툴링 증착 기록만 있음)" : getCell(row, 10)
      };
      const marker = [item.source, fmt(item.tooling_factor), fmt(monitor, 6), fmt(actual, 6), item.rate, item.power, item.pressure].join("|");
      if (!seen.has(marker)) { seen.add(marker); out.push(item); }
    }
    return out;
  }
  function latestOf(items) {
    const measured = items.filter(m => m.ratio !== null && m.ratio !== 0);
    return measured.length ? measured[measured.length - 1] : (items.length ? items[items.length - 1] : null);
  }
  // Single-material tooling sheets and Calibration/ files (label/value pairs in A/B, one measurement table).
  function legacyCalibrationMeta(rawRows, file) {
    const meta = emptyCalibrationMeta(file);
    const rows = shapeRows(rawRows, 80, 20);
    const headerMap = {};
    rows.forEach((row, ridx) => {
      const label = norm(getCell(row, 0));
      const value = getCell(row, 1);
      if ((meta.source === null || meta.source === "") && typeof getCell(row, 0) === "string" && typeof value === "string" && /^[OM]-\d+/i.test(value.trim())) meta.source = value.trim();
      if (label.includes("density")) meta.density = value;
      else if (label.includes("acoustic") || label.includes("impedance")) meta.acoustic_imp = value;
      else if (label.includes("tooling") || label.startsWith("too")) meta.tooling_factor = value;
      else if (label.includes("source")) meta.source = value;
      else if (label.includes("monitor") && label.includes("thick")) meta.monitor_thickness = toFloat(value);
      else if ((label.includes("actual") || label.includes("실제")) && (label.includes("thick") || label.includes("두께"))) meta.actual_thickness = toFloat(value);
      else if (label.includes("ratio") || label.includes("비율")) meta.ratio = toFloat(value);
      else if (label.includes("notes") || label.includes("비고")) meta.notes = value;
      if (ridx < 8) updateMeasurementHeaderMap(headerMap, row);
    });
    Object.assign(headerMap, {
      pressure: headerMap.pressure ?? 3,
      power: headerMap.power ?? 4,
      temp: headerMap.temp ?? 5,
      rate: headerMap.rate ?? 6,
      monitor_thickness: headerMap.monitor_thickness ?? 7,
      actual_thickness: headerMap.actual_thickness ?? 9
    });
    let last = null;
    for (const row of rows.slice(1)) {
      const item = measurementFromRow(row, headerMap, meta);
      if (item) last = item;
    }
    if (last) {
      for (const [k, v] of Object.entries(last)) if (meta[k] === null || meta[k] === "") meta[k] = v;
    }
    if (meta.ratio === null && meta.monitor_thickness && meta.actual_thickness !== null) meta.ratio = meta.actual_thickness / meta.monitor_thickness;
    return meta;
  }
  function legacyCalibrationMeasurements(rawRows, meta) {
    const rows = shapeRows(rawRows, 120, 20);
    const headerMap = {pressure: 3, power: 4, temp: 5, rate: 6, monitor_thickness: 7, actual_thickness: 9};
    rows.slice(0, 8).forEach(row => updateMeasurementHeaderMap(headerMap, row, true));
    const out = [], seen = new Set();
    for (const row of rows.slice(1)) {
      const item = measurementFromRow(row, headerMap, meta);
      if (!item) continue;
      const marker = [item.date, fmt(item.monitor_thickness, 6), fmt(item.actual_thickness, 6), item.rate, item.power].join("|");
      if (!seen.has(marker)) { seen.add(marker); out.push(item); }
    }
    return out.length ? out : (meta.ratio ? [meta] : []);
  }
  // Latest meta for one file. `rows` null means the file could not be read.
  function calibrationMetaFromRows(rows, file) {
    if (rows === null) return emptyCalibrationMeta(file);
    const layered = layeredToolingMeasurements(rows, file);
    if (layered) return latestOf(layered) || emptyCalibrationMeta(file);
    return legacyCalibrationMeta(rows, file);
  }
  function calibrationMeasurementsFromRows(rows, file) {
    if (rows === null) return [];
    const layered = layeredToolingMeasurements(rows, file);
    if (layered) return layered;
    return legacyCalibrationMeasurements(rows, legacyCalibrationMeta(rows, file));
  }
  // Filters one file's measurements by source/TF. `measured` is the newest measured entry in that file.
  function matchCalibration(items, source = null, toolingFactor = null) {
    const sourceNorm = source ? String(source).trim().toUpperCase() : "";
    const tfFilter = toolingFactor !== null && toolingFactor !== "" ? String(toolingFactor).trim() : "";
    const matched = items.filter(meta =>
      (!sourceNorm || String(meta.source || "").trim().toUpperCase() === sourceNorm) &&
      (!tfFilter || sameNumeric(meta.tooling_factor, tfFilter)));
    const measured = matched.filter(meta => meta.ratio !== null && meta.ratio !== 0);
    return {
      measured: measured.length ? measured[measured.length - 1] : null,
      withToolingFactor: matched.find(meta => meta.tooling_factor !== null) || null
    };
  }
  function noCalibration(source = null) {
    const sourceNorm = source ? String(source).trim().toUpperCase() : "";
    return {date: "", source: sourceNorm || null, tooling_factor: null, monitor_thickness: null, actual_thickness: null, ratio: null};
  }
  function comboLabel(material, toolingFactor, source) {
    return [material, fmt(toolingFactor), source || ""].map(v => String(v || "").trim()).filter(Boolean).join("_");
  }
  // Keeps the best entry per material_TF_source label. A measured ratio beats an unmeasured run; otherwise newest wins.
  function mergeComboOption(best, material, meta, fileDateStr) {
    const label = comboLabel(material, meta.tooling_factor, meta.source);
    if (!label) return;
    const existing = best.get(label);
    const dateKey = parseDateKey(meta.date || fileDateStr) || 0;
    const hasRatio = meta.ratio !== null && meta.ratio !== 0;
    const existingHasRatio = existing && existing.ratio !== null && existing.ratio !== 0;
    if (!existing || (hasRatio && !existingHasRatio) || (hasRatio === existingHasRatio && dateKey >= (existing.dateKey || 0))) {
      best.set(label, {...meta, material, label, dateKey});
    }
  }

  // ---------- indexes (mobile; the desktop builds the same from directory handles) ----------
  const LOG_ROOTS = {Process_General: "일반증착", Process_Tooling: "툴링"};
  /*
   * `files`: [{relPath, name}] with relPath relative to the VTE_MANAGER folder ("Process_General/2026/260904/x.xlsx").
   * Returns logs shaped like the desktop's state.logs (newest first) and Calibration/<material>/<file>.xlsx entries.
   */
  function buildFileIndex(files) {
    const logs = [], calibrationFiles = [];
    for (const f of files) {
      if (!/\.xlsx$/i.test(f.name) || f.name.startsWith(".") || f.name.startsWith("~$")) continue;
      const parts = f.relPath.split("/");
      if (parts.some(p => p.startsWith(".") || p.startsWith("~$"))) continue;
      const root = parts[0];
      if (LOG_ROOTS[root] && parts.length >= 2) {
        const dateStr = dateStrFromName(f.name, parts.slice(1).join("/"));
        logs.push({...f, filename: f.name, type: LOG_ROOTS[root], root, dateStr, dateKey: parseDateKey(dateStr)});
      } else if (root === "Calibration" && parts.length === 3) {
        calibrationFiles.push({...f, material: parts[1], dateStr: dateStrFromName(f.name, f.relPath)});
      }
    }
    const byPath = (a, b) => a.relPath.localeCompare(b.relPath);
    logs.sort((a, b) => ((b.dateKey || 0) - (a.dateKey || 0)) || byPath(a, b));
    calibrationFiles.sort(byPath);
    return {logs, calibrationFiles};
  }
  /*
   * Materials and their calibration sources, matching the desktop scan: every Calibration/<material> folder plus every
   * material listed in a tooling log. `toolingMaterials(log)` returns that log's material_list.
   */
  function buildCalibrationIndex(logs, calibrationFiles, toolingMaterials) {
    const byMaterial = new Map();
    const names = new Set();
    for (const f of calibrationFiles) {
      names.add(f.material);
      if (!byMaterial.has(f.material)) byMaterial.set(f.material, []);
      byMaterial.get(f.material).push(f);
    }
    for (const log of logs.filter(l => l.type === "툴링")) {
      for (const item of toolingMaterials(log) || []) {
        if (!item.material) continue;
        names.add(item.material);
        const arr = byMaterial.get(item.material) || [];
        if (!arr.some(x => x.relPath === log.relPath)) arr.push({...log, material: item.material, dateStr: log.dateStr});
        byMaterial.set(item.material, arr);
      }
    }
    for (const files of byMaterial.values()) {
      files.sort((a, b) => ((parseDateKey(b.dateStr) || 0) - (parseDateKey(a.dateStr) || 0)) || a.relPath.localeCompare(b.relPath));
    }
    return {materials: [...names].sort((a, b) => a.localeCompare(b, "en", {sensitivity: "base"})), filesByMaterial: byMaterial};
  }

  // ---------- writers ----------
  function setAoa(aoa, r, c, v) {
    while (aoa.length <= r) aoa.push([]);
    aoa[r][c] = v;
  }
  /*
   * Process log sheet. `layers`: editor rows {material, port, mask, target_actual, required_monitor, measured_actual,
   * ratio, tooling_factor, rate, source_temp_pair, pressure_pair, power_pair, notes}.
   * Returns {aoa, cols, sheetTitle, fileName}.
   */
  // Extra columns start at W (index 22): parsers and calibration readers never look there.
  const EXTRA_COL = 22;
  function buildProcessLogSheet({isTooling, layers, memo = "", version = "v11", meta = null, timeTag = ""}) {
    const aoa = [];
    setAoa(aoa, 0, 3, "Log Type");
    setAoa(aoa, 0, 4, isTooling ? "Tooling" : "General Deposition");
    layers.forEach((row, i) => {
      setAoa(aoa, i, 0, row.material.trim());
      setAoa(aoa, i, 1, row.port);
    });
    const tfRow = layers.length + 1;
    layers.forEach((row, idx) => {
      const mat = row.material.trim();
      if (row.tooling_factor) {
        setAoa(aoa, tfRow + idx, 0, `${mat} Tooling Factor`);
        setAoa(aoa, tfRow + idx, 1, toFloat(row.tooling_factor) ?? row.tooling_factor);
      }
      if (row.ratio) {
        setAoa(aoa, tfRow + idx, 2, `${mat} Ratio(actual/monitor)`);
        setAoa(aoa, tfRow + idx, 3, toFloat(row.ratio) ?? row.ratio);
      }
    });
    const hdrRow = tfRow + layers.length + 2;
    const headers = {
      0: "Material", 1: "Source", 3: "Layer", 4: "Pressure (Torr)", 5: "Power Meter",
      6: "Temperature (C)", 7: "Rate (A/s)", 8: "Thickness (nm)",
      9: isTooling ? "Actual Thickness (nm)" : "", 10: "Notes", 11: "Mask",
      12: "Start Pressure", 13: "End Pressure", 14: "Start Power", 15: "End Power",
      16: "Calibration Ratio", 17: "Tooling Factor", 18: "Target Actual (nm)", 19: "Required Monitor (nm)",
      20: "Start Temperature (C)", 21: "End Temperature (C)"
    };
    Object.entries(headers).forEach(([c, v]) => setAoa(aoa, hdrRow, Number(c), v));
    const hasTimes = layers.some(r => r.started_at || r.ended_at);
    if (hasTimes) setAoa(aoa, hdrRow, EXTRA_COL, "Time (start row / end row)");
    if (layers.some(r => r.codep_group)) setAoa(aoa, hdrRow, CODEP_COL, "Co-dep (group vol%)");
    if (meta) {
      Object.entries(meta).filter(([, v]) => v !== null && v !== undefined && v !== "").forEach(([k, v], i) => {
        setAoa(aoa, 0, EXTRA_COL + i * 2, k);
        setAoa(aoa, 0, EXTRA_COL + i * 2 + 1, v);
      });
    }
    const memoText = String(memo || "").trim();
    let dataRow = hdrRow + 1;
    for (const row of layers) {
      const mat = row.material.trim();
      const ratio = toFloat(row.ratio);
      const target = toFloat(row.target_actual);
      let req = toFloat(row.required_monitor);
      if (req === null) req = calcRequiredMonitor(target, ratio);
      // Phone drafts pass start/end separately, so a "~" or "," typed inside one value is never split.
      const pair = (key, pairKey) => (row[`${key}_start`] !== undefined ? [str(row[`${key}_start`]), str(row[`${key}_end`])] : splitPair(row[pairKey]));
      const [spRaw, epRaw] = pair("pressure", "pressure_pair");
      const [sp, ep] = [pressureX1e7(spRaw), pressureX1e7(epRaw)];
      const [startPower, endPower] = pair("power", "power_pair");
      const [startTemp, endTemp] = pair("temp", "source_temp_pair");
      const noteParts = [];
      if (row.notes.trim()) noteParts.push(row.notes.trim());
      if (memoText) noteParts.push(memoText);
      setAoa(aoa, dataRow, 0, mat);
      setAoa(aoa, dataRow, 1, row.port);
      setAoa(aoa, dataRow, 3, mat);
      setAoa(aoa, dataRow, 4, sp);
      setAoa(aoa, dataRow, 5, toFloat(startPower) ?? startPower);
      setAoa(aoa, dataRow, 6, toFloat(startTemp) ?? startTemp);
      setAoa(aoa, dataRow, 7, toFloat(row.rate) ?? row.rate.trim());
      setAoa(aoa, dataRow, 8, "Start");
      if (isTooling) setAoa(aoa, dataRow, 9, toFloat(row.measured_actual) ?? row.measured_actual.trim());
      setAoa(aoa, dataRow, 10, noteParts.join(" / "));
      setAoa(aoa, dataRow, 11, row.mask);
      setAoa(aoa, dataRow, 12, sp);
      setAoa(aoa, dataRow, 13, ep);
      setAoa(aoa, dataRow, 14, startPower);
      setAoa(aoa, dataRow, 15, endPower);
      setAoa(aoa, dataRow, 16, ratio);
      setAoa(aoa, dataRow, 17, toFloat(row.tooling_factor) ?? row.tooling_factor.trim());
      setAoa(aoa, dataRow, 18, target);
      setAoa(aoa, dataRow, 19, req);
      setAoa(aoa, dataRow, 20, toFloat(startTemp) ?? startTemp);
      setAoa(aoa, dataRow, 21, toFloat(endTemp) ?? endTemp);
      setAoa(aoa, dataRow + 1, 3, mat);
      setAoa(aoa, dataRow + 1, 4, ep);
      setAoa(aoa, dataRow + 1, 5, toFloat(endPower) ?? endPower);
      setAoa(aoa, dataRow + 1, 6, toFloat(endTemp) ?? endTemp);
      // Mobile drafts record the rate at the end separately; desktop rows have one rate for both.
      const endRate = row.end_rate ? row.end_rate : row.rate;
      setAoa(aoa, dataRow + 1, 7, toFloat(endRate) ?? String(endRate).trim());
      setAoa(aoa, dataRow + 1, 8, req);
      setAoa(aoa, dataRow + 1, 10, ratio ? `Monitor target from ratio ${ratio}` : "");
      if (row.started_at) setAoa(aoa, dataRow, EXTRA_COL, row.started_at);
      if (row.codep_group) setAoa(aoa, dataRow, CODEP_COL, `co-dep ${row.codep_group} ${row.codep_vol}`);
      if (row.ended_at) setAoa(aoa, dataRow + 1, EXTRA_COL, row.ended_at);
      dataRow += 3;
    }
    const kind = isTooling ? "tooling" : "general";
    return {
      aoa,
      cols: LOG_COLUMN_WIDTHS,
      sheetTitle: safeSheetTitle(`${isTooling ? "Tooling" : "General"} ${version}`),
      fileName: layers.map(r => r.material.trim()).join(", ") + `_${kind}_${version}${timeTag ? `_${timeTag}` : ""}.xlsx`
    };
  }
  function processLogFolder(isTooling, yymmdd) {
    return [isTooling ? "Process_Tooling" : "Process_General", `20${yymmdd.slice(0, 2)}`, yymmdd];
  }
  // ---------- mobile drafts ----------
  // A draft layer keeps start/end values separately; the sheet writer takes the desktop editor's "start/end" pairs.
  // start_rate/end_rate are measured; target_rate is the planned actual rate from a preset (reference only).
  const DRAFT_LAYER_DEFAULTS = {material: "", port: "", tooling_factor: "", ratio: "", mask: "1", target_actual: "", monitor: "", target_rate: "", start_rate: "", end_rate: "",
    start_pressure: "", start_power: "", start_temp: "", started_at: "", end_pressure: "", end_power: "", end_temp: "", ended_at: "",
    measured_actual: "", notes: "", codep: "", vol: "", codep_total: ""};
  // Co-deposition: one layer per material sharing a `codep` id. The file keeps one row pair per material (readable by the desktop app)
  // plus a "co-dep <group> <vol%>" marker in column X of the start row and a notes tag, so the phone can regroup them.
  const CODEP_COL = EXTRA_COL + 1;
  const CODEP_NOTE = /^co-dep .+? \([\d.]+ vol%\)(?: \/ )?/;
  function codepGroups(layers) {
    const groups = new Map();
    layers.forEach(l => { if (str(l.codep)) (groups.get(l.codep) || groups.set(l.codep, []).get(l.codep)).push(l); });
    return groups;
  }
  // Each member's target thickness is its volume share of the group total.
  function codepShare(members, member) {
    const vols = members.map(m => toFloat(m.vol) ?? 0), sum = vols.reduce((a, b) => a + b, 0);
    const total = toFloat(member.codep_total);
    if (total === null || !sum) return "";
    return fmt(total * (toFloat(member.vol) ?? 0) / sum, 4);
  }
  const str = v => (v === null || v === undefined ? "" : String(v).trim());
  const joinPair = (a, b) => (str(a) || str(b) ? `${str(a)}/${str(b)}` : "");
  // Editor rows carrying `codep`/`vol` get the file marker and the notes tag (phone drafts and desktop edits of phone logs).
  function tagCodepRows(rows) {
    const groups = codepGroups(rows);
    const ids = [...groups.keys()];
    return rows.map(row => {
      const members = str(row.codep) ? groups.get(row.codep) : null;
      if (!members || members.length < 2) return row;
      const vol = fmt(toFloat(row.vol) ?? 0, 2);
      const tag = `co-dep ${members.map(m => str(m.material)).join(":")} (${vol} vol%)`;
      return {...row, codep_group: ids.indexOf(row.codep) + 1, codep_vol: vol, notes: [tag, str(row.notes)].filter(Boolean).join(" / ")};
    });
  }
  function draftLayersToEditorRows(layers) {
    return tagCodepRows(layers.map(l => ({...draftLayerToEditorRow(l), codep: str(l.codep), vol: str(l.vol)})));
  }
  function draftLayerToEditorRow(l) {
    return {
      material: str(l.material), port: str(l.port), mask: str(l.mask) || "1", notes: str(l.notes),
      target_actual: str(l.target_actual), required_monitor: str(l.monitor), measured_actual: str(l.measured_actual),
      ratio: str(l.ratio), tooling_factor: str(l.tooling_factor), rate: str(l.start_rate || l.rate), end_rate: str(l.end_rate),
      pressure_pair: joinPair(l.start_pressure, l.end_pressure), power_pair: joinPair(l.start_power, l.end_power),
      source_temp_pair: joinPair(l.start_temp, l.end_temp),
      pressure_start: str(l.start_pressure), pressure_end: str(l.end_pressure), power_start: str(l.start_power), power_end: str(l.end_power),
      temp_start: str(l.start_temp), temp_end: str(l.end_temp), started_at: str(l.started_at), ended_at: str(l.ended_at)
    };
  }
  // name=value pairs written across row 1 from column W.
  function readSheetMeta(rawRows) {
    const row = (rawRows || [])[0] || [];
    const meta = {};
    for (let c = EXTRA_COL; c + 1 < row.length; c += 2) if (row[c] !== null && row[c] !== undefined && row[c] !== "") meta[String(row[c])] = row[c + 1];
    return meta;
  }
  // Editable draft layers from an existing process log (manager layout). `sequence` is the sheet row index.
  function draftLayersFromRows(rawRows) {
    const rows = rawRows || [];
    const parsed = parseProcessRows(rows);
    const ports = new Map(parsed.material_list.map(m => [m.material, m.port]));
    const layers = Object.entries(parsed.layers)
      .flatMap(([material, items]) => items.map(item => ({material, item})))
      .sort((a, b) => a.item.sequence - b.item.sequence)
      .filter(({item}) => norm(item.monitor_thickness) === "start" || item.target_actual !== null || item.required_monitor !== null || item.mask)
      .map(({material, item}) => {
        const start = rows[item.sequence] || [], end = rows[item.sequence + 1] || [];
        const paired = norm(start[8]) === "start";
        const co = /^co-dep\s+(\S+)\s+([\d.]+)/.exec(str(start[CODEP_COL]));
        return {...DRAFT_LAYER_DEFAULTS,
          codep: co ? `f${co[1]}` : "", vol: co ? co[2] : "",
          material, port: str(item.port || ports.get(material)), mask: str(item.mask) || "1", notes: co ? str(item.notes).replace(CODEP_NOTE, "") : str(item.notes),
          tooling_factor: str(item.tooling_factor), ratio: item.ratio === null ? "" : String(item.ratio),
          start_rate: str(start[7] ?? item.rate), end_rate: paired ? str(end[7]) : "",
          target_actual: str(item.target_actual), monitor: str(item.required_monitor ?? (norm(item.monitor_thickness) === "start" ? "" : item.monitor_thickness)),
          measured_actual: item.actual_thickness === null ? "" : String(item.actual_thickness),
          start_pressure: str(item.start_pressure), end_pressure: str(item.end_pressure),
          start_power: str(item.start_power), end_power: str(item.end_power),
          start_temp: str(item.start_temp), end_temp: str(item.end_temp),
          started_at: str(start[EXTRA_COL]), ended_at: paired ? str(end[EXTRA_COL]) : ""};
      });
    for (const members of codepGroups(layers).values()) {
      const total = members.reduce((sum, m) => sum + (toFloat(m.target_actual) ?? 0), 0);
      members.forEach(m => { m.codep_total = total ? fmt(total, 4) : ""; });
    }
    return layers;
  }
  // Presets use the Structure layout. Co-deposition rows become one layer per material with its share of thickness and rate.
  function presetToDraftLayers(structureRows) {
    const layers = [];
    structureRows.forEach((row, rowIndex) => {
      const mats = [1, 2, 3].map(n => ({mat: str(row[`mat${n}`]), src: str(row[`src${n}`]), tf: str(row[`tf${n}`]), vol: toFloat(row[`vol${n}`])})).filter(m => m.mat);
      if (!mats.length) return;
      const used = str(row.mode) === "co-dep" ? mats : [{...mats[0], vol: 100}];
      const total = used.reduce((sum, m) => sum + (m.vol ?? 0), 0) || 100;
      const thick = toFloat(row.thick), rate = toFloat(row.rate);
      const co = used.length > 1;
      for (const m of used) {
        const share = co ? (m.vol ?? 0) / total : 1;
        layers.push({...DRAFT_LAYER_DEFAULTS, material: m.mat, port: m.src, tooling_factor: m.tf, mask: str(row.mask) || "1",
          target_actual: thick === null ? "" : fmt(thick * share, 4), target_rate: rate === null ? "" : fmt(rate * share, 4),
          codep: co ? `p${rowIndex + 1}` : "", vol: co ? fmt(m.vol ?? 0, 2) : "", codep_total: co && thick !== null ? fmt(thick, 4) : ""});
      }
    });
    return layers;
  }
  function draftLayersToPresetRows(layers) {
    const rows = [];
    let lastCodep = null;
    for (const l of layers.filter(x => str(x.material))) {
      const rate = str(l.target_rate || l.start_rate || l.rate);
      if (str(l.codep) && lastCodep && lastCodep.id === l.codep && lastCodep.n < 3) {
        const row = lastCodep.row, n = ++lastCodep.n;
        Object.assign(row, {[`mat${n}`]: str(l.material), [`src${n}`]: str(l.port), [`tf${n}`]: str(l.tooling_factor), [`vol${n}`]: str(l.vol)});
        const sum = (toFloat(row.rate) ?? 0) + (toFloat(rate) ?? 0);
        row.rate = sum ? fmt(sum, 4) : row.rate;
        continue;
      }
      const row = {...STRUCTURE_DEFAULTS, mode: str(l.codep) ? "co-dep" : "single", mat1: str(l.material), src1: str(l.port), tf1: str(l.tooling_factor),
        vol1: str(l.codep) ? str(l.vol) : "100", thick: str(l.codep) ? str(l.codep_total || l.target_actual) : str(l.target_actual), rate, mask: str(l.mask) || "1"};
      rows.push(row);
      lastCodep = str(l.codep) ? {id: l.codep, row, n: 1} : null;
    }
    // A "group" of one material is just a single layer.
    return rows.map(r => (r.mode === "co-dep" && !r.mat2 ? {...r, mode: "single", vol1: "100"} : r));
  }
  function buildPresetWorkbookSheets(structureRows, info) {
    const main = buildStructureSheet(structureRows, safeSheetTitle(info.Name || info.name || "Preset"));
    const infoAoa = Object.entries(info).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => [k, v]);
    return [main, {aoa: infoAoa, cols: [16, 40], sheetTitle: "Info"}];
  }
  // Names built from materials go into Dropbox paths (phone saves): no folder separators or characters Windows clients cannot sync.
  // The desktop writers keep the v10 names.
  function pathSafe(name) {
    return String(name || "").replace(/[\\/:*?"<>|]/g, "_");
  }
  function safeFileName(name) {
    return String(name || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
  }
  function timeTag(d = new Date()) {
    return `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  }
  // Process ID for the OLED measurement database: VTE-A222-YYMMDD-HHMM, issued once when a log is
  // first saved. Editing an existing log keeps the original id so the database key stays stable.
  const PROCESS_ID_KEY = "Process ID";
  function processId(dateYYMMDD, hhmm = timeTag()) {
    const date = String(dateYYMMDD || "").trim();
    if (!/^\d{6}$/.test(date) || !/^\d{4}$/.test(String(hhmm))) return "";
    return `VTE-A222-${date}-${hhmm}`;
  }
  function keepProcessId(existingMeta, dateYYMMDD, hhmm = timeTag()) {
    const prior = existingMeta && String(existingMeta[PROCESS_ID_KEY] || "").trim();
    return prior || processId(dateYYMMDD, hhmm);
  }

  // Calibration/<material>/<date>.xlsx. Input values are raw form strings.
  function buildCalibrationSheet(f) {
    const mat = String(f.material || "").trim();
    const date = String(f.date || "").trim();
    const monitor = toFloat(f.monitor);
    const actual = toFloat(f.actual);
    if (!mat || !/^\d{6}$/.test(date)) return {error: "재료명과 YYMMDD 날짜는 필수입니다."};
    if (monitor === null || monitor === 0 || actual === null) return {error: "Monitor/Actual thickness 숫자가 필요합니다."};
    const text = v => String(v ?? "");
    const aoa = [
      ["Material", mat, null, "Pressure (Torr)", "Power Meter", "Temperature (C)", "Rate (A/s)", "Monitor Thickness (nm)", "Actual Thickness (nm)"],
      ["Source Number", text(f.source).trim(), null, text(f.pressure).trim(), toFloat(text(f.power)) ?? text(f.power).trim(), text(f.temp).trim(), toFloat(text(f.rate)) ?? text(f.rate).trim(), monitor, actual],
      ["Tooling Factor", toFloat(text(f.toolingFactor))],
      ["Monitor Thickness (nm)", monitor],
      ["Actual Thickness (nm)", actual],
      ["Ratio (actual/monitor)", actual / monitor],
      ["Material Density", toFloat(text(f.density)) ?? text(f.density).trim()],
      ["Acoustic Impedance", toFloat(text(f.acousticImpedance)) ?? text(f.acousticImpedance).trim()],
      ["Notes", text(f.notes).trim()]
    ];
    return {aoa, cols: [22, 22, 8, 22, 22, 22, 22, 22, 22], sheetTitle: safeSheetTitle(mat), fileName: `${date}.xlsx`, folder: ["Calibration", mat], material: mat};
  }
  // Structures and presets share one layout: a header row of STRUCTURE_KEYS, then one row per layer.
  function buildStructureSheet(structureRows, sheetTitle = "OLED Structure v9") {
    const aoa = [STRUCTURE_KEYS];
    for (const row of structureRows) aoa.push(STRUCTURE_KEYS.map(k => row[k] ?? ""));
    return {aoa, cols: STRUCTURE_KEYS.map(() => 14), sheetTitle};
  }
  function structureRowsFromSheet(rows) {
    if (!rows || !rows.length) return [];
    const headers = rows[0].map(v => String(v || "").trim());
    return rows.slice(1).filter(r => r.some(v => v !== null && v !== "")).map(r => {
      const row = {...STRUCTURE_DEFAULTS};
      headers.forEach((h, i) => { if (h in row) row[h] = r[i] ?? ""; });
      return row;
    });
  }

  return {
    ORGANIC_PORTS, METAL_PORTS, ALL_PORTS, MASKS, LOG_COLUMN_WIDTHS, STRUCTURE_KEYS, STRUCTURE_DEFAULTS,
    toFloat, fmt, dateStrFromName, splitPair, pressureX1e7, sameNumeric, parseDateKey, displayDate, safeSheetTitle,
    calcRequiredMonitor, calcMonitorRate, getCell, norm, currentYYMMDD, shapeRows,
    parseProcessRows,
    updateMeasurementHeaderMap, rowHasDepositionContext, measurementFromRow, findMeasurementHeader, pickCoValue,
    layeredToolingMeasurements, latestOf, legacyCalibrationMeta, legacyCalibrationMeasurements, emptyCalibrationMeta,
    calibrationMetaFromRows, calibrationMeasurementsFromRows, matchCalibration, noCalibration, comboLabel, mergeComboOption,
    buildFileIndex, buildCalibrationIndex,
    DRAFT_LAYER_DEFAULTS, draftLayerToEditorRow, draftLayersToEditorRows, tagCodepRows, codepShare, CODEP_COL, readSheetMeta, draftLayersFromRows, presetToDraftLayers, draftLayersToPresetRows,
    buildPresetWorkbookSheets, safeFileName, pathSafe, timeTag, PROCESS_ID_KEY, processId, keepProcessId,
    setAoa, buildProcessLogSheet, processLogFolder, buildCalibrationSheet, buildStructureSheet, structureRowsFromSheet
  };
});
