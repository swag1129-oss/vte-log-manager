// Process ID (VTE-A222-YYMMDD-HHMM) for the OLED measurement database: issued at save time,
// written into the row-1 metadata, and kept unchanged when an existing log is edited.
const assert = require("assert/strict");
const {XLSX, sheetRows} = require("./helpers.cjs");
const Core = require("../src/core/vte-core.js");

const toRows = sheet => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.aoa), sheet.sheetTitle);
  return sheetRows(XLSX.read(XLSX.write(wb, {bookType: "xlsx", type: "buffer"}), {type: "buffer"}));
};

assert.equal(Core.processId("260917", "1031"), "VTE-A222-260917-1031");
assert.equal(Core.processId("2609", "1031"), "", "a malformed date issues no id");
assert.equal(Core.processId("260917", "9"), "", "a malformed time issues no id");
assert.match(Core.processId("260917"), /^VTE-A222-260917-\d{4}$/, "time defaults to now");

const first = Core.keepProcessId(null, "260917", "1031");
assert.equal(first, "VTE-A222-260917-1031");
assert.equal(Core.keepProcessId({[Core.PROCESS_ID_KEY]: first}, "260918", "1500"), first, "editing keeps the original id");
assert.equal(Core.keepProcessId({Author: "홍길동"}, "260917", "1031"), first, "a log saved before this feature gets one now");

// Round trip through the workbook: the id lands in row 1 after column W and reads back intact.
const layers = Core.draftLayersToEditorRows([{...Core.DRAFT_LAYER_DEFAULTS, material: "HAT-CN", port: "O-3", target_actual: "5"}]);
const meta = {App: "VTE Log PWA test", Author: "홍길동", [Core.PROCESS_ID_KEY]: first};
const rows = toRows(Core.buildProcessLogSheet({isTooling: false, layers, meta, timeTag: "1031"}));
const readBack = Core.readSheetMeta(rows);
assert.equal(readBack[Core.PROCESS_ID_KEY], first, "id survives save and reopen");
assert.equal(readBack.Author, "홍길동", "other metadata is untouched");

console.log("PASS; id format, malformed input, edit keeps original, backfill, workbook round trip");
