// Re-saving must never shrink ThickMon: a stale cached copy is unioned with the file's current sheets, and any loss is detected.
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const {XLSX, repo} = require("./helpers.cjs");
const Core = require("../src/core/vte-core.js");

const grid = (wb, n) => XLSX.utils.sheet_to_json(wb.Sheets[n], {header: 1, raw: true, defval: null});
const fx = XLSX.read(fs.readFileSync(path.join(repo, "tests/fixtures/thickmon_codep_261017.xlsx")), {type: "buffer"});
const full = grid(fx, "ThickMon");
const count = a => { const c = {}; Core.thickSheetParse(a).series.forEach(r => { c[r[0]] = (c[r[0]] || 0) + 1; }); return c; };
const before = count(full);
assert.ok(Object.keys(before).length >= 2, "fixture has several layers");

const p = Core.thickSheetParse(full);
const layers = Object.keys(before).map(Number);
const first = layers[0], last = layers[layers.length - 1];
const lastRows = p.series.filter(r => r[0] === last);
const drop = new Set(lastRows.slice(Math.floor(lastRows.length / 2)));
const stale = Core.thickSheetMerge(null, p.summary, p.series.filter(r => r[0] !== first && !drop.has(r)));
assert.ok(Core.thickLoss(full, stale) > 0, "loss detector flags the stale copy");

const thickOf = sheets => sheets.find(s => s.sheetTitle === "ThickMon").aoa;
assert.ok(Core.thickLoss(full, thickOf(Core.mergeExtraSheets([{name: "ThickMon", aoa: stale}], [], []))) > 0, "stale base alone loses rows");
let cur = full;
for (let i = 0; i < 4; i++) {
  const base = Core.unionExtra([{name: "ThickMon", aoa: stale}], [{name: "ThickMon", aoa: cur}]);
  const out = thickOf(Core.mergeExtraSheets(base, [], []));
  assert.equal(Core.thickLoss(cur, out), 0, `round ${i}: nothing lost`);
  assert.deepEqual(count(out), before, `round ${i}: per-layer rows identical`);
  cur = out;
}
console.log("thick stale cache ok");
