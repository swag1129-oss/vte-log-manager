const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {XLSX, fixture} = require("./helpers.cjs");
const Core = require("../src/core/vte-core.js");
require("../src/mobile/store.js");
const Store = globalThis.VTEStore;
// Real 2026-10-17 co-deposition run (CBP:Ir(ppy)3): every layer the file's metadata lists must have a summary and chart points.
const {rows, extra} = Store.readWorkbook(XLSX, fs.readFileSync(fixture("thickmon_codep_261017.xlsx")));
const thick = Core.thickPoints(extra.find(s => s.name === Core.THICK_SHEET).aoa);
const items = Core.thickItems(Core.readSheetMeta(rows)).filter(it => it.t0);
assert.strictEqual(items.length, 7);
const mats = ["HAT-CN", "TAPC", "CBP", "Ir(ppy)3", "B3PymPm", "LiF", "Al"];
for (const it of items) {
  const t = thick.get(it.i + 1);
  assert.ok(t && t.points.length > 400, `layer ${it.i + 1} points`);
  assert.strictEqual(t.sum[1], mats[it.i]);
  assert.ok(Number(t.sum[8]) > 0);
}
assert.strictEqual(thick.get(4).sum[8], "19.35");
console.log("thick viewer real file ok");
