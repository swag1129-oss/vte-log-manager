# VTE Log Manager

Deposition log manager for the A222 thermal evaporator (VTE). The desktop app reads and writes the lab's Excel logs in a Dropbox folder; a mobile PWA is planned on the same core (see `PLAN.md`).

## Layout
- `src/core/vte-core.js` — parsing, calibration, and workbook layouts. No DOM or file system; works in the browser (`window.VTECore`) and in Node.
- `src/desktop/` — desktop UI (`ui.js`) and page template. Uses Chrome's File System Access API.
- `scripts/build.cjs` — inlines core + UI into `dist/vte_manager_v11.html` (single file, opens from `file://`).
- `src/mobile/` — PWA: Dropbox login (PKCE), offline cache (IndexedDB), log viewer, calibration lookup. `scripts/build-pwa.cjs` builds it into `docs/` for GitHub Pages: <https://swag1129-oss.github.io/vte-log-manager/>
- `vendor/` — SheetJS CE 0.20.3 (Apache-2.0) for tests.
- `tests/` — `npm test` builds and runs everything.

## Tests
- `app_parser`, `app_calibration`: log parsing and calibration behavior, ported from the v9/v10 tests.
- `writer_equivalence`: v11 saves the same log, calibration, and structure sheets as v10.
- `dropbox_client`: PKCE login, token refresh, paging, Korean paths, root-folder guard, upload modes (fake Dropbox).
- `mobile_model`: the PWA's logs/calibration results match the desktop app on real data (`VTE_DATA`, `VTE_SNAPSHOT`).
- Real lab files are never committed. Tests that need them look for git-ignored files in `tests/fixtures/` and `reference/vte_manager_v10.html`, and skip when they are missing.
- Full-data check: `VTE_DATA=<VTE_MANAGER folder> node scripts/snapshot.cjs <app.html> out.json`, then `node scripts/compare-snapshots.cjs a.json b.json`.
