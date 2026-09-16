// Runs every test file; exits non-zero if any fails. Real-data tests skip when local fixtures are absent.
const {execFileSync} = require("child_process");
const fs = require("fs");
const path = require("path");
const files = fs.readdirSync(__dirname).filter(f => f.endsWith(".test.cjs")).sort();
let failed = 0;
for (const f of files) {
  try { process.stdout.write(`${f}: ${execFileSync(process.execPath, [path.join(__dirname, f)], {encoding: "utf8"})}`); }
  catch (e) { failed++; console.error(`${f}: FAIL\n${e.stdout || ""}${e.stderr || ""}`); }
}
if (failed) { console.error(`${failed} test file(s) failed`); process.exit(1); }
