/* Valutio service worker: makes the app installable and fully offline.
   App shell is cached; market-data API calls always go to the network. */
var CACHE = "valutio-v481";
var ASSETS = [
  "./", "./index.html", "./app.css?v=481", "./app.i18n.js?v=481", "./statement-categorizer.js?v=481", "./app.js?v=481",
  "./manifest.webmanifest",
  "./Icons/icon-192.png", "./Icons/icon-512.png", "./Icons/icon-maskable-512.png",
  "./Templates/Wallet_Template.xlsx", "./Templates/expenses_template_valutio.xlsx",
  "./Vendor/xlsx.full.min.js", "./Vendor/SHEETJS-LICENSE.txt",
  "./Vendor/pdfjs/pdf.min.mjs", "./Vendor/pdfjs/pdf.worker.min.mjs", "./Vendor/pdfjs/LICENSE.txt",
  "./Rules/statement-categorizer-defaults.json",
  "./Icons/VAL-02.png", "./Icons/VAL-03.png", "./Icons/VAL-04.png",
  "./Fonts/material-symbols-rounded.woff2",
  "./Fonts/hanken-grotesk-latin.woff2",
  "./Fonts/hanken-grotesk-latin-ext.woff2",
];

self.addEventListener("install", function (e) {
  // Precache the new shell, but DON'T skipWaiting here: the new worker waits until the
  // user accepts the in-app "update available" prompt (or until the app is fully reopened).
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }));
});

// The page posts "SKIP_WAITING" when the user taps Refresh on the update prompt.
self.addEventListener("message", function (e) {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  // Let cross-origin requests (FX / crypto / stock APIs) go straight to the network.
  if (url.origin !== location.origin) return;
  // /yq/* is same-origin but is MARKET DATA (the site's Netlify rewrite proxies it to Yahoo
  // Finance): always live, never cached - a cached quote would freeze prices between refreshes.
  if (url.pathname.indexOf("/yq/") === 0) return;

  // Navigations: network-first, fall back to cached app shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(function (res) {
        // Only ever cache a SUCCESSFUL shell. Caching a 404/5xx body (e.g. a stale or wrongly-rooted
        // server answering "Not found: index.html") would poison the offline shell and brick the app
        // on the next failed-network load. A bad response is still returned to this navigation as-is.
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put("./index.html", copy); });
        }
        return res;
      }).catch(function () {
        return caches.match("./index.html").then(function (r) { return r || caches.match(req); });
      })
    );
    return;
  }

  // Same-origin assets: stale-while-revalidate.
  e.respondWith(
    caches.match(req).then(function (cached) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || net;
    })
  );
});
