// snapshot.cjs — run the VTE Log Manager app headlessly against real data and
// dump a deterministic JSON snapshot of everything it computes.
//
// Usage: VTE_DATA=<folder with Process_General, Process_Tooling, Calibration> node scripts/snapshot.cjs <app.html> <out.json>
// Compare two snapshots with scripts/compare-snapshots.cjs.
//
// Mock the File System Access API
// with dirH()/fileH() wrappers over a local folder, stub out `document`, and
// run the app's inline <script> in a vm context. Then call the app's own
// top-level functions (parseProcessLog, readCalibrationMeasurements,
// readCalibrationMeta, getLatestCalibration) to record results.

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));

const DATA_DIR = process.env.VTE_DATA || path.join(__dirname, '..', 'tests', 'snapshots', 'data');

const [, , htmlFile, outFile] = process.argv;
if (!htmlFile || !outFile) {
  console.error('Usage: node snapshot.cjs <app.html> <out.json>');
  process.exit(2);
}

// ---- File System Access API mocks (same shape as fullscan.cjs) ----
function dirH(p) {
  return {
    kind: 'directory',
    name: path.basename(p),
    async getDirectoryHandle(n) {
      const q = path.join(p, n);
      if (!fs.existsSync(q)) throw new Error('nf');
      return dirH(q);
    },
    async *entries() {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        yield [e.name, e.isDirectory() ? dirH(path.join(p, e.name)) : fileH(path.join(p, e.name))];
      }
    }
  };
}
function fileH(p) {
  return {
    kind: 'file',
    name: path.basename(p),
    async getFile() {
      const b = fs.readFileSync(p);
      return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    }
  };
}

// ---- minimal DOM stub ----
const el = () => ({
  value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
  classList: { add() {}, remove() {} },
  appendChild() {}, insertAdjacentHTML() {}, addEventListener() {}
});
const els = new Map();
const document = {
  querySelector: k => { if (!els.has(k)) els.set(k, el()); return els.get(k); },
  querySelectorAll: () => [],
  createElement: () => el()
};

const ctx = vm.createContext({ console, XLSX, document, window: {}, alert() {}, confirm: () => true });

const html = fs.readFileSync(htmlFile, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.error('Could not find inline <script> block in ' + htmlFile);
  process.exit(2);
}
const appSrc = scriptMatch[1].replace(/    init\(\);/, '');
vm.runInContext(appSrc, ctx);
ctx.root = dirH(DATA_DIR);

// ---- sanitizer: deterministic, JSON-safe, drops `handle`, sorts object keys ----
function sanitize(value) {
  if (value === undefined) return null;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (value instanceof Map) return sanitize(Object.fromEntries(value.entries()));
  const keys = Object.keys(value).filter(k => k !== 'handle').sort();
  const out = {};
  for (const k of keys) out[k] = sanitize(value[k]);
  return out;
}

(async () => {
  await vm.runInContext('state.appDir = root; scanAll()', ctx);

  const collectSrc = `
    (async () => {
      const logsOut = state.logs.map(l => ({
        relPath: l.relPath, filename: l.filename, type: l.type,
        dateStr: l.dateStr, dateKey: l.dateKey
      }));

      const logParses = [];
      for (const log of state.logs) {
        let entry;
        try {
          const res = await parseProcessLog(log);
          entry = { relPath: log.relPath, material_list: res.material_list, layers: res.layers };
          if (res.error) entry.parseError = res.error;
        } catch (e) {
          entry = { relPath: log.relPath, error: String((e && e.message) || e) };
        }
        logParses.push(entry);
      }

      const materials = state.materials.slice();

      const calByMaterial = [];
      for (const mat of materials) {
        const files = state.calFilesByMaterial.get(mat) || [];
        const fileEntries = [];
        for (const f of files) {
          let measurements, meta;
          try { measurements = await readCalibrationMeasurements(f); }
          catch (e) { measurements = { error: String((e && e.message) || e) }; }
          try { meta = await readCalibrationMeta(f); }
          catch (e) { meta = { error: String((e && e.message) || e) }; }
          fileEntries.push({ relPath: f.relPath, measurements, meta });
        }
        calByMaterial.push({ material: mat, files: fileEntries });
      }

      const latestCal = [];
      for (const mat of materials) {
        let latest;
        try { latest = await getLatestCalibration(mat); }
        catch (e) { latest = { error: String((e && e.message) || e) }; }
        latestCal.push({ material: mat, latest });
      }

      const combos = state.materialComboOptions;

      return { logsOut, logParses, materials, calByMaterial, latestCal, combos };
    })()
  `;

  let result;
  try {
    result = await vm.runInContext(collectSrc, ctx);
  } catch (e) {
    console.error('Fatal error running app in vm context: ' + (e && e.stack || e));
    process.exit(1);
  }

  const snapshot = {
    logs: sanitize(result.logsOut),
    logParses: sanitize(result.logParses),
    materials: sanitize(result.materials),
    calByMaterial: sanitize(result.calByMaterial),
    latestCal: sanitize(result.latestCal),
    materialComboOptions: sanitize(result.combos)
  };

  fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2));
  console.log(`Wrote ${outFile}`);
  console.log(`  logs: ${snapshot.logs.length}`);
  console.log(`  materials: ${snapshot.materials.length}`);
  const totalMeasurements = snapshot.calByMaterial.reduce((s, m) => s + m.files.reduce((s2, f) => s2 + (Array.isArray(f.measurements) ? f.measurements.length : 0), 0), 0);
  console.log(`  calibration measurements: ${totalMeasurements}`);
  console.log(`  materialComboOptions: ${snapshot.materialComboOptions.length}`);
})().catch(e => {
  console.error('Unhandled error: ' + (e && e.stack || e));
  process.exit(1);
});
