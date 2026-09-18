// Mask holder: 9 cells (1 2 3 / 4 5 6 / 7 8 9), each empty, organic, metal or block. The
// arrangement changes per run, so every log records its own three holders in the row-1 metadata.
const assert = require("assert/strict");
const {XLSX, sheetRows} = require("./helpers.cjs");
const Core = require("../src/core/vte-core.js");

const toRows = sheet => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.aoa), sheet.sheetTitle);
  return sheetRows(XLSX.read(XLSX.write(wb, {bookType: "xlsx", type: "buffer"}), {type: "buffer"}));
};

assert.equal(Core.emptyMaskHolder().length, 9);
assert.deepEqual(Core.MASK_CELLS.map(c => c.token), [".", "O", "M", "B"]);

// The drawing's example: 4, 5, 7 and 8 blocked, the rest carrying an organic mask.
const mask1 = "OOOBBOBBO".split("");
assert.equal(Core.formatMaskHolder(mask1), "OOOBBOBBO");
assert.deepEqual(Core.maskHolderCoverage(mask1), [1, 2, 3, 6, 9], "blocked cells get nothing");
// Mask2 is the complement, so one run yields two kinds of sample.
assert.deepEqual(Core.maskHolderCoverage("BBBMMBMMB".split("")), [4, 5, 7, 8]);
// An empty cell deposits over the whole substrate, unlike a block.
assert.deepEqual(Core.maskHolderCoverage(Core.emptyMaskHolder()), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.deepEqual(Core.maskHolderCoverage(".O.B.....".split("")), [1, 2, 3, 5, 6, 7, 8, 9]);

assert.deepEqual(Core.parseMaskHolder("OOOBBOBBO"), mask1);
assert.deepEqual(Core.parseMaskHolder("o o o b b o b b o"), mask1, "spacing and case are forgiving");
assert.deepEqual(Core.parseMaskHolder("O,O,O,B,B,O,B,B,O"), mask1, "commas too");
assert.deepEqual(Core.parseMaskHolder("OOX"), "OO.......".split(""), "unknown and missing tokens read as empty");
assert.deepEqual(Core.parseMaskHolder(""), Core.emptyMaskHolder(), "a log without holders reads as all empty");
assert.deepEqual(Core.parseMaskHolder(undefined), Core.emptyMaskHolder());

// An all-empty holder says nothing the default does not, so it stays out of the file.
assert.equal(Core.formatMaskHolder(Core.emptyMaskHolder()), "");
assert.ok(Core.maskHolderIsDefault([]), "a malformed holder counts as default");
assert.ok(!Core.maskHolderIsDefault(mask1));

// Round trip through the workbook alongside the other metadata.
const holders = {1: mask1, 2: "BBBMMBMMB".split(""), 3: Core.emptyMaskHolder()};
const layers = Core.draftLayersToEditorRows([{...Core.DRAFT_LAYER_DEFAULTS, material: "Al", port: "M-1", mask: "2", target_actual: "100"}]);
const meta = {[Core.PROCESS_ID_KEY]: "VTE-A222-260918-1519", ...Core.maskHoldersToMeta(holders)};
const readBack = Core.readSheetMeta(toRows(Core.buildProcessLogSheet({isTooling: false, layers, meta, timeTag: "1519"})));
assert.equal(readBack[Core.maskHolderKey(1)], "OOOBBOBBO");
assert.equal(readBack[Core.maskHolderKey(3)], undefined, "an untouched holder is not written");
const loaded = Core.maskHoldersFromMeta(readBack);
assert.deepEqual(loaded[1], mask1);
assert.deepEqual(loaded[2], holders[2]);
assert.deepEqual(loaded[3], Core.emptyMaskHolder(), "a missing holder loads as all empty");
assert.equal(readBack[Core.PROCESS_ID_KEY], "VTE-A222-260918-1519", "other metadata is untouched");

console.log("PASS; cell tokens, coverage incl. empty vs block, forgiving parse, default omitted, workbook round trip");
