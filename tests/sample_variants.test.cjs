// One run can make more than one kind of sample. Group the nine holder cells by the stack each
// actually received; every group is one sample kind, identified as <process id>-T1, -T2, -T3.
const assert = require("assert/strict");
const Core = require("../src/core/vte-core.js");

const layer = (material, mask) => ({...Core.DRAFT_LAYER_DEFAULTS, material, mask: String(mask), target_actual: "10"});
const ids = out => out.variants.map(v => v.id);
const cells = out => out.variants.map(v => v.cells);
const stacks = (out, layers) => out.variants.map(v => v.layerIndexes.map(i => layers[i].material));

// The drawing: an organic mask over 1,2,3,6,9 as Mask1, the complement as Mask2, and cell 9
// carrying a mask in both — so cell 9 receives both layers and is a third kind of sample.
{
  const layers = [layer("공통층", 3), layer("초록", 1), layer("주황", 2)];
  const holders = {1: "OOOBBOBBO".split(""), 2: "BBBMMBMMM".split(""), 3: Core.emptyMaskHolder()};
  const out = Core.sampleVariants(layers, holders, "VTE-A222-260918-1519");

  assert.equal(out.variants.length, 3, "green, green+orange, orange");
  assert.deepEqual(ids(out), ["VTE-A222-260918-1519-T1", "VTE-A222-260918-1519-T2", "VTE-A222-260918-1519-T3"]);
  assert.deepEqual(cells(out), [[1, 2, 3, 6], [4, 5, 7, 8], [9]]);
  assert.deepEqual(stacks(out, layers), [
    ["공통층", "초록"],
    ["공통층", "주황"],
    ["공통층", "초록", "주황"]
  ]);
  assert.deepEqual(out.unused, [], "every cell received something");
  // Layer order within a kind follows the deposition order, not the holder.
  assert.deepEqual(out.variants[2].layerIndexes, [0, 1, 2]);
}

// Numbering follows the first cell holding each kind, so ids stay put across saves.
{
  const layers = [layer("A", 1)];
  const out = Core.sampleVariants(layers, {1: "BBBBOOOOO".split("")}, "P");
  assert.deepEqual(cells(out), [[5, 6, 7, 8, 9]], "cells 1-4 got nothing");
  assert.deepEqual(out.unused, [1, 2, 3, 4]);
  assert.deepEqual(ids(out), ["P-T1"]);
}

// No holder set up at all: every cell is empty, so all nine substrates are the same single kind.
{
  const layers = [layer("HAT-CN", 1), layer("Al", 2)];
  const out = Core.sampleVariants(layers, Core.maskHoldersFromMeta(null), "P");
  assert.deepEqual(cells(out), [[1, 2, 3, 4, 5, 6, 7, 8, 9]]);
  assert.deepEqual(stacks(out, layers), [["HAT-CN", "Al"]]);
}

// The same material through a different mask patterns differently, so those are separate kinds.
{
  const layers = [layer("Al", 1)];
  const out = Core.sampleVariants(layers, {1: "OOOMMMBBB".split("")}, "P");
  assert.deepEqual(cells(out), [[1, 2, 3], [4, 5, 6]], "organic-masked and metal-masked differ");
  assert.deepEqual(out.unused, [7, 8, 9]);
}

// Rows without a material are placeholders in the editor and take part in nothing.
{
  const layers = [layer("A", 1), {...Core.DRAFT_LAYER_DEFAULTS, mask: "2"}];
  const out = Core.sampleVariants(layers, {1: Core.emptyMaskHolder(), 2: "BBBBBBBBB".split("")}, "P");
  assert.equal(out.variants.length, 1);
  assert.deepEqual(stacks(out, layers), [["A"]]);
}

// Nothing deposited at all: no sample kinds, and no cell is claimed.
{
  const out = Core.sampleVariants([], Core.maskHoldersFromMeta(null), "P");
  assert.deepEqual(out.variants, []);
  assert.deepEqual(out.unused, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
}

// A log without a process id still groups; the ids are just bare.
assert.deepEqual(ids(Core.sampleVariants([layer("A", 1)], Core.maskHoldersFromMeta(null))), ["T1"]);

// The kinds are summarised into the file so a reader does not have to repeat the grouping.
{
  const layers = [layer("공통층", 3), layer("초록", 1), layer("주황", 2)];
  const holders = {1: "OOOBBOBBO".split(""), 2: "BBBMMBMMM".split(""), 3: Core.emptyMaskHolder()};
  assert.deepEqual(Core.samplesToMeta(layers, holders), {[Core.SAMPLES_KEY]: "T1=1,2,3,6; T2=4,5,7,8; T3=9"});
  // A run making one kind of sample is the plain case and adds nothing to the file.
  assert.deepEqual(Core.samplesToMeta(layers, Core.maskHoldersFromMeta(null)), {[Core.SAMPLES_KEY]: ""});
}

console.log("PASS; three kinds from the drawing, stable numbering, unused cells, mask type splits, empty rows");
