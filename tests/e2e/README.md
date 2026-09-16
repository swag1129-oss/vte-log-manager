# PWA end-to-end check (manual)

Runs the phone flow in headless Chrome against an in-memory fake Dropbox backed by local xlsx copies:
sync → new log from combo → start/end times → reload keeps the draft → save preset → upload → edit in place (rev update)
→ conflict creates a new file → start from preset → delete preset → calibration measurement.

1. `npm run build`, copy `docs/` to a scratch folder, add `fixtures/` (a VTE_MANAGER copy) and `fixtures.json`
   (`[{rel, name, hash}]`), and create `e2e.html` = `index.html` with the fake-Dropbox script inserted before `xlsx.full.min.js`.
   The fake script also sets `vte.testMode=1` (the app default is off). Rebuild `e2e.html` whenever `index.html` changes. The fake `fetch` throws `TypeError("Failed to fetch")` while `window.__offline` is true (offline queue check).
2. Serve the folder on `http://127.0.0.1:8080`.
3. `node tests/e2e/pwa-flow.mjs` prints a JSON report; any `errors` or `error` entry is a failure.

Lab data is never committed; keep fixtures outside the repository.
