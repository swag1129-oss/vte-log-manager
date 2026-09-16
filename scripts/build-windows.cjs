// Builds the Windows package (dist/windows/VTE_Log_Manager_v11_Windows.zip) from the desktop v11 app.
// Same layout as the v9 package: launcher/installer scripts, app/ with SheetJS bundled for offline use, empty VTE_DATA folders.
const fs = require("fs");
const path = require("path");
const {execFileSync} = require("child_process");
const root = path.resolve(__dirname, "..");
const out = path.join(root, "dist/windows");
const pkg = path.join(out, "VTE_Log_Manager_Windows");
const today = new Date().toISOString().slice(0, 10);
const crlf = text => text.replace(/\r?\n/g, "\r\n");

fs.rmSync(out, {recursive: true, force: true});
for (const dir of ["app/vendor", "app/third_party_licenses", ...["Process_General", "Process_Tooling", "Calibration", "Structures", "Presets"].map(d => `VTE_DATA/${d}`)]) {
  fs.mkdirSync(path.join(pkg, dir), {recursive: true});
}
const html = fs.readFileSync(path.join(root, "dist/vte_manager_v11.html"), "utf8");
const cdn = '<script src="https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js"></script>';
if (!html.includes(cdn)) throw new Error("SheetJS script tag not found in dist/vte_manager_v11.html");
fs.writeFileSync(path.join(pkg, "app/VTE_Log_Manager.html"), html.replace(cdn, '<script src="vendor/xlsx.full.min.js"></script>'));
fs.copyFileSync(path.join(root, "vendor/xlsx.full.min.js"), path.join(pkg, "app/vendor/xlsx.full.min.js"));
fs.copyFileSync(path.join(root, "vendor/SheetJS_LICENSE.txt"), path.join(pkg, "app/third_party_licenses/SheetJS_LICENSE.txt"));
// cmd.exe needs CRLF line endings for `call :label` to work reliably.
for (const f of ["START_VTE_WINDOWS.cmd", "INSTALL_WINDOWS.cmd"]) fs.writeFileSync(path.join(pkg, f), crlf(fs.readFileSync(path.join(root, "packaging/windows", f), "utf8")));
fs.writeFileSync(path.join(pkg, "VTE_DATA/SELECT_THIS_FOLDER.txt"), fs.readFileSync(path.join(root, "packaging/windows/SELECT_THIS_FOLDER.txt")));
fs.writeFileSync(path.join(pkg, "README_FIRST.txt"), crlf(fs.readFileSync(path.join(root, "packaging/windows/README_FIRST.txt"), "utf8").replace("@@DATE@@", today)));
fs.writeFileSync(path.join(pkg, "VERSION.txt"), crlf(`VTE Log Manager v11\nWindows portable/installer package\nBuild date: ${today}\nBundled SheetJS CE: 0.20.3\n`));

const zip = path.join(out, "VTE_Log_Manager_v11_Windows.zip");
execFileSync("zip", ["-qr", "-X", zip, "VTE_Log_Manager_Windows"], {cwd: out});
console.log(`${path.relative(root, zip)} ${fs.statSync(zip).size} bytes`);
