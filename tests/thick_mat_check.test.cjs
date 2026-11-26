// 861 slot vs selected material: match / mismatch / notation / no info; summary columns; meta round trip.
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const Core = require("../src/core/vte-core.js");
global.localStorage = {getItem: () => "http://127.0.0.1:1", setItem() {}};
global.document = {hidden: false};
new Function(fs.readFileSync(path.join(__dirname, "..", "src", "mobile", "thick.js"), "utf8")).call(global);
const T = global.VTEThick;
const L = (material, tf, extra = {}) => ({...Core.DRAFT_LAYER_DEFAULTS, material, tooling_factor: tf, sensor_port: "C", ...extra});
const S = (name, tooling, no = 17) => ({no, name, tooling});

// match, notation differences ignored
assert.equal(T.matCheck(L("Irppy3_100", "100"), S("Irppy3_100", 100)).state, "ok");
assert.equal(T.matCheck(L("Ir(ppy)3", "100"), S("Irppy3_100", 100)).state, "ok");
assert.equal(T.matCheck(L("CBP", "50.3"), S("cbp_50", 50)).state, "ok");
// mismatch: TF and name
const tfBad = T.matCheck(L("Irppy3_100", "100"), S("Irppy3_150", 150, 18));
assert.equal(tfBad.state, "bad");
assert.equal(tfBad.text, "861 C#18 Irppy3_150 (TF 150) ≠ 선택 Irppy3_100 (TF 100)");
assert.equal(T.matCheck(L("TPBi", "100"), S("Irppy3_100", 100)).state, "bad");
assert.equal(T.matCheck(L("Irppy3", "100"), S("Irppy3_100", 100)).state, "ok");
// TF tolerance and unknown TF
assert.equal(T.matCheck(L("Al", "20.4"), S("Al", 20)).state, "ok");
assert.equal(T.matCheck(L("Al", "21"), S("Al", 20)).state, "bad");
assert.equal(T.matCheck(L("Al", ""), S("Al", 20)).state, "ok");
assert.equal(T.matCheck(L("Al", "20"), S("Al", null)).state, "ok");
// no information -> grey, never red
assert.equal(T.matCheck(L("", "20"), S("Al", 20)).state, "none");
assert.equal(T.matCheck(L("Al", "20"), null).state, "none");
assert.equal(T.matCheck(L("Al", "20"), S("", 20)).state, "none");

// stamping from /live; finished layers are not touched; old server (no material_name) leaves layer alone
const lp = {C: {material_no: 18, material_name: "Irppy3_150", material_tooling: 150}};
const run = L("Irppy3_100", "100"); T.stampSlot(run, lp);
assert.equal(T.matCheckLayer(run).state, "bad");
const done = L("Irppy3_100", "100", {ended_ms: 5}); T.stampSlot(done, lp); assert.equal(done.slot_name, undefined);
const old = L("Irppy3_100", "100"); T.stampSlot(old, {C: {material_no: 18}}); assert.equal(old.slot_name, undefined);
assert.equal(T.matCheckLayer(old).state, "none");

// xlsx summary: new columns appended, old ones keep their positions; meta round trip
const row = Core.thickSummaryRow(run, 0);
const h = Core.SUMMARY_HEAD, n = h.length;
assert.deepEqual(h.slice(-3), ["861 slot", "861 name", "861 tooling"]);
assert.equal(h[0], "Layer"); assert.equal(h[18], "Codep cum vol% (real)");
assert.deepEqual(row.slice(n - 3), ["18", "Irppy3_150", "150"]);
const back = Core.thickFromMeta({[Core.THICK_KEY]: Core.thickToMeta([run])[Core.THICK_KEY]}, [L("Irppy3_100", "100")])[0];
assert.equal(back.slot_name, "Irppy3_150"); assert.equal(back.slot_tf, "150");
// an old-format sheet (16 summary columns) still parses and merges
const oldSheet = [h.slice(0, 19), [1, "X", "O1", "C", "t", "t", "", "", "", "", "", "", "", "", "", "", 1000, 2000, ""], [], Core.SERIES_HEAD];
assert.ok(Core.thickSheetParse(oldSheet));
console.log("thick_mat_check ok");
