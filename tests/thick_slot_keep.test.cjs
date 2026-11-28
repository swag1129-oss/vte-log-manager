// 861 slot / thick summary values already in a log must survive open -> edit -> save (also when meta or summary is blank on one side).
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const {XLSX, repo} = require("./helpers.cjs");
const Core = require("../src/core/vte-core.js");
const Store = (() => { global.window = undefined; const o = {}; new Function("root", fs.readFileSync(path.join(repo, "src/mobile/store.js"), "utf8").replace(/\}\)\(typeof globalThis[\s\S]*$/, "})(root);"))(o); return o.VTEStore; })();
const save = sheets => { const wb = XLSX.utils.book_new(); for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.aoa), s.sheetTitle); return XLSX.write(wb, {bookType: "xlsx", type: "buffer"}); };
const t0 = 1760000000000;
const mk = (material, port, extra = {}) => ({...Core.DRAFT_LAYER_DEFAULTS, material, port, target_actual: "10", ...extra});
const orig = [mk("HAT-CN", "O1"), mk("TAPC", "O2", {sensor_port: "B", started_ms: t0, ended_ms: t0 + 600000, started_at: "x", start_thk: "1", end_thk: "31", mon_diff: "30", avg_rate: "0.5",
  slot_no: "17", slot_name: "TAPC_100", slot_tf: "100"})];
const build = (layers, meta, extra) => { const sh = Core.buildProcessLogSheet({isTooling: false, layers: Core.draftLayersToEditorRows(layers), memo: "", meta, timeTag: "1200"}); return save([sh, ...extra]); };
const origSum = Core.thickSummaryRow(orig[1], 1);
const origSeries = [];
// Simulates editor.js: open (editLog) -> optional edit -> save (uploadDraftInner/buildExtraSheets).
const reopenSave = (buf, {dropMeta = false, edit = () => {}, newSummary = true} = {}) => {
  const {rows, extra} = Store.readWorkbook(XLSX, buf);
  let meta = Core.readSheetMeta(rows);
  if (dropMeta) delete meta[Core.THICK_KEY];
  const layers = Core.thickFromSummary(extra, Core.thickFromMeta(meta, Core.draftLayersFromRows(rows)));
  edit(layers);
  const m = {...meta, ...Core.thickToMeta(layers, meta)};
  const summary = newSummary ? layers.map((l, i) => ({l, i})).filter(({l}) => l.sensor_port && l.started_ms).map(({l, i}) => Core.thickSummaryRow(l, i)) : [];
  return build(layers, m, Core.mergeExtraSheets(extra, summary, []));
};
const check = (buf, why) => {
  const {rows, extra} = Store.readWorkbook(XLSX, buf);
  const l = Core.thickFromMeta(Core.readSheetMeta(rows), Core.draftLayersFromRows(rows))[1];
  assert.deepEqual([l.slot_no, l.slot_name, l.slot_tf], ["17", "TAPC_100", "100"], `${why}: meta`);
  const s = Core.thickSheetParse(extra.find(x => x.name === "ThickMon").aoa).summary[0];
  assert.deepEqual(s.slice(-3), ["17", "TAPC_100", "100"], `${why}: summary`);
  assert.deepEqual([s[6], s[7], s[8], s[9]], ["1", "31", "30", "0.5"], `${why}: other summary cols`);
};
const base = build(orig, {App: "t", ...Core.thickToMeta(orig)}, Core.mergeExtraSheets([], [origSum], origSeries));
check(base, "fixture");
const stripSlot = ls => ls.forEach(l => { l.slot_no = ""; l.slot_name = ""; l.slot_tf = ""; });
check(reopenSave(base, {edit: l => { l[0].notes = "edited"; }}), "plain edit");
check(reopenSave(base, {edit: l => { l[0].notes = "edited"; stripSlot(l); }}), "slot blanked at save");
check(reopenSave(base, {dropMeta: true, edit: l => { l[0].notes = "e"; }}), "meta lacks ThickSensors -> restored from summary");
check(reopenSave(base, {dropMeta: true, edit: stripSlot}), "meta missing + blank");
// blank other summary columns at save must not erase old ones
check(reopenSave(base, {edit: l => { l[1].start_thk = ""; l[1].end_thk = ""; l[1].mon_diff = ""; l[1].avg_rate = ""; stripSlot(l); }}), "blank thk/rate cols");
// direct merge: new summary row with blanks keeps old values
const merged = Core.thickSheetMerge(Core.mergeExtraSheets([], [origSum], [])[0].aoa, [Core.thickSummaryRow({...orig[1], slot_no: "", slot_name: "", slot_tf: "", end_thk: ""}, 1)], []);
assert.deepEqual(Core.thickSheetParse(merged).summary[0].slice(-3), ["17", "TAPC_100", "100"]);
assert.equal(Core.thickSheetParse(merged).summary[0][7], "31");
// a genuinely new value still wins
const m2 = Core.thickSheetMerge(merged, [Core.thickSummaryRow({...orig[1], slot_name: "TAPC_150", slot_tf: "150"}, 1)], []);
assert.deepEqual(Core.thickSheetParse(m2).summary[0].slice(-3), ["17", "TAPC_150", "150"]);
console.log("thick_slot_keep ok");
