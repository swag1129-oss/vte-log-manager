/*
 * Mobile data model: turns cached sheets ({relPath, name, rows}) into the same logs, calibration history,
 * and latest-ratio lookups the desktop app shows. Pure; loads in the browser (window.VTEData) or Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../core/vte-core.js"));
  else root.VTEData = factory(root.VTECore);
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  function createModel(files) {
    // `viewPath` lets test-folder files (_mobile_test/…) appear at their normal place; `realPath` is where they live.
    const view = files.map(f => ({relPath: f.viewPath || f.relPath, realPath: f.relPath, name: f.name, rev: f.rev || null, test: Boolean(f.viewPath), rows: f.rows, extra: f.extra}));
    // Rows are keyed by the real Dropbox path: a test copy must never stand in for a real file with the same view path.
    const rowsByPath = new Map(view.map(f => [f.realPath, f.rows]));
    // Sheets after the first (undefined = cached before extras were kept; the app then re-reads the file when it needs them).
    const extraByPath = new Map(view.map(f => [f.realPath, f.extra]));
    const {logs, calibrationFiles} = Core.buildFileIndex(view.map(({rows, extra, ...meta}) => meta));
    const presets = view.filter(f => /^(Presets|Structures)\/[^/]+\.xlsx$/i.test(f.relPath))
      .map(({rows, extra, ...meta}) => ({...meta, kind: meta.relPath.startsWith("Presets/") ? "preset" : "structure", title: meta.name.replace(/\.xlsx$/i, "")}))
      .sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === "preset" ? -1 : 1));
    const parseCache = new Map();
    const measurementCache = new Map();

    function parseLog(log) {
      const key = log.realPath || log.relPath;
      if (!parseCache.has(key)) {
        const rows = rowsByPath.get(key);
        parseCache.set(key, rows ? Core.parseProcessRows(rows) : {error: "파일을 아직 받지 못했습니다.", material_list: [], layers: {}});
      }
      return parseCache.get(key);
    }
    const {materials, filesByMaterial} = Core.buildCalibrationIndex(logs, calibrationFiles, log => parseLog(log).material_list);

    function measurements(file) {
      const key = `${file.material}\u0000${file.realPath || file.relPath}`;
      if (!measurementCache.has(key)) {
        const rows = rowsByPath.get(file.realPath || file.relPath);
        measurementCache.set(key, Core.calibrationMeasurementsFromRows(rows ?? null, file));
      }
      return measurementCache.get(key);
    }
    // History for one material, newest file first, in the order the desktop table shows it.
    function calibrationHistory(material) {
      return (filesByMaterial.get(material) || []).flatMap(file => measurements(file).map(m => ({...m, file})));
    }
    function latestCalibration(material, source = null, toolingFactor = null) {
      let fallback = null;
      for (const file of filesByMaterial.get(material) || []) {
        const match = Core.matchCalibration(measurements(file), source, toolingFactor);
        if (match.measured) return match.measured;
        if (!fallback) fallback = match.withToolingFactor;
      }
      return fallback || Core.noCalibration(source);
    }
    // One entry per material_TF_source, like the desktop material combo box.
    function comboOptions(material = null) {
      const best = new Map();
      for (const mat of material ? [material] : materials) {
        for (const file of filesByMaterial.get(mat) || []) {
          for (const meta of measurements(file)) Core.mergeComboOption(best, mat, meta, file.dateStr);
        }
      }
      return [...best.values()].sort((a, b) => a.label.localeCompare(b.label, "en", {sensitivity: "base"}));
    }
    // Layers in deposition order for the detail view.
    function orderedLayers(log) {
      const parsed = parseLog(log);
      const rows = rowsByPath.get(log.realPath || log.relPath) || [];
      return Object.entries(parsed.layers)
        .flatMap(([material, items]) => items.map(item => ({material, ...item})))
        .sort((a, b) => a.sequence - b.sequence)
        .map(l => {
          // The parser keeps only the start row's rate; a paired end row carries the end rate.
          const start = rows[l.sequence] || [], end = rows[l.sequence + 1] || [];
          const paired = Core.norm(start[8]) === "start" && Core.norm(end[8]) !== "start" && (end[3] === null || end[3] === undefined || Core.norm(end[3]) === Core.norm(l.material));
          return {...l, end_rate: paired ? end[7] ?? null : null};
        });
    }
    // Past runs of one material on one source, newest first: what power/temperature got it going last time.
    const historyCache = new Map();
    function sourceHistory(material, port, {limit = 5, excludePath = ""} = {}) {
      const mat = Core.norm(material), src = Core.norm(port);
      if (!mat || !src) return [];
      const key = `${mat}|${src}|${limit}|${excludePath}`;
      if (!historyCache.has(key)) {
        const out = [];
        for (const log of logs) {
          if (out.length >= limit) break;
          if (log.relPath === excludePath || log.realPath === excludePath) continue;
          const parsed = parseLog(log);
          if (!Object.keys(parsed.layers).some(m => Core.norm(m) === mat)) continue;
          for (const l of orderedLayers(log)) {
            if (Core.norm(l.material) !== mat || Core.norm(l.port) !== src || out.length >= limit) continue;
            out.push({log, layer: l, start_power: l.start_power ?? l.power ?? "", end_power: l.end_power ?? "", start_temp: l.start_temp ?? l.temp ?? "", end_temp: l.end_temp ?? "", start_rate: l.rate ?? "", end_rate: l.end_rate ?? ""});
          }
        }
        historyCache.set(key, out);
      }
      return historyCache.get(key);
    }
    // Power and source temperature at the moment deposition started (rate about 0.1 A/s), per material, from past logs.
    // Median of up to `limit` newest runs; co-dep layers ("A:B" with "x/y" values) are split per material.
    const startCache = new Map();
    function startConditions(materialNames, {limit = 5} = {}) {
      const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
      const parts = (v, n) => { const p = String(v ?? "").split("/").map(x => Core.toFloat(x)); return p.length === n ? p : n === 1 ? [Core.toFloat(v)] : Array(n).fill(null); };
      const wanted = [...new Set(materialNames.map(m => String(m).trim()).filter(Boolean))];
      const cacheKey = wanted.map(Core.norm).sort().join("|") + `|${limit}`;
      if (!startCache.has(cacheKey)) {
        const found = new Map(wanted.map(m => [Core.norm(m), []]));
        for (const log of logs) {
          const parsed = parseLog(log);
          // Layers whose deposition start the thickness monitor detected (rate_fit > 0.1 A/s for 10 s): the power/temperature the user
          // entered at that moment count as the start condition whatever the logged start rate was.
          const logRows = rowsByPath.get(log.realPath || log.relPath) || [];
          const detected = new Map();
          if (Core.thickItems(Core.readSheetMeta(logRows)).some(it => it.ds)) {
            for (const dl of Core.thickFromMeta(Core.readSheetMeta(logRows), Core.draftLayersFromRows(logRows))) {
              if (dl.det_ms && dl._seq !== undefined && !String(dl.material).includes(":")) detected.set(dl._seq, dl);
            }
          }
          for (const dl of detected.values()) {
            const list = found.get(Core.norm(dl.material));
            const power = Core.toFloat(dl.det_power), temp = Core.toFloat(dl.det_temp);
            if (list && (power !== null || temp !== null)) list.push({power, temp, date: log.dateStr || "", dateKey: log.dateKey || 0});
          }
          for (const [lm, items] of Object.entries(parsed.layers)) {
            const mats = lm.split(":").map(x => x.trim());
            if (!mats.some(m => found.has(Core.norm(m)))) continue;
            for (const l of items) {
              if (detected.has(l.sequence)) continue;
              const rate = parts(l.rate, mats.length), power = parts(l.start_power ?? l.power, mats.length), temp = parts(l.start_temp ?? l.temp, mats.length);
              mats.forEach((m, k) => {
                const list = found.get(Core.norm(m));
                if (!list || rate[k] === null || Math.abs(rate[k] - 0.1) > 0.02 || (power[k] === null && temp[k] === null)) return;
                list.push({power: power[k], temp: temp[k], date: log.dateStr || "", dateKey: log.dateKey || 0});
              });
            }
          }
        }
        startCache.set(cacheKey, wanted.map(m => {
          const all = found.get(Core.norm(m)).sort((a, b) => b.dateKey - a.dateKey);
          const use = all.slice(0, limit);
          const nums = key => use.map(u => u[key]).filter(v => v !== null);
          const pw = nums("power"), tp = nums("temp");
          return {material: m, count: all.length, used: use.length, latest: all[0]?.date || "",
            power: pw.length ? median(pw) : null, temp: tp.length ? median(tp) : null,
            powerRange: pw.length ? [Math.min(...pw), Math.max(...pw)] : null, tempRange: tp.length ? [Math.min(...tp), Math.max(...tp)] : null};
        }));
      }
      return startCache.get(cacheKey);
    }
    function searchLogs({query = "", type = "", from = "", to = ""} = {}) {
      const q = query.trim().toLowerCase();
      const fromKey = Core.parseDateKey(from), toKey = Core.parseDateKey(to);
      return logs.filter(log => {
        if (type && log.type !== type) return false;
        if (q && !`${log.filename} ${log.relPath}`.toLowerCase().includes(q)) return false;
        if (fromKey && (!log.dateKey || log.dateKey < fromKey)) return false;
        if (toKey && (!log.dateKey || log.dateKey > toKey)) return false;
        return true;
      });
    }

    const rowsOf = realPath => rowsByPath.get(realPath) || null;
    const extraOf = realPath => extraByPath.get(realPath);
    const setExtra = (realPath, extra) => extraByPath.set(realPath, extra);
    const thickOf = realPath => {
      const sheet = (extraByPath.get(realPath) || []).find(s => s.name === Core.THICK_SHEET);
      return sheet ? Core.thickPoints(sheet.aoa) : new Map();
    };
    return {logs, presets, rowsOf, extraOf, setExtra, thickOf, materials, filesByMaterial, parseLog, orderedLayers, sourceHistory, startConditions, searchLogs, measurements, calibrationHistory, latestCalibration, comboOptions};
  }

  return {createModel};
});
