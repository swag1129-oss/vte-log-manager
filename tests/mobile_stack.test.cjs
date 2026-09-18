// Structure panel draws the top layer first and the substrate last, so nothing is clipped by
// the panel's scroll overflow. Repeated materials (CBP / Ir(ppy)3 around PtOEP) must keep order.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const els = {};
const el = () => ({classList: {toggle() {}}, textContent: "", innerHTML: "", set onclick(_) {}});
global.localStorage = {getItem: () => "0", setItem() {}};
global.document = {querySelector: sel => (els[sel] ||= el())};
new Function(fs.readFileSync(path.join(__dirname, "..", "src", "mobile", "stack.js"), "utf8")).call(global);

const layer = (material, thick) => ({parts: [{material, thick}], mask: "", state: "", jump: 0});
const items = [
  layer("HAT-CN", 10), layer("TAPC", 40), layer("CBP", 5), layer("PtOEP", 3),
  layer("CBP", 5), layer("B3PymPm", 45), layer("LiF", 1), layer("Al", 100),
];
global.VTEStack.render(items, {totalText: "총 209 nm"});

const html = els["#structureBody"].innerHTML;
const order = [...html.matchAll(/class="part"[^>]*>([^<]+)</g)].map(m => m[1]);
assert.deepStrictEqual(order, items.map(it => it.parts[0].material).reverse(), "top layer first");
assert.ok(html.indexOf("총 209 nm") < html.indexOf("Al"), "total above the top layer");
assert.ok(html.lastIndexOf("기판") > html.lastIndexOf("HAT-CN"), "substrate last");
// PtOEP stays sandwiched between the two CBP layers after reversal.
assert.deepStrictEqual(order.slice(3, 6), ["CBP", "PtOEP", "CBP"], "repeated materials keep order");

// With several kinds of sample the panel offers a tab per kind and names the substrates it sits on.
const variants = [{n: 1, cells: [1, 2, 3, 6]}, {n: 2, cells: [4, 5, 7, 8]}, {n: 3, cells: [9]}];
global.VTEStack.render(items.slice(0, 2), {variants, selected: 2});
const tabs = els["#structureTabs"].innerHTML;
assert.deepStrictEqual([...tabs.matchAll(/data-variant="(\d)"/g)].map(m => m[1]), ["1", "2", "3"]);
assert.match(tabs, /class="stack-tab active" data-variant="2"/, "the selected kind is marked");
assert.equal(els["#structureCells"].textContent, "기판 4,5,7,8");

// A single kind needs no tabs, and the strip is emptied rather than left stale.
global.VTEStack.render(items, {variants: [{n: 1, cells: [1, 2, 3, 4, 5, 6, 7, 8, 9]}]});
assert.equal(els["#structureTabs"].innerHTML, "");
assert.equal(els["#structureCells"].textContent, "");

console.log("PASS; top-first order, total placement, substrate last, repeated-material sandwich, sample tabs");
