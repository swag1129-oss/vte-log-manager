// Co-dep target rate: the group's target actual rate splits by volume fraction, and each member's
// monitor setpoint is its share divided by its ratio — the same rule as monitor thickness.
const assert = require("assert/strict");
const Core = require("../src/core/vte-core.js");

// CBP:Ir(ppy)3 at 94:6, group target 1.0 Å/s actual.
const cbp = {material: "CBP", vol: "94", ratio: "0.8", codep_total: "30", codep_rate: "1.0"};
const irppy = {material: "Ir(ppy)3", vol: "6", ratio: "0.5", codep_total: "30", codep_rate: "1.0"};
const members = [cbp, irppy];

assert.equal(Core.codepShareOf(members, cbp, "codep_rate"), "0.94", "CBP takes 94% of the rate");
assert.equal(Core.codepShareOf(members, irppy, "codep_rate"), "0.06");
// Thickness keeps working through the same split.
assert.equal(Core.codepShare(members, cbp), "28.2");
assert.equal(Core.codepShareOf(members, cbp, "codep_total"), "28.2");

// Monitor setpoint = actual share / ratio.
assert.equal(Core.fmt(Core.calcMonitorRate("0.94", cbp.ratio), 4), "1.175", "0.94 / 0.8");
assert.equal(Core.fmt(Core.calcMonitorRate("0.06", irppy.ratio), 4), "0.12", "0.06 / 0.5");

// The shares add back up to the group rate.
const sum = members.reduce((a, m) => a + Number(Core.codepShareOf(members, m, "codep_rate")), 0);
assert.ok(Math.abs(sum - 1.0) < 1e-9);

// Volumes need not add to 100; the split is by fraction of their sum.
const a = {vol: "3", codep_rate: "0.4"}, b = {vol: "1", codep_rate: "0.4"};
assert.equal(Core.codepShareOf([a, b], a, "codep_rate"), "0.3");

// Nothing to split without a group rate or without volumes.
assert.equal(Core.codepShareOf(members, {...cbp, codep_rate: ""}, "codep_rate"), "");
assert.equal(Core.codepShareOf([{vol: ""}, {vol: ""}], {vol: "", codep_rate: "1"}, "codep_rate"), "");
// No ratio, no monitor setpoint.
assert.equal(Core.calcMonitorRate("0.94", ""), null);

console.log("PASS; rate split by volume, monitor setpoint = share / ratio, shares sum back, uneven vols, missing inputs");
