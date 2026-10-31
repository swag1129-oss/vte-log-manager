// 18 layers on one screen must not make /range traffic scale with layer count: unstarted layers share one "pre" poll, ended ones fetch once.
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "../src/mobile/thick.js"), "utf8");
const urls = [];
const store = {getItem: () => "http://x", setItem() {}};
const g2d = new Proxy(function () {}, {get: (t, k) => (k === "measureText" ? () => ({width: 10}) : g2d), set: () => true, apply: () => g2d});
const sandbox = {console, getComputedStyle: () => ({color: "#000"}), VTECore: require("../src/core/vte-core.js"), localStorage: store, document: {hidden: false, addEventListener() {}}, window: {addEventListener() {}, devicePixelRatio: 1}, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
  fetch: async u => { urls.push(u); return {ok: true, json: async () => (u.includes("/live") ? {ports: {}} : {rows: []})}; }};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const T = sandbox.VTEThick;
const now = Date.now(), layers = [];
for (let i = 0; i < 18; i++) layers.push({sensor_port: i % 2 ? "B" : "D", started_ms: i < 6 ? now - 7200000 + i * 60000 : 0, ended_ms: i < 6 ? now - 3600000 + i * 60000 : 0});

const canvases = layers.map((_, i) => ({dataset: {i: String(i)}, closest: () => null, clientWidth: 300, width: 0, height: 0, getContext: () => g2d, style: {}}));
const root = {querySelectorAll: s => (s.startsWith("canvas") ? canvases : []), querySelector: () => null};
const ctx = {layers: () => layers, set() {}};
(async () => {
  for (let k = 0; k < 3; k++) { await T.refresh(ctx, root); }
  const ranges = urls.filter(u => u.includes("/range"));
  const uniq = new Set(ranges.map(u => u.split("&to=")[0]));
  console.log("range calls", ranges.length, "unique", uniq.size);
  assert.ok(ranges.length <= 6 + 2 * 3, "ended layers fetch once each, plus at most one pre chunk per port per refresh");
})().catch(e => { console.error(e); process.exit(1); });
