// Saving a finished multi-layer log fills every started layer's ThickMon series (layers sharing a sensor included); a dead server fails soft.
const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const Core = require("../src/core/vte-core.js");

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const from = +u.searchParams.get("from"), to = +u.searchParams.get("to");
  res.setHeader("content-type", "application/json");
  if (u.searchParams.get("port") === "D") { res.statusCode = 500; return res.end("{}"); }
  res.end(JSON.stringify({rows: Array.from({length: 20}, (_, k) => ({ts: from + 180 + k, thk_med: k, rate_fit: 1}))}));
});
(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  global.localStorage = {getItem: () => `http://127.0.0.1:${server.address().port}`, setItem() {}};
  global.document = {hidden: false};
  new Function(fs.readFileSync(path.join(__dirname, "..", "src", "mobile", "thick.js"), "utf8")).call(global);
  const Thick = global.VTEThick;
  const t = 1760000000000;
  const mk = (port, k) => ({sensor_port: port, started_ms: t + k * 1e6, ended_ms: t + k * 1e6 + 5e5});
  const layers = [mk("C", 0), mk("C", 1), mk("B", 2), mk("C", 3), mk("D", 4)];
  const {rows, failed} = await Thick.layerSeries(layers, 3000);
  assert.equal(failed, 1);
  const series = layers.flatMap((l, i) => Core.thickSeriesRows(l, i, rows[i]));
  const sheet = Core.thickSheetMerge(null, layers.map((l, i) => Core.thickSummaryRow({...l, material: "m"}, i)), series);
  const parsed = Core.thickSheetParse(sheet);
  for (const n of [1, 2, 3, 4]) assert.ok(parsed.series.filter(r => r[0] === n).length > 1, `layer ${n} rows`);
  assert.equal(parsed.series.filter(r => r[0] === 5).length, 0);
  server.close();
  console.log("ok thick_layer_series");
})().catch(e => { console.error(e); process.exit(1); });
