/*
 * Minimal Dropbox client for the PWA: OAuth PKCE login with offline refresh, recursive listing, downloads, uploads.
 * Every path must stay inside the configured VTE_MANAGER root; anything else throws before a request is made.
 * Loads in the browser (window.VTEDropbox) or Node (tests inject fetch/storage/crypto).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VTEDropbox = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
  const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
  const API = "https://api.dropboxapi.com/2";
  const CONTENT = "https://content.dropboxapi.com/2";
  const KEYS = {token: "vte.dropbox.token", pkce: "vte.dropbox.pkce"};

  class DropboxError extends Error {
    constructor(message, {status = 0, summary = ""} = {}) {
      super(message);
      this.status = status;
      this.summary = summary;
    }
  }

  function base64url(bytes) {
    let bin = "";
    for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  // Dropbox-API-Arg is an HTTP header: non-ASCII (Korean file names) must be \u-escaped.
  function headerJson(value) {
    return JSON.stringify(value).replace(/[-￿]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  function normalizeRoot(path) {
    const trimmed = String(path || "").trim().replace(/\/+$/, "");
    if (!trimmed.startsWith("/")) throw new DropboxError("Dropbox 경로는 /로 시작해야 합니다.");
    return trimmed;
  }

  function createClient({appKey, redirectUri, rootPath, fetch: fetchImpl = globalThis.fetch.bind(globalThis), storage = globalThis.localStorage, crypto: cryptoImpl = globalThis.crypto, now = () => Date.now()}) {
    const rootDisplay = normalizeRoot(rootPath);
    const rootLower = rootDisplay.toLowerCase();

    function guard(path) {
      const p = String(path || "");
      if (p.split("/").some(seg => seg === ".." || seg === ".")) throw new DropboxError(`허용되지 않은 경로: ${p}`);
      const lower = p.toLowerCase();
      if (lower !== rootLower && !lower.startsWith(rootLower + "/")) throw new DropboxError(`VTE_MANAGER 폴더 밖 경로는 사용할 수 없습니다: ${p}`);
      return p;
    }
    function relPathOf(pathDisplay) {
      return guard(pathDisplay).slice(rootDisplay.length + 1);
    }
    function pathFor(relPath) {
      return guard(`${rootDisplay}/${relPath}`);
    }

    const readToken = () => { try { return JSON.parse(storage.getItem(KEYS.token) || "null"); } catch { return null; } };
    const writeToken = t => storage.setItem(KEYS.token, JSON.stringify(t));

    async function beginLogin() {
      const verifier = base64url(cryptoImpl.getRandomValues(new Uint8Array(48)));
      const state = base64url(cryptoImpl.getRandomValues(new Uint8Array(16)));
      const challenge = base64url(await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      storage.setItem(KEYS.pkce, JSON.stringify({verifier, state}));
      const params = new URLSearchParams({
        client_id: appKey, response_type: "code", redirect_uri: redirectUri,
        code_challenge: challenge, code_challenge_method: "S256", token_access_type: "offline", state
      });
      return `${AUTH_URL}?${params}`;
    }
    async function tokenRequest(form) {
      const res = await fetchImpl(TOKEN_URL, {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: new URLSearchParams(form).toString()});
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new DropboxError(body.error_description || body.error || `토큰 요청 실패 (${res.status})`, {status: res.status, summary: body.error || ""});
      return body;
    }
    // Returns true when the URL carried a login result and it was handled.
    async function completeLogin(search) {
      const params = new URLSearchParams(search);
      if (params.get("error")) throw new DropboxError(`Dropbox 로그인 취소 또는 실패: ${params.get("error_description") || params.get("error")}`);
      const code = params.get("code");
      if (!code) return false;
      const pkce = JSON.parse(storage.getItem(KEYS.pkce) || "null");
      if (!pkce || pkce.state !== params.get("state")) throw new DropboxError("로그인 확인값이 맞지 않습니다. 다시 로그인해 주세요.");
      const t = await tokenRequest({code, grant_type: "authorization_code", code_verifier: pkce.verifier, client_id: appKey, redirect_uri: redirectUri});
      storage.removeItem(KEYS.pkce);
      writeToken({access: t.access_token, refresh: t.refresh_token, expiresAt: now() + (t.expires_in || 14400) * 1000, accountId: t.account_id || ""});
      return true;
    }
    function isLoggedIn() { return Boolean(readToken()?.refresh); }
    function logout() { storage.removeItem(KEYS.token); }

    async function accessToken(forceRefresh = false) {
      const t = readToken();
      if (!t?.refresh) throw new DropboxError("Dropbox 로그인이 필요합니다.", {status: 401, summary: "not_logged_in"});
      if (!forceRefresh && t.access && t.expiresAt - 60000 > now()) return t.access;
      const r = await tokenRequest({grant_type: "refresh_token", refresh_token: t.refresh, client_id: appKey});
      writeToken({...t, access: r.access_token, expiresAt: now() + (r.expires_in || 14400) * 1000});
      return r.access_token;
    }
    async function call(url, init, retry = true) {
      const token = await accessToken();
      const res = await fetchImpl(url, {...init, headers: {...init.headers, Authorization: `Bearer ${token}`}});
      if (res.status === 401 && retry) {
        await accessToken(true);
        return call(url, init, false);
      }
      if (res.status === 429 && retry) {
        const wait = Number(res.headers?.get?.("Retry-After") || 2);
        await new Promise(r => setTimeout(r, Math.min(wait, 30) * 1000));
        return call(url, init, false);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let summary = text;
        try { summary = JSON.parse(text).error_summary || text; } catch {}
        const message = /not_found/.test(summary) ? `Dropbox에서 경로를 찾을 수 없습니다: ${summary}` : `Dropbox 요청 실패 (${res.status}): ${summary}`;
        throw new DropboxError(message, {status: res.status, summary});
      }
      return res;
    }
    async function rpc(endpoint, args) {
      const res = await call(`${API}${endpoint}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(args)});
      return res.json();
    }

    // All .xlsx files under the root: [{relPath, name, pathLower, rev, contentHash, size, modified}].
    async function listFiles() {
      const out = [];
      let page = await rpc("/files/list_folder", {path: guard(rootDisplay), recursive: true, include_deleted: false, limit: 2000});
      for (;;) {
        for (const e of page.entries) {
          if (e[".tag"] !== "file" || !/\.xlsx$/i.test(e.name)) continue;
          out.push({relPath: relPathOf(e.path_display), name: e.name, pathLower: e.path_lower, rev: e.rev, contentHash: e.content_hash, size: e.size, modified: e.server_modified});
        }
        if (!page.has_more) break;
        page = await rpc("/files/list_folder/continue", {cursor: page.cursor});
      }
      return out;
    }
    async function download(relPath) {
      const res = await call(`${CONTENT}/files/download`, {method: "POST", headers: {"Dropbox-API-Arg": headerJson({path: pathFor(relPath)})}});
      const meta = JSON.parse(res.headers.get("Dropbox-API-Result") || "{}");
      return {data: await res.arrayBuffer(), rev: meta.rev, contentHash: meta.content_hash};
    }
    // mode "add" never overwrites; `rev` updates only if the file is still at that revision.
    async function upload(relPath, data, {rev = null} = {}) {
      const mode = rev ? {".tag": "update", update: rev} : "add";
      const res = await call(`${CONTENT}/files/upload`, {
        method: "POST",
        headers: {"Content-Type": "application/octet-stream", "Dropbox-API-Arg": headerJson({path: pathFor(relPath), mode, autorename: false, mute: false, strict_conflict: true})},
        body: data
      });
      return res.json();
    }

    async function remove(relPath, {rev = null} = {}) {
      return rpc("/files/delete_v2", rev ? {path: pathFor(relPath), parent_rev: rev} : {path: pathFor(relPath)});
    }

    return {rootPath: rootDisplay, remove, beginLogin, completeLogin, isLoggedIn, logout, listFiles, download, upload, pathFor, relPathOf};
  }

  return {createClient, DropboxError, headerJson};
});
