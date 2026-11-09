const assert = require("assert/strict");
global.localStorage = {getItem: () => null};
const T0 = require("../src/mobile/thick.js"); const T = global.VTEThick || T0;
const m = {port: "A", t0: 1000, t1: 1100, thk0_nm: 0.04, thk1_nm: 300.7, dthk_nm: 300.66, rate_end: 0.2454, rate_avg: 1.025, p0: 17.8, p1: 1.4, temp0: null, temp1: 250, partial: 0};
const L = [m, {...m, port: "B"}];
assert.equal(T.matchLayer(L, "A", 1004500), m);
assert.equal(T.matchLayer(L, "A", 1006000), null, "outside ±5 s");
assert.equal(T.matchLayer(L, "C", 1000000), null, "other port");
let p = T.layerPatch({started_ms: 1000000, ended_ms: 1100000}, m);
assert.equal(p.start_thk, "0.04"); assert.equal(p.end_thk, "300.7"); assert.equal(p.end_power, "1.4"); assert.equal(p.end_temp, "250"); assert.equal(p.start_temp, undefined);
p = T.layerPatch({started_ms: 1000000, start_thk: "5", end_thk: "9", ended_ms: 1100000}, m);
assert.equal(p.start_thk, undefined, "typed value wins"); assert.equal(p.end_thk, undefined);
p = T.layerPatch({started_ms: 1000000, ended_ms: 1200000}, m);
assert.equal(p.end_thk, undefined, "end not matching server close"); assert.equal(p.start_thk, "0.04");
p = T.layerPatch({started_ms: 1000000, ended_ms: 1100000}, {...m, partial: 1});
assert.equal(p.end_thk, undefined, "partial layer has no end values");
// analyze uses server values, keeps typed ones
const r = T.analyze({sensor_port: "A", started_ms: 1000000, ended_ms: 1100000, end_thk: "301"}, 0, [], 1500000, {set() {}}, [], {layers: L});
assert.equal(r.patch.start_thk, "0.04"); assert.equal(r.patch.end_thk, undefined); assert.equal(r.patch.avg_rate, "1.025");
// events
const ev = [{kind: "shutter_open", ts: 900, port: "A", blip: 1}, {kind: "shutter_open", ts: 1000, port: "A", blip: 0}, {kind: "shutter_close", ts: 1100, port: "A", blip: 0}, {kind: "shutter_open", ts: 1000, port: "B", blip: 0}];
let a = {sensor_port: "A"};
assert.equal(T.eventStart(a, [a], ev, 1300000), 1000000, "blip and other port ignored");
assert.equal(T.eventStart({sensor_port: "A", auto_skip_ms: 1000000}, [], ev, 1300000), null);
assert.equal(T.eventStop({sensor_port: "A", started_ms: 1000000}, ev, 1300000), 1100000);
assert.equal(T.eventStop({sensor_port: "A", started_ms: 1000000, auto_end_skip_ms: 1100000}, ev, 1300000), null);
// config
assert.equal(T.applyConfig(null), false); assert.equal(T.applyConfig({sources: {}}), false);
assert.deepEqual(T.sensorFor("O-1"), {port: "B", sensor: 2});
assert.equal(T.applyConfig({sources: {"O-1": {port: "C", sensor: 1}}}), true);
assert.deepEqual(T.sensorFor("O-1"), {port: "C", sensor: 1}); assert.equal(T.sensorFor("O-2"), null);
T.resetConfig(); assert.deepEqual(T.sensorFor("O-2"), {port: "B", sensor: 2});
console.log("thick server layers ok");
