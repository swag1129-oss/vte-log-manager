// Offline queue: a changed original never spawns a new file; a queued job uploads at most once.
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const {repo, XLSX} = require("./helpers.cjs");
const load = f => fs.readFileSync(path.join(repo, f), "utf8");
const el = new Proxy(function () {}, {get: (t, k) => (k === "addEventListener" ? () => {} : k === Symbol.toPrimitive ? () => "" : el), set: () => true, apply: () => el});
function make({conflict}) {
  const kv = {uploadQueue: []};
  const uploads = [];
  const sandbox = {console, XLSX, navigator: {onLine: true, userAgent: "x"}, localStorage: {getItem: () => null}, alert() {}, confirm: () => true, setTimeout, clearTimeout, setInterval, clearInterval};
  sandbox.window = sandbox; sandbox.document = {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []};
  const ctx = vm.createContext(sandbox);
  for (const f of ["src/core/vte-core.js", "src/mobile/store.js", "src/mobile/editor.js"]) { try { vm.runInContext(load(f), ctx, {filename: f}); } catch (e) { if (f.endsWith("editor.js")) throw e; } }
  const app = {
    store: {get: async k => kv[k], set: async (k, v) => { kv[k] = v; }},
    files: new Map([["a/x_1301.xlsx", {rev: "new", modified: "2026-10-19T12:55:00Z"}]]),
    client: {isLoggedIn: () => true, upload: async (p, b, {rev}) => {
      uploads.push({p, rev});
      if (rev && conflict) { const e = new Error("c"); e.status = 409; e.summary = "path/conflict"; throw e; }
      return {rev: "r2"};
    }}
  };
  const ed = ctx.VTEEditor.create({app, $: () => el, $$: () => [], esc: s => s, status() {}, show() {}, loadModel: async () => {}, openLog() {}, config: {version: "t"}});
  return {ed, kv, uploads};
}
(async () => {
  let t = make({conflict: true});
  t.kv.uploadQueue = [{id: "q1", label: "x", relPath: "a/x_1301.xlsx", rev: "old", fallbackPath: "a/x_1752.xlsx", what: "로그", bytes: new Uint8Array(1)}];
  await Promise.all([t.ed.flushQueue(), t.ed.flushQueue()]);
  assert.equal(t.uploads.length, 1, "one attempt only");
  assert.ok(t.uploads.every(u => u.p === "a/x_1301.xlsx"), "no new file created");
  assert.equal(t.kv.uploadQueue.length, 1, "job kept");
  assert.ok(t.kv.uploadQueue[0].newer && /최신본/.test(t.kv.uploadQueue[0].error));
  await t.ed.flushQueue();
  assert.equal(t.uploads.length, 1, "newer job is skipped on later flushes");
  await t.ed.saveJobAsNew("q1");
  assert.equal(t.uploads[1].p, "a/x_1752.xlsx");
  assert.equal(t.kv.uploadQueue.length, 0);
  t = make({conflict: false});
  t.kv.uploadQueue = [{id: "q2", label: "x", relPath: "a/y.xlsx", rev: null, what: "로그", bytes: new Uint8Array(1)}];
  await Promise.all([t.ed.flushQueue(), t.ed.flushQueue(), t.ed.flushQueue()]);
  assert.equal(t.uploads.length, 1, "concurrent flush uploads once");
  assert.equal(t.kv.uploadQueue.length, 0);
  console.log("queue newer ok");
})().catch(e => { console.error(e); process.exit(1); });
