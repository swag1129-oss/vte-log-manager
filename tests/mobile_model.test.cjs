// The mobile data model must match the desktop app on real data (needs VTE_DATA and a desktop snapshot).
// VTE_DATA=<VTE_MANAGER copy> VTE_SNAPSHOT=<scripts/snapshot.cjs output of dist/vte_manager_v11.html> node tests/mobile_model.test.cjs
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const {readRows} = require("./helpers.cjs");
const {createModel} = require("../src/mobile/data.js");

const dataDir = process.env.VTE_DATA, snapshotPath = process.env.VTE_SNAPSHOT;
if (!dataDir || !snapshotPath || !fs.existsSync(dataDir) || !fs.existsSync(snapshotPath)) {
  console.log("SKIP: set VTE_DATA and VTE_SNAPSHOT to compare with the desktop app");
  process.exit(0);
}

const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const files = walk(dataDir)
  .filter(f => /\.xlsx$/i.test(f) && /^(Process_General|Process_Tooling|Calibration)\//.test(path.relative(dataDir, f)))
  .map(f => ({relPath: path.relative(dataDir, f).split(path.sep).join("/"), name: path.basename(f), rows: readRows(f)}));
const model = createModel(files);
const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
const clean = v => sortKeys(JSON.parse(JSON.stringify(v, (k, val) => (k === "handle" || k === "file" ? undefined : val === undefined ? null : Number.isNaN(val) ? "NaN" : val))));
const key = x => JSON.stringify(x);

// Logs: same files, types, dates.
const pick = l => ({relPath: l.relPath, type: l.type, dateStr: l.dateStr, dateKey: l.dateKey});
assert.deepEqual(model.logs.map(pick).sort((a, b) => a.relPath.localeCompare(b.relPath)), snap.logs.map(pick).sort((a, b) => a.relPath.localeCompare(b.relPath)), "log list");

// Every parsed log.
for (const entry of snap.logParses) {
  const log = model.logs.find(l => l.relPath === entry.relPath);
  const {relPath, ...expected} = entry;
  assert.deepEqual(clean(model.parseLog(log)), clean(expected), `parse ${relPath}`);
}

// Materials and calibration measurements (compared per material as sorted multisets; same-date file order is not defined on desktop).
assert.deepEqual(model.materials, snap.materials, "materials");
let measurementCount = 0;
for (const entry of snap.calByMaterial) {
  const expected = entry.files.flatMap(f => f.measurements.map(m => key(clean(m)))).sort();
  const actual = model.calibrationHistory(entry.material).map(m => key(clean(m))).sort();
  assert.deepEqual(actual, expected, `calibration ${entry.material}`);
  measurementCount += actual.length;
}

// Latest ratio per material; a difference is only allowed when two files share the newest date.
let tieNotes = 0;
for (const entry of snap.latestCal) {
  const mine = clean(model.latestCalibration(entry.material));
  const theirs = clean(entry.latest);
  if (key(mine) === key(theirs)) continue;
  const files = model.filesByMaterial.get(entry.material) || [];
  const sameDate = files.filter(f => f.dateStr === mine.date).length > 1;
  assert(sameDate && mine.date === theirs.date, `latest ${entry.material}: ${mine.ratio} (${mine.relPath}) vs ${theirs.ratio} (${theirs.relPath})`);
  tieNotes++;
}

// Material combos: same labels; values equal unless the label's newest entries share a date.
const combos = model.comboOptions();
assert.deepEqual(combos.map(c => c.label), snap.materialComboOptions.map(c => c.label), "combo labels");
let comboTies = 0;
combos.forEach((c, i) => {
  const theirs = clean(snap.materialComboOptions[i]), mine = clean(c);
  if (key(mine) !== key(theirs)) {
    assert.equal(mine.date, theirs.date, `combo ${c.label}`);
    comboTies++;
  }
});

console.log(`mobile model: PASS; ${model.logs.length} logs, ${snap.logParses.length} parses, ${model.materials.length} materials, ${measurementCount} measurements, ${combos.length} combos match desktop (same-date ties: latest ${tieNotes}, combos ${comboTies})`);
