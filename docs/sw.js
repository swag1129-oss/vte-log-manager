// App shell cache. Shell files are fetched with cache: "reload" so GitHub Pages' 10-minute HTTP cache cannot put old files under a new version.
// Dropbox API calls are never cached; log data lives in IndexedDB.
const CACHE = "vte-shell-2026-09-21-2754e782";
const SHELL = ["./","index.html","styles.css","app.js","data.js","dropbox.js","store.js","stack.js","editor.js","manifest.webmanifest","icons/icon-192.png","icons/icon-512.png","icons/icon-512-maskable.png","icons/apple-touch-icon.png","vte-core.js","xlsx.full.min.js"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(u => new Request(u, {cache: "reload"})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("vte-shell-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // The OAuth redirect lands on index.html with ?code=…; serve the cached shell for any page navigation.
  const key = event.request.mode === "navigate" ? "./" : event.request;
  event.respondWith(caches.match(key, {ignoreSearch: true}).then(hit => hit || fetch(event.request)));
});
