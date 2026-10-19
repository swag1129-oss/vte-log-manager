// 28-layer log, ~1 MB /range replies: requests are bounded in flight, slow ones are not killed by queueing, first-try failures are retried.
const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

let inflight = 0, peak = 0;
const tries = new Map();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const from = +u.searchParams.get("from");
  const n = (tries.get(from) || 0) + 1;
  tries.set(from, n);
  inflight++; peak = Math.max(peak, inflight);
  setTimeout(() => {
    inflight--;
    if (n === 1 && from % 3 === 0) { res.statusCode = 503; return res.end("{}"); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({rows: Array.from({length: 2500}, (_, k) => ({ts: from + 180 + k, thk_med: k, rate_fit: 1}))}));
  }, 120);
});
(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  global.localStorage = {getItem: () => `http://127.0.0.1:${server.address().port}`, setItem() {}};
  global.document = {hidden: false};
  new Function(fs.readFileSync(path.join(__dirname, "..", "src", "mobile", "thick.js"), "utf8")).call(global);
  const t = 1760000000000;
  const layers = Array.from({length: 28}, (_, k) => ({sensor_port: "BCD"[k % 3], started_ms: t + k * 1e6, ended_ms: t + k * 1e6 + 5e5}));
  const {rows, failed} = await global.VTEThick.layerSeries(layers);
  assert.equal(failed, 0);
  assert.ok(rows.every(r => r.length > 100 && r.length <= 600));
  assert.ok(peak <= 4, `peak in flight ${peak}`);
  server.close();
  console.log("ok thick_layer_series_28");
})().catch(e => { console.error(e); process.exit(1); });
