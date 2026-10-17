/*
 * Offline cache (IndexedDB) and Dropbox sync for the PWA.
 * Each cached file keeps its Dropbox content hash and the parsed sheet rows, so later syncs only download changed files.
 */
(function (root) {
  "use strict";
  const DB_NAME = "vte-log-manager";
  const DB_VERSION = 1;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", {keyPath: "relPath"});
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  const result = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

  async function createStore() {
    const db = await openDb();
    return {
      async allFiles() { return result(db.transaction("files").objectStore("files").getAll()); },
      async getFile(relPath) { return result(db.transaction("files").objectStore("files").get(relPath)); },
      async putFile(file) { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").put(file); await done(tx); },
      async deleteFiles(relPaths) {
        if (!relPaths.length) return;
        const tx = db.transaction("files", "readwrite");
        relPaths.forEach(p => tx.objectStore("files").delete(p));
        await done(tx);
      },
      async get(key) { return result(db.transaction("kv").objectStore("kv").get(key)); },
      async set(key, value) { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(value, key); await done(tx); },
      async clear() {
        const tx = db.transaction(["files", "kv"], "readwrite");
        tx.objectStore("files").clear();
        tx.objectStore("kv").clear();
        await done(tx);
      }
    };
  }

  const LOG_FOLDERS = /^(_mobile_test\/)?(Process_General|Process_Tooling|Calibration|Structures|Presets)\//;
  // The first sheet is read exactly as before. Every further sheet (ThickMon, or anything an older tool added) is kept as plain rows
  // so an edit can write it back unchanged.
  const readWorkbook = (XLSX, data) => {
    const wb = XLSX.read(data instanceof Uint8Array ? data : new Uint8Array(data), {type: "array", cellDates: false});
    const grid = name => XLSX.utils.sheet_to_json(wb.Sheets[name], {header: 1, raw: true, defval: null});
    return {rows: grid(wb.SheetNames[0]), extra: wb.SheetNames.slice(1).map(name => ({name, aoa: grid(name)}))};
  };
  const readRows = (XLSX, data) => readWorkbook(XLSX, data).rows;
  // After an upload, cache what was written so the app shows it without a full sync.
  async function cacheUploaded({store, XLSX, relPath, data, result}) {
    await store.putFile({relPath, name: relPath.split("/").pop(), rev: result.rev, contentHash: result.content_hash, modified: result.server_modified, ...readWorkbook(XLSX, data)});
  }

  /*
   * Brings the cache in line with Dropbox. `onProgress({phase, done, total, relPath})`.
   * Files that fail to download or parse keep their previous cached copy and are reported in `failed`.
   */
  async function sync({client, store, XLSX, onProgress = () => {}, concurrency = 4}) {
    onProgress({phase: "list", done: 0, total: 0});
    const remote = (await client.listFiles()).filter(f => LOG_FOLDERS.test(f.relPath));
    const cached = new Map((await store.allFiles()).map(f => [f.relPath, f]));
    const changed = remote.filter(f => cached.get(f.relPath)?.contentHash !== f.contentHash);
    const remotePaths = new Set(remote.map(f => f.relPath));
    const removed = [...cached.keys()].filter(p => !remotePaths.has(p));
    await store.deleteFiles(removed);

    const failed = [];
    let finished = 0, next = 0;
    onProgress({phase: "download", done: 0, total: changed.length});
    async function worker() {
      while (next < changed.length) {
        const f = changed[next++];
        try {
          const {data, rev, contentHash} = await client.download(f.relPath);
          await store.putFile({relPath: f.relPath, name: f.name, rev: rev || f.rev, contentHash: contentHash || f.contentHash, modified: f.modified, ...readWorkbook(XLSX, data)});
        } catch (err) {
          failed.push({relPath: f.relPath, error: String(err.message || err)});
        }
        finished++;
        onProgress({phase: "download", done: finished, total: changed.length, relPath: f.relPath});
      }
    }
    await Promise.all(Array.from({length: Math.min(concurrency, changed.length)}, worker));
    const syncedAt = new Date().toISOString();
    await store.set("lastSync", {at: syncedAt, files: remote.length, downloaded: changed.length - failed.length, removed: removed.length, failed});
    return {files: remote.length, downloaded: changed.length - failed.length, removed: removed.length, failed, at: syncedAt};
  }

  root.VTEStore = {createStore, sync, cacheUploaded, readWorkbook};
})(typeof globalThis !== "undefined" ? globalThis : this);
