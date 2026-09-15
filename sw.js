/* ============================================================
   KYM PWA — Service Worker
   Strategi:
   - Precache app shell (offline penuh setelah kunjungan pertama)
   - Navigasi: network-first, fallback ke cache (offline tetap jalan)
   - Aset (ikon, logo): cache-first
   - Permintaan ke Google Apps Script: TIDAK pernah di-cache
   ============================================================ */
var CACHE = 'kym-v48';
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

/* ============================================================
   KYM PWA — Push & Notification Event Handlers
   ============================================================ */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var chatKey = data.chatKey || '';
  var targetHash = '#chat' + (chatKey ? '?k=' + encodeURIComponent(chatKey) : '');

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      // Jika ada window/tab KYM yang sudah terbuka, fokuskan dan arahkan ke chat
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          client.postMessage({
            type: 'KYM_NOTIFICATION_CLICK',
            chatKey: chatKey,
            data: data
          });
          return client.focus();
        }
      }
      // Jika belum ada window terbuka, buka window baru
      if (self.clients.openWindow) {
        return self.clients.openWindow('./' + targetHash);
      }
    })
  );
});

self.addEventListener('push', function (event) {
  var data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (err) {
      data = { text: event.data.text() };
    }
  }
  var title = data.title || 'Pesan Baru — KYM';
  var options = {
    body: data.body || data.text || 'Ada pesan baru untuk Anda.',
    icon: data.icon || './icons/icon-192.png',
    badge: data.badge || './icons/icon-192.png',
    tag: data.tag || ('kym-chat-' + (data.chatKey || Date.now())),
    renotify: true,
    vibrate: [150, 80, 150],
    data: data
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
