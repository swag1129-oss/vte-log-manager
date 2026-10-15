// Save -> reopen -> re-save keeps per-layer thickness-monitor sensors; the series is re-queried from a mock server.
const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const {XLSX} = require("./helpers.cjs");
const Core = require("../src/core/vte-core.js");

const calls = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  calls.push({port: u.searchParams.get("port"), from: +u.searchParams.get("from"), to: +u.searchParams.get("to")});
  const from = +u.searchParams.get("from");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({rows: [1, 2, 3].map(k => ({ts: from + k, thk_nm: k * 10, rate: 1, power: 5}))}));
});

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  global.localStorage = {getItem: () => `http://127.0.0.1:${server.address().port}`, setItem() {}};
  global.document = {hidden: false};
  new Function(fs.readFileSync(path.join(__dirname, "..", "src", "mobile", "thick.js"), "utf8")).call(global);
  const Thick = global.VTEThick;

  const mk = (material, port, extra = {}) => ({...Core.DRAFT_LAYER_DEFAULTS, material, port, target_actual: "10", ...extra});
  const layers = [mk("HAT-CN", "O1"), mk("TAPC", "O2", {sensor_port: "B", started_ms: 1760000000000, ended_ms: 1760000600000, start_thk: "0", end_thk: "40.2"}), mk("Al", "M1", {sensor_port: "D", started_ms: 1760001000000, ended_ms: 1760001300000})];

  const save = ls => {
    const meta = {App: "t", ...Core.thickToMeta(ls)};
    const sheet = Core.buildProcessLogSheet({isTooling: false, layers: Core.draftLayersToEditorRows(ls), memo: "", meta, timeTag: "1200"});
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sheet.aoa);
    XLSX.utils.book_append_sheet(wb, ws, sheet.sheetTitle);
    return XLSX.write(wb, {bookType: "xlsx", type: "buffer"});
  };
  const reopen = buf => {
    const wb = XLSX.read(buf, {type: "buffer"});
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1, raw: true, defval: null});
    return Core.thickFromMeta(Core.readSheetMeta(rows), Core.draftLayersFromRows(rows));
  };

  let cur = reopen(save(layers));
  for (let round = 0; round < 2; round++) {
    assert.deepEqual(cur.map(l => l.sensor_port || ""), ["", "B", "D"]);
    assert.equal(cur[1].started_ms, 1760000000000);
    assert.equal(cur[1].ended_ms, 1760000600000);
    assert.equal(cur[1].end_thk, "40.2");
    cur = reopen(save(cur));
  }
  calls.length = 0;
  const rows = await Thick.series(cur[1].sensor_port, cur[1].started_ms, cur[1].ended_ms);
  assert.equal(rows.length, 3);
  assert.deepEqual(calls[0], {port: "B", from: 1760000000, to: 1760000600});

  const plain = reopen(save([mk("HAT-CN", "O1"), mk("Al", "M1")]));
  assert.ok(plain.every(l => !l.sensor_port), "no-sensor log unchanged");
  assert.equal(Core.thickToMeta(plain)[Core.THICK_KEY], "");
  console.log("thick roundtrip ok");
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
