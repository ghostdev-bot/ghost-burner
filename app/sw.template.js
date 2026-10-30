/* Ghost Burner service worker: caches ONLY this site's own static files.
   Never touches RPC/API traffic: every cross-origin request (Solana RPC, Jupiter,
   token images) and every non-GET request bypasses the worker entirely. */
var VERSION = 'gb-shell-__VERSION__';
var SHELL = __SHELL__;
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('gb-shell-') === 0 && k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                       // RPC POSTs etc.: never intercepted
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // cross-origin: never intercepted or cached
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    // Network-first so a new deploy shows up immediately; cached page only when offline.
    // Each page is cached under its own path (/refer.html or /how.html must never overwrite /index.html).
    var page = (url.pathname === '/' || url.pathname === '/index.html') ? '/index.html' : (/^\/(refer|how)(\.html)?$/.test(url.pathname) ? '/' + url.pathname.replace(/^\/|\.html$/g, '') + '.html' : null);
    e.respondWith(fetch(req, { cache: 'no-store' }).then(function (res) {
      if (res.ok && page) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(page, copy); }); }
      return res;
    }).catch(function () { return caches.match(page || '/index.html').then(function (r) { return r || caches.match('/'); }); }));
    return;
  }
  if (SHELL.indexOf(url.pathname) === -1) return;         // only known static files are served from cache
  e.respondWith(caches.open(VERSION).then(function (c) {
    return c.match(url.pathname).then(function (hit) {
      return hit || fetch(req).then(function (res) { if (res.ok) c.put(url.pathname, res.clone()); return res; });
    });
  }));
});
