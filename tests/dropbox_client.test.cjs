// Dropbox client against a fake Dropbox: PKCE login, refresh, paging, Korean paths, root guard, upload modes.
const assert = require("assert/strict");
const {webcrypto} = require("crypto");
const {createClient, headerJson} = require("../src/mobile/dropbox.js");

function memoryStorage() {
  const m = new Map();
  return {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k)};
}
function response(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300, status,
    headers: {get: k => headers[k] ?? null},
    json: async () => JSON.parse(text), text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer
  };
}

(async () => {
  const ROOT = "/NEXT LAB/Log/A222/VTE log/VTE_MANAGER";
  const calls = [];
  let accessTokens = 0, expireNext = false;
  const fetch = async (url, init) => {
    calls.push({url, init});
    if (url.endsWith("/oauth2/token")) {
      const form = new URLSearchParams(init.body);
      if (form.get("grant_type") === "authorization_code") {
        assert.equal(form.get("code"), "CODE");
        assert.ok(form.get("code_verifier").length >= 43);
        return response(200, {access_token: `A${++accessTokens}`, refresh_token: "R", expires_in: 14400, account_id: "dbid:1"});
      }
      assert.equal(form.get("refresh_token"), "R");
      return response(200, {access_token: `A${++accessTokens}`, expires_in: 14400});
    }
    const auth = init.headers.Authorization;
    if (expireNext) { expireNext = false; return response(401, {error_summary: "expired_access_token/"}); }
    assert.match(auth, /^Bearer A\d+$/);
    if (url.endsWith("/files/list_folder")) {
      const args = JSON.parse(init.body);
      assert.equal(args.path, ROOT);
      assert.equal(args.recursive, true);
      return response(200, {entries: [
        {".tag": "folder", name: "Process_General", path_display: `${ROOT}/Process_General`},
        {".tag": "file", name: "HAT-CN, 증착_general_v9.xlsx", path_display: `${ROOT}/Process_General/2026/260904/HAT-CN, 증착_general_v9.xlsx`, path_lower: "x", rev: "r1", content_hash: "h1", size: 10, server_modified: "2026-09-04T00:00:00Z"},
        {".tag": "file", name: "notes.txt", path_display: `${ROOT}/notes.txt`}
      ], has_more: true, cursor: "C1"});
    }
    if (url.endsWith("/files/list_folder/continue")) {
      assert.equal(JSON.parse(init.body).cursor, "C1");
      return response(200, {entries: [{".tag": "file", name: "260915.xlsx", path_display: `${root2()}/Calibration/HAT-CN/260915.xlsx`, path_lower: "y", rev: "r2", content_hash: "h2", size: 5}], has_more: false});
    }
    if (url.endsWith("/files/download")) {
      const raw = init.headers["Dropbox-API-Arg"];
      assert.ok(/^[\x00-\x7f]*$/.test(raw), "header must be ASCII");
      assert.equal(JSON.parse(raw).path, `${ROOT}/Process_General/2026/260904/HAT-CN, 증착_general_v9.xlsx`);
      return response(200, "xlsx-bytes", {"Dropbox-API-Result": headerJson({rev: "r1", content_hash: "h1"})});
    }
    if (url.endsWith("/files/upload")) {
      const arg = JSON.parse(init.headers["Dropbox-API-Arg"]);
      if (arg.mode[".tag"] === "update" && arg.mode.update === "stale") return response(409, {error_summary: "path/conflict/file/"});
      return response(200, {rev: "r9", path_display: arg.path});
    }
    throw new Error(`unexpected ${url}`);
  };
  const root2 = () => ROOT.toUpperCase(); // Dropbox may return a different case; the guard is case-insensitive.
  const storage = memoryStorage();
  const client = createClient({appKey: "KEY", redirectUri: "https://example.test/app/", rootPath: ROOT + "/", fetch, storage, crypto: webcrypto});

  // Login.
  assert.equal(client.isLoggedIn(), false);
  const url = new URL(await client.beginLogin());
  assert.equal(url.searchParams.get("client_id"), "KEY");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("token_access_type"), "offline");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.test/app/");
  await assert.rejects(client.completeLogin("?code=CODE&state=wrong"), /확인값/);
  assert.equal(await client.completeLogin(`?code=CODE&state=${url.searchParams.get("state")}`), true);
  assert.equal(client.isLoggedIn(), true);
  assert.equal(await client.completeLogin("?foo=1"), false);

  // Listing with paging, xlsx only, relative paths.
  const files = await client.listFiles();
  assert.deepEqual(files.map(f => f.relPath), ["Process_General/2026/260904/HAT-CN, 증착_general_v9.xlsx", "Calibration/HAT-CN/260915.xlsx"]);

  // Expired access token refreshes once and retries.
  expireNext = true;
  const dl = await client.download("Process_General/2026/260904/HAT-CN, 증착_general_v9.xlsx");
  assert.equal(new TextDecoder().decode(dl.data), "xlsx-bytes");
  assert.equal(dl.rev, "r1");
  assert.equal(accessTokens, 2, "refreshed once");

  // Root guard.
  assert.throws(() => client.pathFor("../Other/secret.xlsx"), /허용되지 않은 경로/);
  assert.throws(() => client.relPathOf("/NEXT LAB/Log/A222/VTE log/Other.xlsx"), /밖 경로/);
  assert.throws(() => client.relPathOf("/NEXT LAB/Log/A222/VTE log/VTE_MANAGER2/x.xlsx"), /밖 경로/);
  const before = calls.length;
  await assert.rejects(client.download("../../../Private/x.xlsx"), /허용되지 않은 경로/);
  assert.equal(calls.length, before, "no request for a blocked path");

  // Upload: add for new files, update with rev, conflict surfaces as an error.
  assert.equal((await client.upload("Presets/test.xlsx", new Uint8Array([1]))).rev, "r9");
  const addArg = JSON.parse(calls.at(-1).init.headers["Dropbox-API-Arg"]);
  assert.equal(addArg.mode, "add");
  assert.equal(addArg.autorename, false);
  await assert.rejects(client.upload("Presets/test.xlsx", new Uint8Array([1]), {rev: "stale"}), err => err.status === 409 && /conflict/.test(err.summary));

  // Delete only a known revision; no request without one.
  const beforeRemove = calls.length;
  await assert.rejects(client.remove("Presets/test.xlsx", {rev: null}), err => err.summary === "no_rev");
  assert.equal(calls.length, beforeRemove, "no delete request without a rev");

  client.logout();
  assert.equal(client.isLoggedIn(), false);
  console.log("dropbox client: PASS; PKCE login + state check, refresh on 401, paging, Korean header escaping, root guard (no request), add/update/conflict uploads, delete requires a rev");
})().catch(e => { console.error(e); process.exit(1); });
