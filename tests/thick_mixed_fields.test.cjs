const assert = require("assert/strict");
global.localStorage = {getItem: () => null};
const Th = require("../src/mobile/thick.js");
const T = global.VTEThick || Th;
assert.deepEqual(T.healthBadge(95), {text: "health 95%", color: ""});                       // old rows unchanged
assert.equal(T.healthBadge(95, {model: "861"}).text, "health 95%");
assert.equal(T.healthBadge(95, {proto: "360c", crystal: 2}).text, "health 95%");
assert.equal(T.healthBadge(95.4, {proto: "mixed", crystal: 2}).text, "health 95% · 결정 2");
assert.equal(T.healthBadge(95, {proto: "mixed", crystal: null}).text, "health 95%");
assert.equal(T.healthBadge(65, {proto: "mixed", crystal: 1}).color, "#d33");
assert.equal(T.healthBadge(null, {proto: "mixed", crystal: 1}), null);
console.log("ok thick_mixed_fields");
