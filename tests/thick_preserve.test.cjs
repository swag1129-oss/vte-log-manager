// Old-format logs open and show exactly as before; new-format ThickMon data survives open -> save -> reopen -> save.
// Real-file part: copies of Dropbox logs in VTE_SAMPLES (default /tmp/vte_samples); skipped when absent.
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {execFileSync} = require("child_process");
const {XLSX, repo} = require("./helpers.cjs");
const Core = require("../src/core/vte-core.js");
const Store = (() => { global.window = undefined; const o = {}; new Function("root", fs.readFileSync(path.join(repo, "src/mobile/store.js"), "utf8").replace(/\}\)\(typeof globalThis[\s\S]*$/, "})(root);"))(o); return o.VTEStore; })();

const grid = (wb, name) => XLSX.utils.sheet_to_json(wb.Sheets[name], {header: 1, raw: true, defval: null});
const save = (sheets) => {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.aoa), s.sheetTitle);
  return XLSX.write(wb, {bookType: "xlsx", type: "buffer"});
};
const resave = (buf, summary = [], series = []) => {
  const {rows, extra} = Store.readWorkbook(XLSX, buf);
  const meta = Core.readSheetMeta(rows);
  const layers = Core.thickFromMeta(meta, Core.draftLayersFromRows(rows));
  const sheet = Core.buildProcessLogSheet({isTooling: false, layers: Core.draftLayersToEditorRows(layers), memo: "", meta: {...meta, ...Core.thickToMeta(layers)}, timeTag: "1200"});
  return save([sheet, ...Core.mergeExtraSheets(extra, summary, series)]);
};

// ---- one-touch numbers, start detection, heat check
const r = Core.thickResult({startThk: "10.5", endThk: "40.5", startMs: 1000000, endMs: 1000000 + 600000});
assert.equal(r.diff, 30);
assert.ok(Math.abs(r.avgRate - 0.5) < 1e-9, "30 nm in 600 s = 0.5 A/s");
assert.equal(Core.thickResult({startThk: "", endThk: "5", startMs: 1, endMs: 2}), null);
const ramp = [];
for (let t = 0; t < 40; t += 0.5) ramp.push({ts: 100 + t, rate_fit: t < 5 ? null : t < 8 ? 0.2 : t < 9 ? 0.05 : 0.15});
const det = Core.detectStart(ramp);
assert.equal(det.start, 109, "an earlier 3 s excursion above 0.1 does not count; run starts at 109");
assert.equal(det.confirmed, 119);
assert.equal(Core.detectStart(ramp.filter(p => p.ts < 115)), null, "not held 10 s yet");
assert.equal(Core.heatCheck([{thk_med: 40}, {thk_med: 39.5}, {thk_med: 39.8}], "40").suspect, true);
assert.equal(Core.heatCheck([{thk_med: 40}, {thk_med: 39.9}], "40").suspect, false);
assert.equal(Core.heatCheck([{thk_med: 40}, {thk_med: 0, flag: "reset"}], "40").delta, 0, "a reset is not heat");

// ---- new format: ThickMon survives save -> reopen -> save, with and without the server
const mk = (material, port, extra = {}) => ({...Core.DRAFT_LAYER_DEFAULTS, material, port, target_actual: "10", ...extra});
const t0 = 1760000000000;
const layers = [mk("HAT-CN", "O1"), mk("TAPC", "O2", {sensor_port: "B", started_ms: t0, ended_ms: t0 + 600000, started_at: "x", start_thk: "1", end_thk: "31", mon_diff: "30", avg_rate: "0.5", det_ms: t0 + 20000, det_power: "12", det_temp: "300"})];
const rowsAt = (a, b) => { const o = []; for (let s = a; s <= b; s += 5) o.push({ts: t0 / 1000 + s, thk_med: s / 10, rate_fit: 0.5, rate: 0.6, power: 3, flag: s === 100 ? "spike" : ""}); return o; };
const meta0 = {App: "t", ...Core.thickToMeta(layers)};
const sheet0 = Core.buildProcessLogSheet({isTooling: false, layers: Core.draftLayersToEditorRows(layers), memo: "", meta: meta0, timeTag: "1200"});
const sum = Core.thickSummaryRow(layers[1], 1);
let buf = save([sheet0, ...Core.mergeExtraSheets([], [sum], Core.thickSeriesRows(layers[1], 1, rowsAt(-30, 400)))]);
const first = Store.readWorkbook(XLSX, buf).extra.find(s => s.name === "ThickMon").aoa;
assert.ok(Core.thickPoints(first).get(2).points.length > 50);
buf = resave(buf);                               // reopened, server unreachable
assert.deepEqual(Store.readWorkbook(XLSX, buf).extra.find(s => s.name === "ThickMon").aoa, first, "no server: ThickMon unchanged");
buf = resave(buf, [sum], Core.thickSeriesRows(layers[1], 1, rowsAt(300, 780)));   // server returns later part only (older part gone)
const merged = Store.readWorkbook(XLSX, buf).extra.find(s => s.name === "ThickMon").aoa;
const pts = Core.thickPoints(merged).get(2).points;
assert.equal(pts[0].ts, t0 / 1000 - 30, "old rows kept");
assert.equal(pts[pts.length - 1].ts, t0 / 1000 + 780, "new rows added");
assert.equal(pts.length, 163, "union without duplicates (-30..780 step 5)");
assert.ok(pts.some(p => p.flag === "spike"), "flags kept");
buf = resave(buf, [sum], Core.thickSeriesRows(layers[1], 1, rowsAt(300, 780)));
assert.equal(Core.thickPoints(Store.readWorkbook(XLSX, buf).extra.find(s => s.name === "ThickMon").aoa).get(2).points.length, 163, "idempotent");
const back = Core.thickFromMeta(Core.readSheetMeta(Store.readWorkbook(XLSX, buf).rows), Core.draftLayersFromRows(Store.readWorkbook(XLSX, buf).rows));
assert.equal(back[1].mon_diff, "30");
assert.equal(back[1].det_power, "12");
assert.equal(back[1].det_ms, t0 + 20000);

