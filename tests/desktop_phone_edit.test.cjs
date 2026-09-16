// Desktop v11 editing a phone log keeps the phone extras: metadata, start/end times, end rate and co-dep groups.
const assert = require("assert/strict");
const vm = require("vm");
const {XLSX, DIST, loadApp, sheetRows} = require("./helpers.cjs");
const Core = require("../src/core/vte-core.js");

const toRows = sheet => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.aoa), sheet.sheetTitle);
  return sheetRows(XLSX.read(XLSX.write(wb, {bookType: "xlsx", type: "buffer"}), {type: "buffer"}));
};

(async () => {
  const draft = [
    {...Core.DRAFT_LAYER_DEFAULTS, material: "HAT-CN", port: "O-3", target_actual: "5", ratio: "1.3", start_rate: "0.1", end_rate: "0.3", start_temp: "240", end_temp: "265",
      started_at: "2026-09-17 10:02", ended_at: "2026-09-17 10:09", notes: "first"},
    {...Core.DRAFT_LAYER_DEFAULTS, material: "CBP", port: "O-2", ratio: "0.8", codep: "g1", vol: "94", codep_total: "30", target_actual: "28.2", start_rate: "0.5", end_rate: "0.6",
      started_at: "2026-09-17 10:12", ended_at: "2026-09-17 10:30", notes: "EML"},
    {...Core.DRAFT_LAYER_DEFAULTS, material: "Ir(ppy)3", port: "O-4", ratio: "0.2", codep: "g1", vol: "6", codep_total: "30", target_actual: "1.8", start_rate: "0.15", end_rate: "0.15",
      started_at: "2026-09-17 10:12", ended_at: "2026-09-17 10:30", notes: "EML"}
  ];
  const meta = {App: "VTE Log PWA test", Author: "홍길동", Device: "iPhone", "Created At": "2026-09-17 10:31"};
  const phoneRows = toRows(Core.buildProcessLogSheet({isTooling: false, layers: Core.draftLayersToEditorRows(draft), meta, timeTag: "1031"}));

  const app = loadApp(DIST);
  const el = new Map();
  app.document = {querySelector: key => el.get(key) || el.set(key, {value: "", textContent: "", click() {}, classList: {add() {}, remove() {}}}).get(key)};
  app.confirm = () => true;
  app.alert = message => { throw new Error(message); };
  app.phoneRows = phoneRows;
  vm.runInContext(`workbookRows = async h => h; renderLayerRows = () => {}; closeModal = () => {};
    state.appDir = {}; ensureDir = async () => ({getFileHandle: async () => ({})}); scanAll = async () => {};
    writeWorkbookToHandle = async wb => { globalThis.savedWorkbook = wb; };`, app);

  const saveAfter = async edit => {
    await vm.runInContext(`loadLogIntoCreator({handle: phoneRows, dateStr: "260917", type: "일반증착", relPath: "x", filename: "x.xlsx"})`, app);
    vm.runInContext(edit, app);
    el.get("#newDate").value = "260917";
    el.get("#newLogType").value = "일반증착";
    await vm.runInContext("createLog(false)", app);
    return sheetRows(app.savedWorkbook);
  };

  // Unchanged save: everything the phone wrote reads back the same.
  let saved = await saveAfter("");
  const back = Core.draftLayersFromRows(saved);
  const pick = ls => ls.map(l => [l.material, l.started_at, l.ended_at, l.start_rate, l.end_rate, l.codep ? "co" : "", l.vol, l.codep_total, l.notes]);
  assert.deepEqual(pick(back), pick(Core.draftLayersFromRows(phoneRows)));
  const savedMeta = Core.readSheetMeta(saved);
  assert.equal(savedMeta.Author, "홍길동");
  assert.equal(savedMeta["Modified By"], "PC v11");
  assert.equal(Core.parseProcessRows(saved).layers.CBP[0].notes, "co-dep CBP:Ir(ppy)3 (94 vol%) / EML", "tag not duplicated");

  // Changing a start rate on the PC drops the stale end rate from the phone.
  saved = await saveAfter(`state.layerRows[0].rate = "0.2";`);
  const changed = Core.draftLayersFromRows(saved)[0];
  assert.deepEqual([changed.start_rate, changed.end_rate], ["0.2", "0.2"]);

  console.log("desktop phone edit: PASS; PC v11 edit keeps author metadata, times, end rates, co-dep groups; stale end rate dropped");
})().catch(e => { console.error(e); process.exit(1); });
