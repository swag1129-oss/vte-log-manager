const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const XLSX = require(path.join(repo, "vendor/xlsx.full.min.js"));
const DIST = path.join(repo, "dist/vte_manager_v11.html");
const V10 = path.join(repo, "reference/vte_manager_v10.html");
const fixture = name => path.join(__dirname, "fixtures", name);

// Loads the app's inline script into a sandbox without running init().
function loadApp(htmlPath, extra = {}) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/    init\(\);/, "");
  const context = vm.createContext({console, XLSX, ...extra});
  vm.runInContext(script, context);
  return context;
}
const sheetRows = wb => XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1, defval: null});
const readRows = file => sheetRows(XLSX.read(fs.readFileSync(file), {type: "buffer"}));

// Tests that need real lab files skip (not fail) when the local, git-ignored fixtures are missing.
function requireFiles(...files) {
  const missing = files.filter(f => !fs.existsSync(f));
  if (missing.length) {
    console.log(`SKIP: missing ${missing.map(f => path.relative(repo, f)).join(", ")}`);
    return false;
  }
  return true;
}

module.exports = {repo, XLSX, DIST, V10, fixture, loadApp, sheetRows, readRows, requireFiles};
