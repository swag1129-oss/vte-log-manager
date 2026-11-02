// "예열 rate 보기" (co-dep only) moves the pre-Start poll on a port from the first unstarted layer to the watched one.
const assert = require("assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "../src/mobile/thick.js"), "utf8");
const g2d = new Proxy(function () {}, {get: (t, k) => (k === "measureText" ? () => ({width: 10}) : g2d), set: () => true, apply: () => g2d});
const sb = {console, getComputedStyle: () => ({color: "#000"}), VTECore: require("../src/core/vte-core.js"), localStorage: {getItem: () => "http://x", setItem() {}}, document: {hidden: false, addEventListener() {}}, window: {addEventListener() {}, devicePixelRatio: 1}, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
  fetch: async u => ({ok: true, json: async () => (u.includes("/live") ? {ports: {}} : {rows: []})})};
sb.globalThis = sb; vm.createContext(sb); vm.runInContext(src, sb);
const T = sb.VTEThick;
const layers = [{sensor_port: "D"}, {sensor_port: "D"}];
const labels = layers.map(() => ({textContent: "", style: {}}));
const canvases = layers.map((_, i) => ({dataset: {i: String(i)}, closest: () => null, clientWidth: 300, width: 0, height: 0, getContext: () => g2d, style: {}}));
const root = {querySelectorAll: s => (s.startsWith("canvas") ? canvases : []), querySelector: s => { const m = /data-i="(\d)"/.exec(s); return m ? labels[+m[1]] : null; }};
const ctx = {layers: () => layers, set() {}};
(async () => {
  await T.refresh(ctx, root);
  assert.equal(labels[1].textContent, "시작 전");
  assert.equal(T.togglePreWatch(layers[1]), true);
  await T.refresh(ctx, root);
  assert.equal(labels[0].textContent, "시작 전");
  assert.notEqual(labels[1].textContent, "시작 전");
  console.log("thick prewatch ok");
})().catch(e => { console.error(e); process.exit(1); });
