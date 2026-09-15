/* ============================================================
   KYM PWA — Service Worker
   Strategi:
   - Precache app shell (offline penuh setelah kunjungan pertama)
   - Navigasi: network-first, fallback ke cache (offline tetap jalan)
   - Aset (ikon, logo): cache-first
   - Permintaan ke Google Apps Script: TIDAK pernah di-cache
   ============================================================ */
var CACHE = 'kym-v46';
var SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './logo-sekolah.jpg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // Jangan sentuh sinkronisasi Google Apps Script / Google apa pun
  if (url.hostname.indexOf('google') !== -1 || url.hostname.indexOf('gstatic') !== -1) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(function (r) {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return r;
      }).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  if (e.request.destination === 'image' || /\.(png|jpg|jpeg|webp|svg|ico)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        return hit || fetch(e.request).then(function (r) {
          var copy = r.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
          return r;
        });
      })
    );
    return;
  }

  // JS/CSS/manifest: network-first (update langsung terpakai), fallback cache saat offline
  e.respondWith(
    fetch(e.request).then(function (r) {
      var copy = r.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return r;
    }).catch(function () {
      return caches.match(e.request);
    })
  );
});
