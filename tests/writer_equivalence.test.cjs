// v11 must write the same sheets as v10 for the same editor input (only the version labels differ).
const assert = require("assert/strict");
const {XLSX, DIST, V10, loadApp, sheetRows, requireFiles} = require("./helpers.cjs");

function fakeDom() {
  const elements = new Map();
  const element = key => {
    if (!elements.has(key)) elements.set(key, {value: "", textContent: "", innerHTML: "", style: {}, dataset: {}, classList: {add() {}, remove() {}}, appendChild() {}, insertAdjacentHTML() {}});
    return elements.get(key);
  };
  return {element, document: {querySelector: element, querySelectorAll: () => [], createElement: () => element(Symbol())}};
}

// Runs one save action in an app and returns {name, sheet, rows}.
async function capture(htmlPath, setup, action) {
  const dom = fakeDom();
  const saved = [];
  const dirHandle = {
    async getDirectoryHandle() { return dirHandle; },
    async getFileHandle(name, opts) { if (!opts?.create) throw new Error("missing"); return {name}; }
  };
  const ctx = loadApp(htmlPath, {document: dom.document, confirm: () => true, alert: msg => { throw new Error(msg); }, window: {}});
  ctx.__dir = dirHandle;
  ctx.__saved = saved;
  vm(ctx, `
    state.appDir = __dir;
    ensureDir = async () => __dir;
    scanAll = async () => {};
    selectMaterial = async () => {};
    renderLayerRows = () => {};
    renderStructureRows = () => {};
    closeModal = () => {};
    writeWorkbookToHandle = async (wb, handle) => { __saved.push({name: handle.name, wb}); };
  `);
  setup(ctx, dom.element);
  await vm(ctx, action);
  assert.equal(saved.length, 1, "exactly one file saved");
  const {name, wb} = saved[0];
  return {name, sheet: wb.SheetNames[0], rows: sheetRows(wb), cols: (wb.Sheets[wb.SheetNames[0]]["!cols"] || []).map(c => c.wch)};
}
function vm(ctx, code) { return require("vm").runInContext(code, ctx); }
const unversion = v => JSON.parse(JSON.stringify(v).replace(/v1[01]/g, "vX"));

const LAYERS = `
  state.layerRows = [];
  addLayerRow({material: "HAT-CN", port: "O-3", mask: "1", tooling_factor: "20", ratio: "1.414", target_actual: "5", rate: "0.1", pressure_pair: "9.6/9.1", power_pair: "4.9/4.9", source_temp_pair: "240/265", notes: "first"});
  addLayerRow({material: "CBP:Ir(ppy)3", port: "O-2", mask: "2", tooling_factor: "50", ratio: "", target_actual: "30", required_monitor: "72.5", measured_actual: "31.2", rate: "0.3/0.02", pressure_pair: "5.1x10-7 -> 4.9x10-7", power_pair: "3.6/3.4", source_temp_pair: "230", notes: ""});
  addLayerRow({material: "  ", port: "O-1"});
  addLayerRow({material: "Al", port: "M-1", mask: "3", tooling_factor: "", ratio: "0.5", target_actual: "100", rate: "1", pressure_pair: "", power_pair: "", source_temp_pair: "-", notes: ""});
`;

async function compare(label, setup, action) {
  const a = await capture(V10, setup, action);
  const b = await capture(DIST, setup, action);
  assert.deepEqual(unversion(b), unversion(a), `${label}: v11 output differs from v10`);
  return b;
}

(async () => {
  if (!requireFiles(V10)) return;
  for (const type of ["일반증착", "툴링"]) {
    const out = await compare(`process log (${type})`, (ctx, el) => {
      el("#newDate").value = "260916";
      el("#newLogType").value = type;
      el("#newMemo").value = "  shared memo ";
      vm(ctx, LAYERS);
    }, "createLog(true)");
    assert.match(out.name, /_v11\.xlsx$/);
  }
  const cal = await compare("calibration", (ctx) => {
    ctx.__form = {"재료명": " TAPC ", "날짜(YYMMDD)": "260916", "소스번호": " O-5 ", "고정TF": "20", "Monitor두께": "50", "Actual두께(ellipsometer)": "22.4",
      "Pressure": " 4.0x10-7 ", "Power": "3.8", "Temp": "190", "Rate": "0.2 A/s", "Density": "1.2", "Acoustic Impedance": "", "비고": " note "};
    vm(ctx, "calValue = label => __form[label] ?? ''; state.editingCalibration = null;");
  }, "saveCalibration(false)");
  assert.equal(cal.name, "260916.xlsx");
  await compare("structure", (ctx) => {
    vm(ctx, `state.editingStructure = null; state.structureRows = [
      {mode: "co-dep", mat1: "CBP", src1: "O-2", tf1: "50", vol1: "94", mat2: "Ir(ppy)3", src2: "O-4", tf2: "100", vol2: "6", mat3: "", src3: "", tf3: "", vol3: "", thick: "30", rate: "0.3", mask: "2"},
      {mode: "single", mat1: "LiF", vol1: "100", thick: "1", mask: "3"}];`);
  }, "saveStructure(true)");

  // Validation messages stay the same.
  for (const [label, form] of [["missing date", {"재료명": "A", "날짜(YYMMDD)": "2609"}], ["no actual", {"재료명": "A", "날짜(YYMMDD)": "260916", "Monitor두께": "10"}]]) {
    const messages = [];
    for (const html of [V10, DIST]) {
      const ctx = loadApp(html, {document: fakeDom().document, confirm: () => true, alert: m => messages.push(m), window: {}});
      ctx.__form = form;
      vm(ctx, "state.appDir = {}; calValue = label => __form[label] ?? '';");
      await vm(ctx, "saveCalibration(false)");
    }
    assert.equal(messages.length, 2, label);
    assert.equal(messages[0], messages[1], label);
  }

  // Structure file round trip through the core reader.
  const {structureRowsFromSheet, buildStructureSheet} = require("../src/core/vte-core.js");
  const rows = [{mode: "co-dep", mat1: "CBP", src1: "O-2", tf1: "50", vol1: "94", mat2: "Ir(ppy)3", src2: "O-4", tf2: "100", vol2: "6", mat3: "", src3: "", tf3: "", vol3: "", thick: "30", rate: "0.3", mask: "2"}];
  const sheet = buildStructureSheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.aoa), sheet.sheetTitle);
  const reread = sheetRows(XLSX.read(XLSX.write(wb, {bookType: "xlsx", type: "buffer"}), {type: "buffer"}));
  assert.deepEqual(structureRowsFromSheet(reread), rows);

  console.log("writer equivalence: PASS; general/tooling process logs, calibration file, structure file, validation messages match v10; structure round trip");
})().catch(e => { console.error(e); process.exit(1); });
