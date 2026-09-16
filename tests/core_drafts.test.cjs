// Mobile drafts: sheet round trip, meta and times, calibration read-back, presets, and the lab's current v10 app reading mobile files.
const assert = require("assert/strict");
const vm = require("vm");
const {XLSX, V10, loadApp, sheetRows} = require("./helpers.cjs");
const Core = require("../src/core/vte-core.js");

function toRows(sheets) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.aoa), s.sheetTitle);
  return sheetRows(XLSX.read(XLSX.write(wb, {bookType: "xlsx", type: "buffer"}), {type: "buffer"}));
}

(async () => {
  const draft = [
    {...Core.DRAFT_LAYER_DEFAULTS, material: "HAT-CN", port: "O-3", tooling_factor: "20", ratio: "1.414", mask: "1", target_actual: "5", monitor: "3.5361", start_rate: "0.1", end_rate: "0.3",
      start_pressure: "9.6", start_power: "4.9", start_temp: "240", started_at: "2026-09-17 10:02", end_pressure: "9.1", end_power: "4.9", end_temp: "265", ended_at: "2026-09-17 10:09", notes: "첫 층"},
    {...Core.DRAFT_LAYER_DEFAULTS, material: "Ir(ppy)3", port: "O-4", tooling_factor: "100", ratio: "0.19375", mask: "2", target_actual: "10", monitor: "51.6129", start_rate: "0.1",
      start_pressure: "5.3x10-7", start_power: "3.5", start_temp: "167", end_pressure: "4.4x10-7", end_power: "3.5", end_temp: "208", measured_actual: "9.8"}
  ];
  const meta = {App: "VTE Log Manager PWA v11", Author: "홍길동", Device: "iPhone", "Created At": "2026-09-17 10:15", Preset: "PhOLED 기본"};
  for (const isTooling of [false, true]) {
    const sheet = Core.buildProcessLogSheet({isTooling, layers: draft.map(Core.draftLayerToEditorRow), memo: "memo", meta, timeTag: "1015"});
    assert.match(sheet.fileName, isTooling ? /_tooling_v11_1015\.xlsx$/ : /_general_v11_1015\.xlsx$/);
    const rows = toRows([sheet]);

    // Meta survives and the parser ignores the extra columns.
    assert.deepEqual(Core.readSheetMeta(rows), meta);
    const parsed = Core.parseProcessRows(rows);
    assert.deepEqual(parsed.material_list, [{material: "HAT-CN", port: "O-3"}, {material: "Ir(ppy)3", port: "O-4"}]);
    const hat = parsed.layers["HAT-CN"][0];
    assert.equal(hat.start_pressure, "9.6x10-7");
    assert.equal(hat.end_pressure, "9.1x10-7");
    assert.equal(hat.monitor_thickness, 3.5361);
    assert.equal(hat.end_temp, 265);
    assert.equal(hat.rate, 0.1, "start row keeps the start rate");
    const endRow = rows.find((r, idx) => idx > 0 && rows[idx - 1][8] === "Start" && rows[idx - 1][3] === "HAT-CN");
    assert.equal(endRow[7], 0.3, "end row keeps the end rate");
    assert.equal(hat.notes, "첫 층 / memo");

    // Draft round trip: reading the file back gives the same values (numbers normalized to text, memo merged into notes).
    const back = Core.draftLayersFromRows(rows);
    assert.equal(back.length, 2);
    assert.equal(back[0].started_at, "2026-09-17 10:02");
    assert.equal(back[0].ended_at, "2026-09-17 10:09");
    assert.equal(back[0].start_rate, "0.1");
    assert.equal(back[0].end_rate, "0.3");
    assert.equal(back[1].end_rate, "0.1", "one rate typed: the end row repeats it like the desktop app");
    assert.equal(back[1].start_pressure, "5.3x10-7");
    assert.equal(back[1].monitor, "51.6129");
    assert.equal(back[1].measured_actual, isTooling ? "9.8" : "");
    const again = Core.draftLayersFromRows(toRows([Core.buildProcessLogSheet({isTooling, layers: back.map(Core.draftLayerToEditorRow), meta})]));
    assert.deepEqual(again, back, "second round trip is stable");

    // Tooling logs: measured actual pairs with the monitor thickness in the Calibration tab.
    if (isTooling) {
      const ms = Core.calibrationMeasurementsFromRows(rows, {material: "Ir(ppy)3", relPath: "Process_Tooling/x.xlsx", name: "x.xlsx", dateStr: "260917"});
      assert.equal(ms.length, 1);
      assert.equal(ms[0].ratio, 9.8 / 51.6129);
      assert.equal(ms[0].source, "O-4");
    }

    // The lab's current desktop app (v10) reads the mobile file the same way.
    const v10 = loadApp(V10);
    v10.__rows = rows;
    vm.runInContext("workbookRows = async () => __rows;", v10);
    const v10Parsed = await vm.runInContext("parseProcessLog({handle: {}})", v10);
    assert.deepEqual(JSON.parse(JSON.stringify(v10Parsed)), JSON.parse(JSON.stringify(parsed)));
  }

  // Presets: co-dep rows split by volume; single rows keep the full thickness; round trip through the sheet.
  const layers = Core.presetToDraftLayers([
    {...Core.STRUCTURE_DEFAULTS, mode: "single", mat1: "HAT-CN", src1: "O-3", tf1: "20", thick: "10", rate: "0.1", mask: "1", mat2: "ignored", vol2: "50"},
    {...Core.STRUCTURE_DEFAULTS, mode: "co-dep", mat1: "CBP", src1: "O-2", tf1: "50", vol1: "94", mat2: "Ir(ppy)3", src2: "O-4", tf2: "100", vol2: "6", thick: "30", rate: "0.3", mask: "2"}
  ]);
  assert.deepEqual(layers.map(l => [l.material, l.target_actual, l.target_rate, l.start_rate, l.mask]), [["HAT-CN", "10", "0.1", "", "1"], ["CBP", "28.2", "0.282", "", "2"], ["Ir(ppy)3", "1.8", "0.018", "", "2"]]);
  assert.match(layers[1].notes, /co-dep CBP:Ir\(ppy\)3/);
  const presetRows = Core.draftLayersToPresetRows(layers);
  const sheets = Core.buildPresetWorkbookSheets(presetRows, {Name: "PhOLED 기본", Author: "홍길동", "Created At": "2026-09-17"});
  assert.equal(sheets[1].sheetTitle, "Info");
  const rereadRows = toRows(sheets);
  assert.deepEqual(Core.structureRowsFromSheet(rereadRows), presetRows);
  assert.deepEqual(Core.presetToDraftLayers(presetRows).map(l => l.target_actual), ["10", "28.2", "1.8"]);

  assert.equal(Core.safeFileName(' EML: "a/b"  구조 '), "EML_ _a_b_ 구조");
  console.log("core drafts: PASS; general/tooling sheet round trip with meta + times, stable re-save, calibration read-back, v10 reads mobile files identically, presets (co-dep split, sheet round trip)");
})().catch(e => { console.error(e); process.exit(1); });
