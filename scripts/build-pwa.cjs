// Builds the mobile PWA into docs/ (served by GitHub Pages from main:/docs).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const root = path.resolve(__dirname, "..");
const out = path.join(root, "docs");
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(out, to)), {recursive: true}); fs.copyFileSync(path.join(root, from), path.join(out, to)); };

fs.rmSync(out, {recursive: true, force: true});
const files = {
  "src/mobile/index.html": "index.html",
  "src/mobile/styles.css": "styles.css",
  "src/mobile/app.js": "app.js",
  "src/mobile/data.js": "data.js",
  "src/mobile/dropbox.js": "dropbox.js",
  "src/mobile/store.js": "store.js",
  "src/mobile/editor.js": "editor.js",
  "src/mobile/manifest.webmanifest": "manifest.webmanifest",
  "src/mobile/icons/icon-192.png": "icons/icon-192.png",
  "src/mobile/icons/icon-512.png": "icons/icon-512.png",
  "src/mobile/icons/icon-512-maskable.png": "icons/icon-512-maskable.png",
  "src/mobile/icons/apple-touch-icon.png": "icons/apple-touch-icon.png",
  "src/core/vte-core.js": "vte-core.js",
  "vendor/xlsx.full.min.js": "xlsx.full.min.js",
  "vendor/SheetJS_LICENSE.txt": "third_party/SheetJS_LICENSE.txt"
};
for (const [from, to] of Object.entries(files)) copy(from, to);

// Version = hash of the shipped files, so every change refreshes the service worker cache.
const hash = crypto.createHash("sha256");
for (const to of Object.values(files).sort()) hash.update(to).update(fs.readFileSync(path.join(out, to)));
const version = `${new Date().toISOString().slice(0, 10)}-${hash.digest("hex").slice(0, 8)}`;
const shell = ["./", ...Object.values(files).filter(f => !f.startsWith("third_party/"))];

const appPath = path.join(out, "app.js");
fs.writeFileSync(appPath, fs.readFileSync(appPath, "utf8").replace("__APP_VERSION__", version));
fs.writeFileSync(path.join(out, "sw.js"), fs.readFileSync(path.join(root, "src/mobile/sw.js"), "utf8")
  .replace("__APP_VERSION__", version).replace("__SHELL_FILES__", JSON.stringify(shell)));
fs.writeFileSync(path.join(out, ".nojekyll"), "");
console.log(`docs/ built, version ${version}, ${shell.length} shell files`);
