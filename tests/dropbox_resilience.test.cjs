// Network failures retry with backoff (max 3), concurrency capped, hung requests time out.
const assert = require("assert/strict");
const {createClient} = require("../src/mobile/dropbox.js");
const store = new Map([["vte.dropbox.token", JSON.stringify({access: "a", refresh: "r", expiresAt: Date.now() + 1e7})]]);
const storage = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k)};
const ok = body => ({ok: true, status: 200, headers: {get: () => null}, json: async () => body, text: async () => JSON.stringify(body)});
const mk = fetch => createClient({appKey: "k", redirectUri: "x", rootPath: "/R", fetch, storage, backoff: () => 5, timeoutMs: 100});
(async () => {
  let n = 0, retries = 0;
  const c1 = createClient({appKey: "k", redirectUri: "x", rootPath: "/R", storage, backoff: () => 5, onRetry: () => retries++,
    fetch: async () => { if (++n < 3) throw new TypeError("Load failed"); return ok({entries: [], has_more: false}); }});
  assert.deepEqual(await c1.listFiles(), []); assert.equal(n, 3); assert.equal(retries, 2);
  n = 0;
  const c2 = mk(async () => { n++; throw new TypeError("Failed to fetch"); });
  await assert.rejects(c2.listFiles(), e => e.network && e.attempts === 3 && /list_folder/.test(e.endpoint) && e.name === "TypeError");
  assert.equal(n, 3);
  let act = 0, max = 0;
  const c3 = mk(async () => { act++; max = Math.max(max, act); await new Promise(r => setTimeout(r, 10)); act--; return ok({entries: [], has_more: false}); });
  await Promise.all(Array.from({length: 12}, () => c3.listFiles()));
  assert.equal(max, 4);
  const c4 = mk((u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), {name: "AbortError"})))));
  await assert.rejects(c4.listFiles(), e => e.network && /시간 초과/.test(e.message));
  console.log("dropbox resilience ok");
})().catch(e => { console.error(e); process.exit(1); });
