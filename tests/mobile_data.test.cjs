// Phone data model: test-mode copies never stand in for real files that share a view path.
const assert = require("assert/strict");
const {XLSX, sheetRows} = require("./helpers.cjs");
const Core = require("../src/core/vte-core.js");
const {createModel} = require("../src/mobile/data.js");

const rowsOf = sheet => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.aoa), sheet.sheetTitle);
  return sheetRows(XLSX.read(XLSX.write(wb, {bookType: "xlsx", type: "buffer"}), {type: "buffer"}));
};
const cal = actual => rowsOf(Core.buildCalibrationSheet({material: "HAT-CN", date: "260917", source: "O-3", toolingFactor: "20", monitor: "10", actual}));
const real = {relPath: "Calibration/HAT-CN/260917.xlsx", name: "260917.xlsx", rows: cal("14")};
const test = {relPath: "_mobile_test/Calibration/HAT-CN/260917.xlsx", viewPath: "Calibration/HAT-CN/260917.xlsx", name: "260917.xlsx", rows: cal("99")};

for (const files of [[real, test], [test, real]]) {
  const model = createModel(files);
  const ratios = model.calibrationHistory("HAT-CN").map(m => [m.file.test, m.ratio]).sort();
  assert.deepEqual(ratios, [[false, 1.4], [true, 9.9]], "each file keeps its own rows");
  assert.equal(model.rowsOf(real.relPath), real.rows);
  assert.equal(model.rowsOf(test.relPath), test.rows);
}
// With test mode off the app passes only real files.
assert.equal(createModel([real]).latestCalibration("HAT-CN", "O-3", "20").ratio, 1.4);
console.log("mobile data: PASS; test copies and real files with the same view path stay separate");