// old branch-format ThickMon (8 columns, no epochs, no flag) is merged, never dropped
const legacy = [["Layer", "Material", "Source", "Sensor", "Start", "End", "Start thk (nm)", "End thk (nm)"], [2, "TAPC", "O2", "B", "09:00:00", "09:10:00", "1", "31"], [], ["Layer", "Sensor", "Time", "Epoch (s)", "Thickness median 5s (nm)", "Rate fit 10s (A/s)", "Raw RS232 rate (A/s, untrusted)", "Power (%)"], [2, "B", "09:00:01", 1760000001, 1, 0.5, 0.6, 3]];
const lb = save([sheet0, {sheetTitle: "ThickMon", aoa: legacy}, {sheetTitle: "Memo", aoa: [["keep", 1], [null, "x"]]}]);
const lb2 = resave(lb, [sum], Core.thickSeriesRows(layers[1], 1, rowsAt(0, 20)));
const ex2 = Store.readWorkbook(XLSX, lb2).extra;
assert.deepEqual(ex2.find(s => s.name === "Memo").aoa, [["keep", 1], [null, "x"]], "unknown extra sheet preserved");
assert.ok(Core.thickSheetParse(ex2.find(s => s.name === "ThickMon").aoa).series.some(row => row[3] === 1760000001), "legacy row kept");
// unrecognised ThickMon layout is returned untouched
const odd = [["foo", "bar"], [1, 2]];
assert.deepEqual(Core.mergeExtraSheets([{name: "ThickMon", aoa: odd}], [sum], []).find(s => s.sheetTitle === "ThickMon").aoa, odd);

// ---- real old-format files
const dir = process.env.VTE_SAMPLES || "/tmp/vte_samples";
if (!fs.existsSync(dir)) { console.log("thick preserve ok (real-file part SKIPPED: no samples)"); process.exit(0); }
const base = fs.mkdtempSync(path.join(os.tmpdir(), "vtebase-"));
fs.mkdirSync(path.join(base, "core"));
fs.mkdirSync(path.join(base, "mobile"));
for (const [rel, to] of [["src/core/vte-core.js", "core/vte-core.js"], ["src/mobile/data.js", "mobile/data.js"]]) fs.writeFileSync(path.join(base, to), execFileSync("git", ["show", `main:${rel}`], {cwd: repo, encoding: "utf8"}));
const Old = require(path.join(base, "mobile/data.js"));
const OldCore = require(path.join(base, "core/vte-core.js"));
const New = require("../src/mobile/data.js");
const files = fs.readdirSync(dir).filter(f => f.endsWith(".xlsx"));
const mkFiles = lib => files.map(f => ({relPath: `${/tool/i.test(f) ? "Process_Tooling" : "Process_General"}/260101/${f.split("__").pop()}`, name: f.split("__").pop(), rows: lib(f)}));
const oldRows = f => { const wb = XLSX.read(fs.readFileSync(path.join(dir, f)), {type: "buffer", cellDates: false}); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1, raw: true, defval: null}); };
const newRead = f => Store.readWorkbook(XLSX, fs.readFileSync(path.join(dir, f)));
const oldModel = Old.createModel(mkFiles(oldRows));
const newModel = New.createModel(mkFiles(f => newRead(f).rows).map((x, i) => ({...x, extra: newRead(files[i]).extra})));
let withExtra = 0, lossyCount = 0;
files.forEach((f, i) => {
  assert.deepEqual(newRead(f).rows, oldRows(f), `${f}: first sheet read unchanged`);
  const lo = oldModel.logs[i], ln = newModel.logs.find(l => l.realPath === oldModel.logs[i].realPath);
  assert.deepEqual(newModel.parseLog(ln), oldModel.parseLog(lo), `${f}: parsed log unchanged`);
  assert.deepEqual(newModel.orderedLayers(ln), oldModel.orderedLayers(lo), `${f}: viewer layers unchanged`);
  assert.equal(newModel.thickOf(ln.realPath).size, 0, `${f}: no thick graphs on old logs`);
  assert.deepEqual(Core.draftLayersFromRows(oldRows(f)), OldCore.draftLayersFromRows(oldRows(f)), `${f}: editor draft unchanged`);
  const orig = fs.readFileSync(path.join(dir, f));
  const origExtra = newRead(f).extra;
  if (origExtra.length) withExtra++;
  const out = Store.readWorkbook(XLSX, resave(orig));
  assert.deepEqual(out.extra.map(s => [s.name, s.aoa]), origExtra.map(s => [s.name, s.aoa]), `${f}: extra sheets survive re-save`);
  const rows0 = oldRows(f), meta0 = Core.readSheetMeta(rows0);
  const lossy = Core.editRoundTripLossy(rows0, Core.thickFromMeta(meta0, Core.draftLayersFromRows(rows0)), meta0, /tool/i.test(f));
  if (lossy) lossyCount++;
  else assert.equal(Core.editRoundTripLossy(out.rows, Core.draftLayersFromRows(out.rows), Core.readSheetMeta(out.rows), /tool/i.test(f)), false, `${f}: stable re-save`);
});
assert.deepEqual(newModel.startConditions(["Al", "LiF", "TPBi"]), oldModel.startConditions(["Al", "LiF", "TPBi"]), "start-condition panel unchanged for old logs");
console.log(`thick preserve ok (${files.length} real files, ${withExtra} with extra sheets, ${lossyCount} would be saved as new file instead of in place)`);
