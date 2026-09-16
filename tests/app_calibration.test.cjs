// Ported from VTE_MANAGER/tests/calibration_v10_test.cjs to run against the v11 build.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const path = require('path');
const {XLSX, DIST, fixture, requireFiles} = require('./helpers.cjs');

function load(file) {
  const html = fs.readFileSync(file, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/    init\(\);/, '');
  const context = vm.createContext({console, XLSX});
  vm.runInContext(script, context);
  vm.runInContext('workbookRows = async (h, maxRows = null, maxCols = null) => { let r = h.rows; if (maxRows) r = r.slice(0, maxRows); if (maxCols) r = r.map(x => Array.from({length: maxCols}, (_, i) => x[i] ?? null)); return r; };', context);
  return context;
}
const sheetRows = wb => XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1, defval: null});
async function measurements(context, rows, material, dateStr = '260101') {
  context.f = {handle: {rows}, name: 'x.xlsx', relPath: 'Process_Tooling/x.xlsx', material, dateStr};
  return vm.runInContext('readCalibrationMeasurements(f)', context);
}

(async () => {
  if (!requireFiles(fixture('tooling_260721_v9.xlsx'))) return;
  const context = load(DIST);

  // Multi-material v9 tooling log: header far below row 8, no measured actual → no ratios, and rows stay per material.
  const multiRows = sheetRows(XLSX.read(fs.readFileSync(fixture('tooling_260721_v9.xlsx'))));
  const ir = await measurements(context, multiRows, 'Ir(ppy)3', '260721');
  assert(ir.length > 0);
  assert(ir.every(m => m.ratio === null && m.actual_thickness === null));
  assert(ir.every(m => m.source === 'O-4' && Number(m.tooling_factor) === 100));
  assert(ir.every(m => !String(m.power).includes('x10')), 'power column must not contain pressure');
  const cbp = await measurements(context, multiRows, 'CBP', '260721');
  assert(cbp.every(m => m.source === 'O-2' && Number(m.tooling_factor) === 50));

  // Tooling log created by v10: measured actual on the start row pairs with the monitor thickness of the end row.
  const elements = new Map();
  const element = key => { if (!elements.has(key)) elements.set(key, {value: '', textContent: '', click() {}, classList: {remove() {}, add() {}}}); return elements.get(key); };
  context.document = {querySelector: element};
  context.confirm = () => true;
  context.alert = message => { throw new Error(message); };
  element('#newDate').value = '260915';
  element('#newLogType').value = '툴링';
  vm.runInContext(`
    state.appDir = {}; ensureDir = async () => ({getFileHandle: async () => ({})}); scanAll = async () => {};
    writeWorkbookToHandle = async wb => { globalThis.savedWorkbook = wb; };
    renderLayerRows = () => {};
    state.layerRows = [];
    addLayerRow({material: 'A', port: 'O-1', tooling_factor: '20', ratio: '0.5', target_actual: '10', measured_actual: '12', rate: '0.1', pressure_pair: '5/4', power_pair: '3/3', source_temp_pair: '200/210'});
    addLayerRow({material: 'B', port: 'O-2', tooling_factor: '50', ratio: '0.4', target_actual: '8', rate: '0.2', pressure_pair: '4/3', power_pair: '4/4', source_temp_pair: '220/230'});
  `, context);
  await vm.runInContext('createLog(true)', context);
  const savedRows = sheetRows(context.savedWorkbook);
  const endA = savedRows.findIndex((row, i) => i > 0 && savedRows[i - 1][8] === 'Start' && savedRows[i - 1][3] === 'A');
  assert.equal(savedRows[endA][9] ?? null, null, 'end row must not store target actual in the Actual Thickness column');
  const a = await measurements(context, savedRows, 'A');
  assert.equal(a.length, 1);
  assert.equal(a[0].monitor_thickness, 20);
  assert.equal(a[0].actual_thickness, 12);
  assert.equal(a[0].ratio, 0.6);
  assert.equal(a[0].source, 'O-1');
  const b = await measurements(context, savedRows, 'B');
  assert.equal(b.length, 1);
  assert.equal(b[0].ratio, null);
  assert.equal(Number(b[0].tooling_factor), 50);

  // Legacy single-material tooling sheet and Calibration/ files keep the old column mapping.
  const legacy = [
    ['Material Density', 1.2, null, 'Pressure (Torr)', 'Power Meter', 'Temperature (C)', 'Rate (A/s)', 'Thickness (nm)', null, '실제 두께'],
    ['Acoustic Impedance', 1.2, null, '5x10-7', 3, 200, 0.1, 'start'],
    ['Tooing Factor', 20, null, '5x10-7', 3, 210, 0.2, 30, null, 15],
    ['Source Number', 'O-3']
  ];
  const l = await measurements(context, legacy, 'Legacy');
  assert.equal(l.length, 1);
  assert.equal(l[0].ratio, 0.5);
  assert.equal(l[0].source, 'O-3');

  // Undated file names no longer invent a date from the material name.
  assert.equal(vm.runInContext('dateStrFromName("Ir(ppy)3_Tooling 100_tooling_v7.xlsx", "Process_Tooling/undated/undated/x.xlsx")', context), '');

  console.log('vte_manager_v11.html: PASS; multi-material tooling log per material, no pressure/temperature column shift, target actual not read as measurement, measured actual pairing, legacy tooling sheet, undated file names');
})().catch(e => { console.error(e); process.exit(1); });
