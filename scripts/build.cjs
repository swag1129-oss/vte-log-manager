// Builds the single-file desktop app (dist/vte_manager_v11.html) from the core module and the desktop UI script.
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
const template = read("src/desktop/template.html");
const html = template
  .replace("/*@@CORE@@*/", () => read("src/core/vte-core.js"))
  .replace("/*@@UI@@*/", () => read("src/desktop/ui.js"));
fs.mkdirSync(path.join(root, "dist"), {recursive: true});
fs.writeFileSync(path.join(root, "dist/vte_manager_v11.html"), html);
console.log(`dist/vte_manager_v11.html ${html.length} bytes`);
