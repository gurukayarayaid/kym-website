/* ============================================================
   KYM — Rukun dengan Teman
   Penyimpanan data: localStorage (browser, tanpa server)
   ============================================================ */
(function () {
  'use strict';

  /* ---------- Konstanta & util ---------- */
  var LS_POEMS = 'kym_poems_v1';
  var LS_LOG = 'kym_log_v1';
  var LS_PASS = 'kym_admin_pass_v1';
  var LS_UNLOCK = 'kym_admin_unlock_v1';
  var LS_GAS = 'kym_gas_url_v1';
  var LS_OUTBOX = 'kym_gas_outbox_v1';
  var LS_DEVICE = 'kym_device_id_v1';
  var LS_SESSION = 'kym_user_session_v1';
  var LS_GURU = 'kym_guru_accounts_v1';
  var LS_CHAT = 'kym_chat_v1';
  var LS_CHAT_OUTBOX = 'kym_chat_outbox_v1';
  var LS_CHAT_NOTIFIED = 'kym_chat_notified_v1';
  var IDB_NAME = 'kym-filedb';
  var IDB_STORE = 'handles';
  var IDB_STORE_FILES = 'chatfiles';
  var CHAT_FILE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB (lokal, IndexedDB)
  var CHAT_FILE_ONLINE_MAX = 1 * 1024 * 1024; // 1 MB — file di atas ini hanya tersimpan lokal
  var CHAT_FILE_CHUNK = 40000; // karakter per chunk (limit 1 sel Sheets = 50.000)
  var CHAT_FILE_MAX_CHUNKS = 60; // pengaman download
  var LS_CHAT_FILE_PENDING = 'kym_chat_file_pending_v1'; // antrean upload [fileId]

  /* ---------- File Database (JSON) ---------- */
  var dbFileHandle = null;   // FileSystemFileHandle saat terhubung
  var dbSaving = false;
  var dbPending = false;

  function fsaSupported() { return typeof window.showSaveFilePicker === 'function'; }

  function idbOpen() {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(IDB_NAME, 2);
      rq.onupgradeneeded = function (ev) {
        var db = rq.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        if (!db.objectStoreNames.contains(IDB_STORE_FILES)) db.createObjectStore(IDB_STORE_FILES);
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function idbSet(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var rq = tx.objectStore(IDB_STORE).get(key);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function idbDel(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  function buildDbObject() {
    return {
      app: 'KYM', format: 2,
      savedAt: new Date().toISOString(),
      poems: loadPoems(),
      log: loadLog(),
      adminPass: getPass(),
      chats: loadChat(),
      guru: loadGuru()
    };
  }
  function serializeDb(obj) { return JSON.stringify(obj, null, 2); }

  function writeFileToHandle(handle, obj) {
    var p = null;
    try { p = handle.createWritable(); } catch (e) { p = null; }
    if (!p || typeof p.then !== 'function') p = Promise.resolve(p);
    return p.then(function (w) {
      w.write(serializeDb(obj));
      return w.close();
    });
  }

  // Simpan ke file terhubung (toleran: antre jika sedang menulis)
  function saveDbToFile() {
    if (!dbFileHandle) return Promise.resolve(false);
    if (dbSaving) { dbPending = true; return Promise.resolve(false); }
    dbSaving = true;
    return writeFileToHandle(dbFileHandle, buildDbObject())
      .then(function () {
        setDbStatus('✅ Tersimpan otomatis ke "' + dbFileHandle.name + '" · ' + loadPoems().length + ' karya · ' + new Date().toLocaleTimeString('id-ID'), true);
        return true;
      })
      .catch(function (e) {
        setDbStatus('❌ Gagal menulis file: ' + e.message + ' — data tetap aman di browser.', false);
        return false;
      })
      .then(function (ok) {
        dbSaving = false;
        if (dbPending) { dbPending = false; saveDbToFile(); }
        return ok;
      });
  }

  function setDbStatus(msg, ok) {
    var el = $('db-status');
    if (el) {
      el.textContent = msg;
      el.style.color = ok === true ? '#059669' : (ok === false ? '#dc2626' : '');
    }
  }

  function readDbFromFile(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () {
        try {
          var data = JSON.parse(r.result);
          if (!data || typeof data !== 'object') throw new Error('bukan objek');
          res(data);
        } catch (e) { rej(new Error('File JSON tidak valid.')); }
      };
      r.onerror = function () { rej(new Error('Gagal membaca file.')); };
      r.readAsText(file);
    });
  }

  // Terapkan isi database ke localStorage. merge=true: gabung by kode+log; false: timpa total.
  function applyDbObject(data, merge) {
    var remotePoems = Array.isArray(data.poems) ? data.poems : [];
    var remoteLog = Array.isArray(data.log) ? data.log : [];
    var remoteChats = Array.isArray(data.chats) ? data.chats : [];
    var remoteGuru = Array.isArray(data.guru) ? data.guru : [];
    var poems, log;
    if (merge) {
      poems = loadPoems();
      var map = {};
      poems.forEach(function (p) { map[p.code] = p; });
      var added = 0, updated = 0;
      remotePoems.forEach(function (rp) {
        var lp = map[rp.code];
        if (!lp) { poems.push(rp); added++; }
        else {
          var lt = new Date(lp.updatedAt || lp.time).getTime() || 0;
          var rt = new Date(rp.updatedAt || rp.time).getTime() || 0;
          if (rt > lt) { poems[poems.indexOf(lp)] = rp; updated++; }
        }
      });
      log = loadLog();
      var seen = {};
      log.forEach(function (l) { seen[l.time + '|' + l.action + '|' + (l.code || '')] = 1; });
      remoteLog.forEach(function (l) {
        var k = l.time + '|' + l.action + '|' + (l.code || '');
        if (!seen[k]) { log.push(l); seen[k] = 1; }
      });
      log.sort(function (a, b) { return new Date(b.time) - new Date(a.time); });
      if (typeof data.adminPass === 'string' && data.adminPass && data.adminPass !== DEFAULT_PASS && getPass() === DEFAULT_PASS) {
        localStorage.setItem(LS_PASS, data.adminPass);
      }
      // merge chats
      if (remoteChats.length) mergeChatFromRemote(remoteChats);
      if (remoteGuru.length) {
        var curG = loadGuru();
        var gMap = {};
        curG.forEach(function (g) { gMap[g.nama.toLowerCase()] = g; });
        remoteGuru.forEach(function (rg) {
          if (!gMap[rg.nama.toLowerCase()]) curG.push(rg);
        });
        saveGuru(curG);
      }
      return { added: added, updated: updated, logAdded: log.length - loadLog().length, total: poems.length, poems: poems, log: log };
    }
    poems = remotePoems;
    log = remoteLog;
    if (typeof data.adminPass === 'string' && data.adminPass) {
      localStorage.setItem(LS_PASS, data.adminPass);
    }
    if (Array.isArray(data.chats)) saveChat(data.chats);
    if (Array.isArray(data.guru)) saveGuru(data.guru);
    return { added: poems.length, updated: 0, logAdded: log.length, total: poems.length, poems: poems, log: log };
  }

  function commitDb(data, merge, sourceLabel) {
    var r = applyDbObject(data, merge);
    savePoems(r.poems);
    localStorage.setItem(LS_LOG, JSON.stringify(r.log));
    renderAdmin();
    updateChatBadge();
    setDbStatus('♻️ Pulihkan (' + sourceLabel + '): ' + r.total + ' karya' + (merge ? ' · ' + r.added + ' baru · ' + r.updated + ' diperbarui' : '') + '.', true);
    toast('Database dipulihkan: ' + r.total + ' karya.');
    saveDbToFile();
    return r;
  }
  var DEFAULT_PASS = 'alal1010';

  /* ---------- Navigasi via hash (untuk shortcut PWA & deep-link) ---------- */
  function pageFromHash() {
    var raw = (location.hash || '').replace('#', '');
    var h = raw.split('?')[0];
    return ['materi', 'kirim', 'galeri', 'karyaku', 'admin', 'pasang', 'chat'].indexOf(h) !== -1 ? h : 'kirim';
  }
  var _showPage = showPage;
  showPage = function (name) {
    var cleanName = name.split('?')[0];
    var currentBase = (location.hash || '').replace('#', '').split('?')[0];
    if (currentBase !== cleanName) { location.hash = name; return; }
    _showPage(cleanName);
  };
  function checkChatDeepLink() {
    var raw = (location.hash || '').replace('#', '');
    if (raw.indexOf('chat?k=') !== -1) {
      var match = raw.match(/k=([^&]+)/);
      if (match && match[1]) {
        var key = decodeURIComponent(match[1]);
        setTimeout(function () {
          if (typeof openChatByKey === 'function') openChatByKey(key);
        }, 120);
      }
    }
  }
  window.addEventListener('hashchange', function () {
    _showPage(pageFromHash());
    checkChatDeepLink();
  });

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDT(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '-';
    return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function lineCount(t) {
    var x = String(t || '').replace(/\s+$/, '').split('\n');
    return (x.length === 1 && x[0] === '') ? 0 : x.length;
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  /* ---------- PWA: service worker & tombol Pasang ---------- */
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  var deferredPrompt = null;
  function showNavPasang() {
    var navPasang = $('nav-pasang');
    var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    if (navPasang) navPasang.style.display = (standalone || !deferredPrompt) ? 'none' : '';
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showNavPasang();
    if (!localStorage.getItem('kym_install_dismissed')) {
      $('install-bar').classList.add('show');
    }
  });
  var _installBtnReady = setInterval(function () {
    if (!$('btn-install')) return;
    clearInterval(_installBtnReady);
    $('btn-install').addEventListener('click', function () {
      if (!deferredPrompt) { toast('Buka menu browser → "Tambahkan ke layar utama".'); return; }
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () { deferredPrompt = null; $('install-bar').classList.remove('show'); showNavPasang(); });
    });
    $('btn-install-dismiss').addEventListener('click', function () {
      $('install-bar').classList.remove('show');
      localStorage.setItem('kym_install_dismissed', '1');
    });
    $('btn-pasang-sekarang').addEventListener('click', function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function () { deferredPrompt = null; showNavPasang(); renderPasang(); });
      } else {
        toast('Buka menu browser ⋮ → "Tambahkan ke layar utama".');
      }
    });
  }, 50);

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    $('install-bar').classList.remove('show');
    var navPasang = $('nav-pasang');
    if (navPasang) navPasang.style.display = 'none';
  });

  /* ---------- Halaman #pasang ---------- */
  function renderPasang() {
    var st = $('pasang-status');
    if (!st) return;
    var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    var b = $('btn-pasang-sekarang');
    if (standalone) {
      st.innerHTML = '<div class="callout" style="background:#d1fae5; border-color:#6ee7b7;"><b style="color:#065f46;">✅ Aplikasi sudah terpasang di HP ini.</b> Buka lewat ikon KYM di layar utama.</div>';
      if (b) b.style.display = 'none';
      showNavPasang();
      return;
    }
    if (b) b.style.display = '';
    st.innerHTML = deferredPrompt
      ? '<div class="chip">📲 Siap dipasang — ketuk tombol di bawah ini</div>'
      : '<div class="chip">💡 Jika tombol tidak merespons, ikuti langkah manual di bawah</div>';
  }
  window.addEventListener('appinstalled', function () {
    $('install-bar').classList.remove('show');
    toast('🎉 Aplikasi KYM berhasil dipasang!');
  });
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(function () {});
    } else {
      var ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
    }
  }
  function saveFile(content, filename, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 150);
  }
  function online() { return navigator.onLine !== false; }
  function getDeviceId() {
    var d = localStorage.getItem(LS_DEVICE);
    if (!d) {
      d = 'DEV-' + Math.random().toString(36).slice(2, 6).toUpperCase();
      localStorage.setItem(LS_DEVICE, d);
    }
    return d;
  }

  /* ---------- Google Sheets (Apps Script Web App) ---------- */
  // URL Apps Script bawaan — agar SEMUA perangkat murid otomatis tersinkron
  // tanpa perlu setup. Isi dengan Web App URL Anda (berakhiran /exec), contoh:
  // var DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycb.../exec';
  var DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbzlF5bot3P2PLZlbHzEsCw0eLXBbk8nrzHOXFqeRPgWpEMOY6WYWQDG2I3ugW_8WdfF/exec';

  function getGasUrl() { return localStorage.getItem(LS_GAS) || DEFAULT_GAS_URL; }
  function setGasUrl(u) { localStorage.setItem(LS_GAS, u); }
  function gasActive() { return getGasUrl().indexOf('http') === 0; }

  function gasApi(payload) {
    var opts = { method: 'POST', body: JSON.stringify(payload) };
    var timeout = new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error('timeout')); }, 25000);
    });
    var req = fetch(getGasUrl(), opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
    return Promise.race([req, timeout]).then(function (res) {
      if (!res || res.ok !== true) throw new Error((res && res.error) || 'Respon tidak valid dari server');
      return res;
    });
  }

  function loadOutbox() {
    try { return JSON.parse(localStorage.getItem(LS_OUTBOX)) || []; } catch (e) { return []; }
  }
  function saveOutbox(a) {
    localStorage.setItem(LS_OUTBOX, JSON.stringify(a));
    var el = $('gas-outbox-n');
    if (el) {
      el.textContent = a.length;
      var btn = $('btn-gas-retry');
      if (btn) btn.style.display = a.length ? 'inline-block' : 'none';
    }
  }
  function enqueue(action, poem) {
    var q = loadOutbox();
    q.push({ action: action, poem: poem, ts: new Date().toISOString() });
    saveOutbox(q);
  }

  function gasSend(action, poem) {
    if (!gasActive()) return Promise.reject(new Error('Belum terhubung ke Google Sheets.'));
    if (!online()) { enqueue(action, poem); return Promise.reject(new Error('offline')); }
    return gasApi({ action: action, poem: poem });
  }

  // Kirim ulang antrean saat offline tadi; berhenti pada kegagalan pertama.
  function flushOutbox() {
    var q = loadOutbox();
    if (!q.length || !gasActive() || !online()) return Promise.resolve(0);
    var next = q[0];
    return gasApi({ action: next.action, poem: next.poem }).then(function () {
      q.shift();
      saveOutbox(q);
      return flushOutbox().then(function (n) { return n + 1; });
    }).catch(function () { return 0; });
  }
  window.addEventListener('online', function () {
    flushOutbox().then(function (n) { if (n) toast(n + ' kiriman tertunda berhasil disinkronkan.'); });
  });

  function setGasStatus(msg, ok) {
    var el = $('gas-status');
    if (el) {
      el.textContent = msg;
      el.style.color = ok === true ? '#059669' : (ok === false ? '#dc2626' : '');
    }
  }

  // Sinkron satu aksi ke Sheets; gagal jaringan masuk antrean otomatis.
  function syncPoem(action, poem, quiet) {
    return gasSend(action, poem).then(function () {
      setGasStatus('☁️ Tersinkron ke Sheets: \u201C' + poem.judul + '\u201D', true);
    }).catch(function (e) {
      if (e.message === 'Belum terhubung ke Google Sheets.') return;
      if (e.message !== 'offline') enqueue(action, poem);
      if (!quiet) setGasStatus('📮 Disimpan lokal — akan dikirim saat online. (' + poem.code + ')', false);
    });
  }

  function gasPull() {
    if (!gasActive()) { toast('Simpan URL Google Sheets terlebih dahulu.'); return Promise.resolve(0); }
    setGasStatus('⏳ Menarik data dari Sheets…');
    return gasApi({ action: 'list' }).then(function (res) {
      var remote = res.poems || [];
      var local = loadPoems();
      var map = {};
      local.forEach(function (p) { map[p.code] = p; });
      var added = 0, updated = 0;
      remote.forEach(function (rp) {
        var lp = map[rp.code];
        if (!lp) { local.push(rp); added++; }
        else {
          var lt = new Date(lp.updatedAt || lp.time).getTime();
          var rt = new Date(rp.updatedAt || rp.time).getTime();
          if (rt > lt) { local[local.indexOf(lp)] = rp; updated++; }
        }
      });
      savePoems(local);
      // buang dari antrean yang sudah ada di remote
      var codes = {};
      remote.forEach(function (p) { codes[p.code] = 1; });
      saveOutbox(loadOutbox().filter(function (o) { return !codes[o.poem.code]; }));
      saveDbToFile();
      renderAdmin();
      setGasStatus('✅ Sinkron: ' + remote.length + ' karya di Sheets' + (added ? ' · ' + added + ' baru' : '') + (updated ? ' · ' + updated + ' diperbarui' : ''), true);
      return remote.length;
    }).catch(function (e) {
      setGasStatus('❌ Gagal menarik: ' + e.message, false);
      return 0;
    });
  }

  function gasPushAll() {
    if (!gasActive()) { toast('Simpan URL Google Sheets terlebih dahulu.'); return Promise.resolve(0); }
    var list = loadPoems();
    if (!list.length) { toast('Belum ada karya untuk didorong.'); return Promise.resolve(0); }
    setGasStatus('⏳ Mendorong ' + list.length + ' karya…');
    return gasApi({ action: 'bulk', poems: list }).then(function (res) {
      saveOutbox([]);
      setGasStatus('✅ Semua karya (' + res.count + ') tersimpan di Sheets.', true);
      return res.count;
    }).catch(function (e) {
      setGasStatus('❌ Gagal mendorong: ' + e.message, false);
      return 0;
    });
  }

  /* ---------- Chat GAS sync (cross-device real-time) ---------- */
  function loadChatOutbox() {
    try { return JSON.parse(localStorage.getItem(LS_CHAT_OUTBOX)) || []; } catch (e) { return []; }
  }
  function saveChatOutbox(a) { localStorage.setItem(LS_CHAT_OUTBOX, JSON.stringify(a)); }
  function enqueueChat(action, chat) {
    var q = loadChatOutbox();
    q.push({ action: action, chat: chat, ts: Date.now() });
    saveChatOutbox(q);
  }

  /* ---------- Chat File Attachment (IndexedDB) ---------- */
  // Simpan data URL file ke IndexedDB dengan kunci msgId
  function chatFileSave(msgId, dataUrl) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE_FILES, 'readwrite');
        tx.objectStore(IDB_STORE_FILES).put(dataUrl, msgId);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  // Ambil data URL file dari IndexedDB
  function chatFileLoad(msgId) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE_FILES, 'readonly');
        var rq = tx.objectStore(IDB_STORE_FILES).get(msgId);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  // Hapus data URL file dari IndexedDB
  function chatFileDel(msgId) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE_FILES, 'readwrite');
        tx.objectStore(IDB_STORE_FILES).delete(msgId);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () {});
  }

  // State file yang sedang dipilih (belum dikirim)
  var _pendingFile = null; // { file, dataUrl, name, type, size }

  // Format ukuran file menjadi KB/MB
  function fmtFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Ikon berdasarkan tipe file
  function fileIcon(type, name) {
    if ((type || '').indexOf('image/') === 0) return '🖼️';
    if (type === 'application/pdf' || (name || '').match(/\.pdf$/i)) return '📄';
    if ((name || '').match(/\.(docx?|odt)$/i)) return '📝';
    if ((name || '').match(/\.(xlsx?|ods)$/i)) return '📊';
    if ((name || '').match(/\.(pptx?|odp)$/i)) return '📋';
    return '📎';
  }

  // Teks preview pesan untuk list/notifikasi: aman untuk pesan file-only (teks kosong)
  function chatPreviewText(m, maxLen) {
    var t = (m && m.text) || '';
    if (t) return t.length > maxLen ? t.substr(0, maxLen) + '…' : t;
    if (m && m.file && m.file.name) return '📎 ' + m.file.name;
    return '';
  }

  // Bangun payload chat yang aman untuk GAS: hanya field yang diizinkan +
  // metadata file kecil (nama/tipe/ukuran). Biner file TIDAK PERNAH dikirim
  // (tetap di IndexedDB lokal) agar kolom Sheets tidak jebol.
  function sanitizeChatForGas(chat) {
    if (!chat) return {};
    var out = {
      id: chat.id,
      chatKey: chat.chatKey,
      senderId: chat.senderId,
      senderName: chat.senderName,
      senderRole: chat.senderRole,
      text: chat.text || '',
      ts: chat.ts,
      read: !!chat.read,
      edited: !!chat.edited,
      deleted: !!chat.deleted
    };
    var f = chat.file;
    // dukung format objek {name,type,size} maupun flat fileName/fileType/fileSize
    var fname = (f && f.name) || chat.fileName || '';
    if (fname) {
      out.file = {
        name: String(fname).slice(0, 120),
        type: String((f && f.type) || chat.fileType || ''),
        size: Number((f && f.size) || chat.fileSize || 0) || 0,
        msgId: chat.id
      };
    }
    return out;
  }

  // Tampilkan preview file di area preview sebelum kirim
  function showChatFilePreview(file, dataUrl) {
    var preview = $('chat-file-preview');
    var thumbWrap = $('chat-file-preview-thumb-wrap');
    var nameEl = $('chat-file-preview-name');
    var sizeEl = $('chat-file-preview-size');
    if (!preview || !thumbWrap || !nameEl || !sizeEl) return;
    thumbWrap.innerHTML = '';
    if ((file.type || '').indexOf('image/') === 0) {
      var img = document.createElement('img');
      img.src = dataUrl;
      img.className = 'chat-file-preview-thumb';
      img.alt = file.name;
      thumbWrap.appendChild(img);
    } else {
      var iconDiv = document.createElement('div');
      iconDiv.className = 'chat-file-preview-doc';
      iconDiv.textContent = fileIcon(file.type, file.name);
      thumbWrap.appendChild(iconDiv);
    }
    nameEl.textContent = file.name;
    sizeEl.textContent = fmtFileSize(file.size);
    preview.style.display = 'flex';
  }

  // Bersihkan file yang sedang dipilih
  function clearPendingFile() {
    _pendingFile = null;
    var preview = $('chat-file-preview');
    var fileInput = $('chat-file-input');
    if (preview) preview.style.display = 'none';
    if (fileInput) fileInput.value = '';
  }

  // Proses file yang dipilih user (gambar / PDF / dokumen)
  function handleChatFileSelect(file) {
    if (!file) return;
    if (file.size > CHAT_FILE_MAX_BYTES) {
      toast('❌ File terlalu besar (maks 5 MB). Pilih file yang lebih kecil.');
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
      var dataUrl = e.target.result;
      _pendingFile = { file: file, dataUrl: dataUrl, name: file.name, type: file.type || '', size: file.size, compressing: false };
      showChatFilePreview(file, dataUrl);
      var chatInput = $('chat-input');
      if (chatInput) chatInput.focus();
      // Gambar: kompres otomatis (canvas) agar bisa terkirim online realtime
      if ((file.type || '').indexOf('image/') === 0) {
        _pendingFile.compressing = true;
        compressChatImage(dataUrl, 1280, 0.72).then(function (small) {
          if (!_pendingFile || _pendingFile.name !== file.name) return;
          if (small && small.length < dataUrl.length) {
            _pendingFile.dataUrl = small;
            _pendingFile.size = Math.round(small.length * 3 / 4);
            var sizeEl = $('chat-file-preview-size');
            if (sizeEl) sizeEl.textContent = fmtFileSize(_pendingFile.size) + ' (dioptimasi)';
          }
        }).catch(function () {}).then(function () {
          if (_pendingFile && _pendingFile.name === file.name) _pendingFile.compressing = false;
        });
      }
    };
    reader.onerror = function () { toast('❌ Gagal membaca file.'); };
    reader.readAsDataURL(file);
  }

  /* ---------- Transfer file online (gambar/PDF/dokumen, chunk via Sheets) ---------- */
  // Kompres gambar via canvas: maks 1280px sisi panjang, JPEG kualitas 0.72
  function compressChatImage(dataUrl, maxDim, quality) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          if (!w || !h) { res(null); return; }
          var scale = Math.min(1, maxDim / Math.max(w, h));
          // sudah kecil: tidak perlu dikompres
          if (scale >= 1 && dataUrl.length < 400000) { res(null); return; }
          var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
          var cv = document.createElement('canvas');
          cv.width = cw; cv.height = ch;
          cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
          res(cv.toDataURL('image/jpeg', quality));
        } catch (e) { rej(e); }
      };
      img.onerror = function () { rej(new Error('img')); };
      img.src = dataUrl;
    });
  }

  function loadChatFilePending() {
    try { return JSON.parse(localStorage.getItem(LS_CHAT_FILE_PENDING)) || []; } catch (e) { return []; }
  }
  function saveChatFilePending(a) {
    try { localStorage.setItem(LS_CHAT_FILE_PENDING, JSON.stringify(a)); } catch (e) {}
  }
  function enqueueChatFileUpload(fileId) {
    if (!fileId) return;
    var q = loadChatFilePending();
    if (q.indexOf(fileId) === -1) { q.push(fileId); saveChatFilePending(q); }
    pumpChatFileUpload();
  }
  var _chatFileUploading = false;
  // Upload berurutan: 1 file dalam 1 waktu, chunk per chunk
  function pumpChatFileUpload() {
    if (_chatFileUploading) return;
    if (!gasActive() || !online()) return;
    var q = loadChatFilePending();
    if (!q.length) return;
    _chatFileUploading = true;
    var fileId = q[0];
    chatFileLoad(fileId).then(function (dataUrl) {
      if (!dataUrl) { shiftChatFilePending(fileId); _chatFileUploading = false; pumpChatFileUpload(); return; }
      uploadChatFileChunks(fileId, dataUrl).then(function (ok) {
        if (ok) {
          shiftChatFilePending(fileId);
          toast('📎 File terkirim — penerima bisa membuka.');
        }
        _chatFileUploading = false;
        pumpChatFileUpload();
      });
    }).catch(function () { _chatFileUploading = false; });
  }
  function shiftChatFilePending(fileId) {
    saveChatFilePending(loadChatFilePending().filter(function (id) { return id !== fileId; }));
  }
  function uploadChatFileChunks(fileId, dataUrl) {
    var total = Math.ceil(dataUrl.length / CHAT_FILE_CHUNK);
    if (total > CHAT_FILE_MAX_CHUNKS) return Promise.resolve(false);
    var i = 0;
    function next() {
      if (i >= total) return verifyChatFileUpload(fileId, total);
      var chunk = dataUrl.substr(i * CHAT_FILE_CHUNK, CHAT_FILE_CHUNK);
      var idx = i; i++;
      return gasApi({ action: 'file_put', fileId: fileId, idx: idx, total: total, chunk: chunk })
        .then(function () { return next(); })
        .catch(function () { return false; });
    }
    return next();
  }
  // Verifikasi ke server: pastikan semua chunk benar-benar tersimpan.
  // Server lama (belum Deploy ulang) menjawab ok tanpa menyimpan → jangan hapus antrean.
  function verifyChatFileUpload(fileId, total) {
    return gasApi({ action: 'file_ids' }).then(function (res) {
      if (!res || !Array.isArray(res.fileIds)) { noteFileServerOutdated(); return false; }
      var found = res.fileIds.filter(function (f) { return f.fileId === fileId; })[0];
      if (found && (found.count || 0) >= total) return true;
      return false;
    }).catch(function () { return false; });
  }
  var _fileServerWarnAt = 0;
  function noteFileServerOutdated() {
    var now = Date.now();
    if (now - _fileServerWarnAt < 10 * 60 * 1000) return;
    _fileServerWarnAt = now;
    toast('⚠️ Server Sheets belum mendukung file — Admin: Panduan & Kode → Deploy → New version.');
  }
  var _chatFileDownloading = {};
  // Unduh file yang belum ada di IDB lokal (dipanggil tiap pull chat)
  function syncChatFiles() {
    if (!gasActive() || !online()) return Promise.resolve(0);
    var missing = [];
    loadChat().forEach(function (m) {
      if (m.deleted || !m.file || !m.file.name) return;
      var fid = m.file.msgId || m.id;
      if (!fid || _chatFileDownloading[fid]) return;
      missing.push({ fid: fid, msg: m });
    });
    if (!missing.length) return Promise.resolve(0);
    // cek IDB dulu agar tidak memanggil server sia-sia
    return Promise.all(missing.map(function (it) {
      return chatFileLoad(it.fid).then(function (has) { return has ? null : it; }).catch(function () { return it; });
    })).then(function (need) {
      need = need.filter(Boolean);
      if (!need.length) return 0;
      return gasApi({ action: 'file_ids' }).then(function (res) {
        if (!res || !Array.isArray(res.fileIds)) { noteFileServerOutdated(); return 0; }
        var remote = {};
        (res.fileIds || []).forEach(function (f) { remote[f.fileId] = f.total || 0; });
        var jobs = need.filter(function (it) {
          return remote[it.fid] && remote[it.fid] > 0 && remote[it.fid] <= CHAT_FILE_MAX_CHUNKS;
        });
        if (!jobs.length) return 0;
        var seq = Promise.resolve(0);
        jobs.forEach(function (it) {
          seq = seq.then(function (n) { return downloadChatFile(it.fid).then(function (ok) { return n + (ok ? 1 : 0); }); });
        });
        return seq.then(function (n) {
          if (n) { refreshChatRoomIfOpen(); renderChatListIfVisible(); }
          return n;
        });
      }).catch(function () { return 0; });
    });
  }
  function downloadChatFile(fileId) {
    if (_chatFileDownloading[fileId]) return Promise.resolve(false);
    _chatFileDownloading[fileId] = true;
    return gasApi({ action: 'file_get', fileId: fileId }).then(function (res) {
      var chunks = res.chunks || [];
      if (!chunks.length || chunks.length !== (res.total || chunks.length)) throw new Error('incomplete');
      return chatFileSave(fileId, chunks.join('')).then(function () { return true; });
    }).then(function (ok) {
      delete _chatFileDownloading[fileId];
      return ok;
    }).catch(function () { delete _chatFileDownloading[fileId]; return false; });
  }
  // Retry unduh dengan status jelas: bedakan server lama / masih dikirim / gagal unduh
  function retryDownloadChatFile(fileId) {
    if (!online()) { toast('❌ Tidak ada koneksi internet.'); return; }
    if (!gasActive()) return;
    toast('⏳ Mengecek file…');
    gasApi({ action: 'file_ids' }).then(function (res) {
      if (!res || !Array.isArray(res.fileIds)) { noteFileServerOutdated(); return; }
      var f = res.fileIds.filter(function (x) { return x.fileId === fileId; })[0];
      if (!f) { toast('⏳ File masih dikirim pengirim — tunggu sebentar lalu ketuk lagi.'); return; }
      if ((f.count || 0) < (f.total || 0)) { toast('⏳ File masih dikirim (' + (f.count || 0) + '/' + (f.total || 0) + ') — tunggu sebentar.'); return; }
      toast('⏳ Mengunduh file…');
      downloadChatFile(fileId).then(function (ok) {
        if (ok) { refreshChatRoomIfOpen(); toast('📎 File diterima.'); }
        else toast('❌ Gagal mengunduh — ketuk lagi untuk coba.');
      });
    }).catch(function () { toast('❌ Koneksi gagal — coba lagi.'); });
  }
  // Perbaikan 1x per load: pesan ber-file milik sendiri yang memenuhi syarat online
  // tapi tidak ada di server (mis. terkirim saat server lama) → masukkan antrean lagi
  function repairChatFileUploads() {
    if (!gasActive() || !online()) return Promise.resolve(0);
    var own = loadChat().filter(function (m) {
      return !m.deleted && m.file && m.file.name && (m.file.size || 0) <= CHAT_FILE_ONLINE_MAX;
    });
    if (!own.length) return Promise.resolve(0);
    var pending = loadChatFilePending();
    var cands = own.filter(function (m) {
      var fid = m.file.msgId || m.id;
      return pending.indexOf(fid) === -1;
    });
    if (!cands.length) return Promise.resolve(0);
    return Promise.all(cands.map(function (m) {
      var fid = m.file.msgId || m.id;
      return chatFileLoad(fid).then(function (has) { return has ? fid : null; }).catch(function () { return null; });
    })).then(function (withLocal) {
      withLocal = withLocal.filter(Boolean);
      if (!withLocal.length) return 0;
      return gasApi({ action: 'file_ids' }).then(function (res) {
        if (!res || !Array.isArray(res.fileIds)) { noteFileServerOutdated(); return 0; }
        var remote = {};
        res.fileIds.forEach(function (f) { remote[f.fileId] = f.count || 0; });
        var reQ = 0;
        withLocal.forEach(function (fid) {
          if (!remote[fid]) {
            var q = loadChatFilePending();
            if (q.indexOf(fid) === -1) { q.push(fid); saveChatFilePending(q); reQ++; }
          }
        });
        if (reQ) pumpChatFileUpload();
        return reQ;
      }).catch(function () { return 0; });
    });
  }
  function mergeChatFromRemote(remoteChats) {
    if (!Array.isArray(remoteChats) || !remoteChats.length) return 0;
    var local = loadChat();
    var map = {};
    local.forEach(function (m) { map[m.id] = m; });
    var added = 0, updated = 0;
    var newIncoming = [];
    remoteChats.forEach(function (rm) {
      var lm = map[rm.id];
      if (!lm) {
        local.push(rm);
        added++;
        newIncoming.push(rm);
      }
      else {
        // remote wins if has newer edit/read/deleted state
        var need = false;
        if (rm.edited && !lm.edited) need = true;
        if (rm.deleted && !lm.deleted) need = true;
        if (rm.read && !lm.read) need = true;
        if ((rm.text || '') !== (lm.text || '')) need = true;
        // metadata file: remote menang jika lokal belum punya info file
        var rmFile = rm.file ? (rm.file.name + '|' + rm.file.size) : '';
        var lmFile = lm.file ? (lm.file.name + '|' + lm.file.size) : '';
        if (rmFile && rmFile !== lmFile) need = true;
        if (need) { var idx = local.indexOf(lm); local[idx] = rm; updated++; }
      }
    });
    if (added || updated) saveChat(local);
    // bersihkan outbox yang sudah ada di remote
    var remoteIds = {};
    remoteChats.forEach(function (c) { remoteIds[c.id] = 1; });
    var out = loadChatOutbox().filter(function (o) { return !remoteIds[o.chat.id]; });
    if (out.length !== loadChatOutbox().length) saveChatOutbox(out);

    if (newIncoming.length && typeof handleIncomingChatNotifications === 'function') {
      handleIncomingChatNotifications(newIncoming);
    }
    return added + updated;
  }
  function gasChatPull() {
    if (!gasActive() || !online()) return Promise.resolve(0);
    return gasApi({ action: 'chat_list' }).then(function (res) {
      var n = mergeChatFromRemote(res.chats || []);
      if (n) {
        renderChatListIfVisible();
        refreshChatRoomIfOpen();
        updateChatBadge();
      }
      // piggyback: unduh biner file (gambar/PDF/dokumen) yang belum ada lokal
      syncChatFiles();
      return n;
    }).catch(function () { return 0; });
  }
  // Silent auto-pull untuk puisi (tanpa toast, untuk timer otomatis)
  function silentPoemPull() {
    if (!gasActive() || !online()) return Promise.resolve(0);
    return gasApi({ action: 'list' }).then(function (res) {
      var remote = res.poems || [];
      var local = loadPoems();
      var map = {};
      local.forEach(function (p) { map[p.code] = p; });
      var added = 0, updated = 0;
      remote.forEach(function (rp) {
        var lp = map[rp.code];
        if (!lp) { local.push(rp); added++; }
        else {
          var lt = new Date(lp.updatedAt || lp.time).getTime();
          var rt = new Date(rp.updatedAt || rp.time).getTime();
          if (rt > lt) { local[local.indexOf(lp)] = rp; updated++; }
        }
      });
      if (added || updated) {
        savePoems(local);
        saveDbToFile();
        // bersihkan outbox yang sudah ada di remote
        var codes = {};
        remote.forEach(function (p) { codes[p.code] = 1; });
        saveOutbox(loadOutbox().filter(function (o) { return !codes[o.poem.code]; }));
        // refresh tampilan jika relevan
        var adminVisible = document.querySelector('#page-admin.active');
        var galeriVisible = document.querySelector('#page-galeri.active');
        var karyakuVisible = document.querySelector('#page-karyaku.active');
        if (adminVisible) renderAdmin();
        if (galeriVisible) renderGaleri();
        if (karyakuVisible && getSession()) renderTokenChip();
      }
      return added + updated;
    }).catch(function () { return 0; });
  }
  function gasChatPushAll() {
    if (!gasActive() || !online()) return Promise.resolve(0);
    var list = loadChat().map(function (c) { return sanitizeChatForGas(c); });
    if (!list.length) return Promise.resolve(0);
    return gasApi({ action: 'chat_bulk', chats: list }).then(function () {
      saveChatOutbox([]);
      return list.length;
    }).catch(function () { return 0; });
  }
  function flushChatOutbox() {
    var q = loadChatOutbox();
    if (!q.length || !gasActive() || !online()) return Promise.resolve(0);
    var next = q[0];
    var clean = sanitizeChatForGas(next.chat);
    var payload = next.action === 'chat_create' ? { action: 'chat_create', chat: clean }
                : next.action === 'chat_update' ? { action: 'chat_update', chat: clean }
                : { action: 'chat_delete', chat: clean };
    return gasApi(payload).then(function () {
      q.shift();
      saveChatOutbox(q);
      return flushChatOutbox().then(function (n) { return n + 1; });
    }).catch(function () { return 0; });
  }
  function syncChatMessage(action, chat) {
    if (!gasActive()) return;
    var clean = sanitizeChatForGas(chat);
    var payload = action === 'create' ? { action: 'chat_create', chat: clean }
                : action === 'update' ? { action: 'chat_update', chat: clean }
                : { action: 'chat_delete', chat: clean };
    if (!online()) { enqueueChat(payload.action, clean); return; }
    gasApi(payload).catch(function (e) {
      if (e.message !== 'offline') enqueueChat(payload.action, clean);
    });
  }

  var APPS_SCRIPT_CODE = [
    '/** KYM \u2014 Penerima karya puisi & chat ke Google Spreadsheet **/',
    'var HEADER = ["code","nama","jenjang","kelas","sekolah","tahap","judul","isi","profil","time","updatedAt","device"];',
    'var HEADER_CHAT = ["id","chatKey","senderId","senderName","senderRole","text","ts","read","edited","deleted","fileName","fileType","fileSize"];',
    'var HEADER_CHATFILES = ["fileId","idx","total","chunk"];',
    '',
    'function doPost(e) {',
    '  var out = { ok: true };',
    '  try {',
    '    var body = JSON.parse(e.postData.contents);',
    '    var ss = SpreadsheetApp.getActiveSpreadsheet();',
    '    // --- Puisi sheet ---',
    '    var sh = ss.getSheetByName("Puisi") || ss.insertSheet("Puisi");',
    '    fixHeader(sh);',
    '    var p = body.poem || {};',
    '    if (body.action === "create" || body.action === "update" || body.action === "bulk") {',
    '      var items = body.action === "bulk" ? (body.poems || []) : [p];',
    '      items.forEach(function (x) {',
    '        var row = [x.code, x.nama, x.jenjang, x.kelas, x.sekolah, x.tahap, x.judul, x.isi, x.profil || "", x.time, x.updatedAt || "", x.device || ""];',
    '        var existing = findRow(sh, x.code);',
    '        if (existing === -1) sh.appendRow(row);',
    '        else {',
    '          var cur = sh.getRange(existing, 11).getValue();',
    '          var curT = cur ? new Date(cur).getTime() : 0;',
    '          var newT = new Date(x.updatedAt || x.time).getTime();',
    '          if (!curT || newT >= curT) sh.getRange(existing, 1, 1, 12).setValues([row]);',
    '        }',
    '      });',
    '      out.count = items.length;',
    '    } else if (body.action === "delete") {',
    '      var r = findRow(sh, p.code);',
    '      if (r !== -1) sh.deleteRow(r);',
    '    } else if (body.action === "list") {',
    '      var values = sh.getDataRange().getValues();',
    '      if (values.length) { out.header = values[0]; values.shift(); }',
    '      out.poems = values.map(function (v) {',
    '        return { code: String(v[0]), nama: v[1], jenjang: v[2], kelas: v[3], wa: "", sekolah: v[4], tahap: String(v[5]), judul: v[6], isi: v[7], profil: v[8], time: String(v[9]), updatedAt: v[10] ? String(v[10]) : null, device: String(v[11] || "") };',
    '      });',
    '    }',
    '    // --- Chat sheet ---',
    '    var shChat = ss.getSheetByName("Chat") || ss.insertSheet("Chat");',
    '    fixChatHeader(shChat);',
    '    if (body.action === "chat_create" || body.action === "chat_update" || body.action === "chat_bulk") {',
    '      var cItems = body.action === "chat_bulk" ? (body.chats || []) : [body.chat || {}];',
    '      cItems.forEach(function (c) {',
    '        if (!c.id) return;',
    '        var cf = c.file || {};',
    '        var cfName = String(cf.name || c.fileName || "").slice(0, 120);',
    '        var cfType = String(cf.type || c.fileType || "");',
    '        var cfSize = Number(cf.size || c.fileSize || 0) || 0;',
    '        var crow = [c.id, c.chatKey, c.senderId, c.senderName, c.senderRole, c.text, c.ts, c.read ? "1" : "", c.edited ? "1" : "", c.deleted ? "1" : "", cfName, cfType, cfSize];',
    '        var erow = findChatRow(shChat, c.id);',
    '        if (erow === -1) shChat.appendRow(crow);',
    '        else shChat.getRange(erow, 1, 1, 13).setValues([crow]);',
    '      });',
    '      out.chatCount = cItems.length;',
    '    } else if (body.action === "chat_delete") {',
    '      var cr = findChatRow(shChat, (body.chat||{}).id);',
    '      if (cr !== -1) shChat.deleteRow(cr);',
    '    } else if (body.action === "chat_list") {',
    '      var cVals = shChat.getDataRange().getValues();',
    '      if (cVals.length) { cVals.shift(); }',
    '      out.chats = cVals.filter(function(v){return String(v[0]).trim()!=="";}).map(function (v) {',
    '        var o = { id: String(v[0]), chatKey: String(v[1]), senderId: String(v[2]), senderName: String(v[3]), senderRole: String(v[4]), text: String(v[5] == null ? "" : v[5]), ts: Number(v[6]), read: String(v[7])==="1", edited: String(v[8])==="1", deleted: String(v[9])==="1" };',
    '        var fn = String(v[10] == null ? "" : v[10]);',
    '        if (fn) o.file = { name: fn, type: String(v[11] == null ? "" : v[11]), size: Number(v[12] || 0) || 0, msgId: String(v[0]) };',
    '        return o;',
    '      });',
    '    }',
    '    // --- ChatFiles sheet: biner file (gambar/PDF/dokumen) terpotong per chunk ---',
    '    var shCF = ss.getSheetByName("ChatFiles") || ss.insertSheet("ChatFiles");',
    '    fixChatFilesHeader(shCF);',
    '    if (body.action === "file_put") {',
    '      var fId = String(body.fileId || "");',
    '      var fIdx = Number(body.idx || 0);',
    '      var fTotal = Number(body.total || 0);',
    '      var fChunk = String(body.chunk == null ? "" : body.chunk);',
    '      if (fId && fChunk && fChunk.length <= 50000) {',
    '        var frow = findChatFileRow(shCF, fId, fIdx);',
    '        if (frow === -1) shCF.appendRow([fId, fIdx, fTotal, fChunk]);',
    '        else shCF.getRange(frow, 1, 1, 4).setValues([[fId, fIdx, fTotal, fChunk]]);',
    '      }',
    '    } else if (body.action === "file_ids") {',
    '      var fVals = shCF.getDataRange().getValues();',
    '      if (fVals.length) { fVals.shift(); }',
    '      var fMap = {};',
    '      fVals.forEach(function(v){ var k = String(v[0] || ""); if (!k) return; if (!fMap[k]) fMap[k] = { fileId: k, total: Number(v[2] || 0) || 0, count: 0 }; fMap[k].count++; });',
    '      out.fileIds = Object.keys(fMap).map(function(k){ return fMap[k]; });',
    '    } else if (body.action === "file_get") {',
    '      var gId = String(body.fileId || "");',
    '      var gVals = shCF.getDataRange().getValues();',
    '      if (gVals.length) { gVals.shift(); }',
    '      var gRows = gVals.filter(function(v){ return String(v[0]) === gId; });',
    '      gRows.sort(function(a,b){ return Number(a[1]) - Number(b[1]); });',
    '      out.fileId = gId;',
    '      out.total = gRows.length ? (Number(gRows[0][2] || 0) || 0) : 0;',
    '      out.chunks = gRows.map(function(v){ return String(v[3] == null ? "" : v[3]); });',
    '    } else if (body.action === "file_del") {',
    '      var dId = String(body.fileId || "");',
    '      if (dId) {',
    '        for (var di = shCF.getLastRow(); di >= 2; di--) {',
    '          if (String(shCF.getRange(di, 1).getValue()) === dId) shCF.deleteRow(di);',
    '        }',
    '      }',
    '    }',
    '  } catch (err) { out = { ok: false, error: String(err) }; }',
    '  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);',
    '}',
    '',
    '/* Pastikan header persis 12 kolom dan sejajar dengan data; bersihkan sisa kolom lama */',
    'function fixHeader(sh) {',
    '  if (sh.getLastRow() === 0) { sh.appendRow(HEADER); sh.setFrozenRows(1); return; }',
    '  var width = Math.max(sh.getLastColumn(), 12);',
    '  var hr = sh.getRange(1, 1, 1, width).getValues()[0];',
    '  var sama = HEADER.every(function (h, i) { return String(hr[i]) === h; });',
    '  if (!sama) {',
    '    sh.getRange(1, 1, 1, 12).setValues([HEADER]);',
    '    if (sh.getLastColumn() > 12) sh.getRange(1, 13, 1, sh.getLastColumn() - 12).clearContent();',
    '  }',
    '}',
    'function fixChatHeader(sh) {',
    '  if (sh.getLastRow() === 0) { sh.appendRow(HEADER_CHAT); sh.setFrozenRows(1); return; }',
    '  var w2 = Math.max(sh.getLastColumn(), 13);',
    '  var hr2 = sh.getRange(1, 1, 1, w2).getValues()[0];',
    '  var sama2 = HEADER_CHAT.every(function (h, i) { return String(hr2[i]) === h; });',
    '  if (!sama2) {',
    '    sh.getRange(1, 1, 1, 13).setValues([HEADER_CHAT]);',
    '    if (sh.getLastColumn() > 13) sh.getRange(1, 14, 1, sh.getLastColumn()-13).clearContent();',
    '  }',
    '}',
    '',
    'function findRow(sh, code) {',
    '  var values = sh.getDataRange().getValues();',
    '  for (var i = 0; i < values.length; i++) if (String(values[i][0]) === String(code)) return i + 1;',
    '  return -1;',
    '}',
    'function findChatRow(sh, id) {',
    '  var values = sh.getDataRange().getValues();',
    '  for (var i = 0; i < values.length; i++) if (String(values[i][0]) === String(id)) return i + 1;',
    '  return -1;',
    '}',
    'function fixChatFilesHeader(sh) {',
    '  if (sh.getLastRow() === 0) { sh.appendRow(HEADER_CHATFILES); sh.setFrozenRows(1); return; }',
    '  var w3 = Math.max(sh.getLastColumn(), 4);',
    '  var hr3 = sh.getRange(1, 1, 1, w3).getValues()[0];',
    '  var sama3 = HEADER_CHATFILES.every(function (h, i) { return String(hr3[i]) === h; });',
    '  if (!sama3) {',
    '    sh.getRange(1, 1, 1, 4).setValues([HEADER_CHATFILES]);',
    '    if (sh.getLastColumn() > 4) sh.getRange(1, 5, 1, sh.getLastColumn()-4).clearContent();',
    '  }',
    '}',
    'function findChatFileRow(sh, fileId, idx) {',
    '  var values = sh.getDataRange().getValues();',
    '  for (var i = 0; i < values.length; i++) if (String(values[i][0]) === String(fileId) && Number(values[i][1]) === Number(idx)) return i + 1;',
    '  return -1;',
    '}'
  ].join('\n');

  /* ---------- Penyimpanan ---------- */
  function loadPoems() {
    try { return JSON.parse(localStorage.getItem(LS_POEMS)) || []; } catch (e) { return []; }
  }
  function savePoems(a) { localStorage.setItem(LS_POEMS, JSON.stringify(a)); }
  function findPoem(code) {
    return loadPoems().filter(function (p) { return p.code === code; })[0] || null;
  }
  function loadLog() {
    try { return JSON.parse(localStorage.getItem(LS_LOG)) || []; } catch (e) { return []; }
  }
  function addLog(action, poem, actor) {
    var log = loadLog();
    log.unshift({
      time: new Date().toISOString(),
      action: action,
      title: poem ? poem.title : '(semua data)',
      code: poem ? poem.code : '',
      by: actor || '-'
    });
    if (log.length > 500) log = log.slice(0, 500);
    localStorage.setItem(LS_LOG, JSON.stringify(log));
  }
  function getPass() { return localStorage.getItem(LS_PASS) || DEFAULT_PASS; }
  function adminUnlocked() {
    try { return sessionStorage.getItem(LS_UNLOCK) === '1'; } catch (e) { return false; }
  }

  /* ---------- Navigasi halaman ---------- */
  function bolehLihatGaleri() {
    var ses = getSession();
    return adminUnlocked() || !!(ses && ses.role === 'guru');
  }
  function updateGaleriNav() {
    var g = document.querySelector('#nav-bottom a[data-nav="galeri"]');
    if (g) g.style.display = bolehLihatGaleri() ? '' : 'none';
  }
  function updateChatNav() {
    var ses = getSession();
    var chatNav = $('nav-chat');
    var show = ses || adminUnlocked();
    if (chatNav) chatNav.style.display = show ? '' : 'none';
  }
  function showPage(name) {
    var _ses = getSession();
    if (name === 'admin' && _ses && _ses.role === 'murid' && !adminUnlocked()) name = 'kirim'; /* murid tidak dapat membuka admin kecuali sudah unlock admin */
    if (name === 'galeri' && !bolehLihatGaleri()) name = 'kirim'; /* galeri khusus admin & GTK */
    if (name === 'chat' && !_ses && !adminUnlocked()) name = 'kirim'; /* chat khusus user login */
    updateGaleriNav();
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    var pg = $('page-' + name);
    if (pg) pg.classList.add('active');
    document.querySelectorAll('nav.bottom a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === name);
    });
    window.scrollTo({ top: 0 });
    if (name === 'admin') initAdmin();
    if (name === 'karyaku') renderTokenChip();
    if (name === 'galeri') renderGaleri();
    if (name === 'pasang') renderPasang();
    if (name === 'chat') { ensureAdminChat(); initChat(); }
    updateChatBadge();
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-nav]');
    if (!a) return;
    e.preventDefault();
    showPage(a.getAttribute('data-nav'));
    var hb = $('hamburger-popup'), btn = $('hamburger-btn');
    if (hb) { hb.classList.remove('show'); btn.classList.remove('open'); }
  });

  /* ---------- Hamburger menu ---------- */
  (function () {
    var btn = $('hamburger-btn'), popup = $('hamburger-popup'), wrap = $('hamburger-wrap');
    if (!btn || !popup) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var opened = popup.classList.toggle('show');
      btn.classList.toggle('open', opened);
    });
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) { popup.classList.remove('show'); btn.classList.remove('open'); }
    });
  })();

  /* ---------- Penghitung baris puisi ---------- */
  function bindCounter(taId, counterId, jenjangGetter) {
    var ta = $(taId), c = $(counterId);
    function upd() {
      var n = lineCount(ta.value);
      var cls = '', txt = n + ' baris';
      var isSD = ((jenjangGetter ? jenjangGetter() : 'SD') === 'SD');
      var minOk = isSD ? n >= 8 : n >= 10;
      if (n > 0) {
        if (n > 20) { cls = 'bad'; txt += ' — melebihi batas 20 baris!'; }
        else if (n >= 12 && n <= 15) { cls = 'ok'; txt += ' — ideal ✓'; }
        else if (!minOk) { cls = 'warn'; txt += isSD ? ' — minimal 8 baris untuk SD' : ' — minimal 10 baris'; }
        else { cls = 'warn'; }
      }
      c.textContent = txt;
      c.className = 'counter ' + cls;
    }
    ta.addEventListener('input', upd);
    return upd;
  }
  var fCounter = bindCounter('f-isi', 'count-isi', function () { return 'SD'; });

  /* ---------- Login pengirim: database murid (nis, nama, kelas) ---------- */
  var SISWA = [
    ['3262','ACHMAD DHAFIN KHALIF ALGHIFARI','3'],['3263','ALFIRA NAHDA RAFANDA','3'],['3264','ARSYILA ROMEESA FARZANA','3'],['3265','ASSYFA PUTRI NAURA ZASKIA','3'],
    ['3266','ATIQAH FATIMATUS ZAHRA','3'],['3267','ELLVINO GAVRIEL ALVARO','3'],['3268','FALISA AMALIA PUTRI','3'],['3269','GIBRAN KEENANDRA ARDIANSYAH','3'],
    ['3270','KANIA DWI NUR MAULIDDIAH','3'],['3271','MUHAMMAD ABDULLOH FADIL','3'],['3272','MUHAMMAD NATHAN HAFIZ PRADIPTA','3'],['3273','MUHAMMAD NAUFAL AL RAJABI','3'],
    ['3274','MUHAMMAD RAKA ISLAMUDDIN','3'],['3275','MUHAMMAD RAKHA FATKHUL HALIM','3'],['3276','NAFISA AZZAHRA KHUSNANDAR','3'],['3277','NIKMATUL NISA','3'],
    ['3278','OKTAVIA PUTRI GANESHA','3'],['3279','RAYSA NABILAH PUTRI','3'],['3280','RIKA ELVINA','3'],['3281','SAYYID MAULANA IBRAHIM','3'],['3282','TIKA ASSYIFAH ARRUM','3'],
    ['3240','AKBAR BRAHMATYA AR ROKHIM','4'],['3241','HALWA DEWI JASMIN','4'],['3242','JIHAN LAILATUL AZZAHRA','4'],['3243','MARSHA AUDINA AZZAHRA','4'],
    ['3244','MOCHAMAD HAFIZUDIN RIFQI ABRIZAM','4'],['3245','MUHAMMAD AZZAM MAULANA','4'],['3246','MUHAMMAD FAJAR AL HUSEIN','4'],['3247','MUHAMMAD HAMZAH IZZUDIN','4'],
    ['3248','MUHAMMAD KELVIN JUNIAR RAMADHANI','4'],['3249','MUHAMMAD KHOIRUL UMAM','4'],['3250','MUHAMMAD RAFARDHAN ATHAYA','4'],['3251','MUHAMMAD TRI DHARMA JATI','4'],
    ['3252','MUKHAMMAD RIZQI AKBAR','4'],['3253','NADYA ALYSA AZZAHRA','4'],['3254','NATASYA PUTRI RAMADHANI','4'],['3255','RISKA AR RAYA','4'],
    ['3256','SABIRA ZALFATUS SUROIYAH','4'],['3257','SABRINA ZULFATUS SUROIYAH','4'],['3258','SANDI RAMADHANI','4'],['3259','SEEHA RESTU PUTRI','4'],
    ['3260','SYAFIR SYARIF NUR ALKHUDEIR','4'],['3261','VANIA CARISSA SALSABILA','4'],
    ['3216','ADIBA RIZKI AZZAHRA','5'],['3217','AGAM ADITYA SYAPUTRA','5'],['3218','AHMAD NAZRUL ASROFI','5'],['3219','AKHMAD WILDAN RAMADANI','5'],
    ['3220','ALIKA NAYLA PUTRI INARA','5'],['3221','ALZHIYA NAJWA SYAROF','5'],['3222','APRILIA AZ ZAHRA','5'],['3223','ARIN NADIA SYAFIYAH','5'],
    ['3224','AZHAR AMANI DIAU RAHMAN','5'],['3225','FAZA MIKHAELA ANINDITA','5'],['3226','FERDY ISWANTO','5'],['3227','HAFSHAH NAIFATUS SYIFA','5'],
    ['3228','KARIN RAISYA AFIFAH','5'],['3229','MALKA SYARIF FIRDAUS','5'],['3283','MUHAMMAD ARIF AZAMI','5'],['3230','MUHAMMAD AS\'ARI','5'],['3231','MUHAMMAD ROSI SETIAWAN','5'],
    ['3232','NABILA NISA INDRIYANTI','5'],['3233','NUR RAIHANA SAKHI','5'],['3234','SAFIRA NUR FADILLAH','5'],['3235','SALMA RISQI AMADIA','5'],['3236','WILDAH MUSHOFFI','5'],
    ['3237','WINDA NUR FEBRIANTI','5'],['3238','ZAHIRA ABELIA ANINDITA','5'],
    ['3203','AMELYA ARICHA AZ-ZAHRA','6'],['3204','BARRA GERRAD AT TAMIMI','6'],['3205','DEWI SAFIRA PUTRI','6'],['3206','EARLYTA ARSYIFA SALSABILA','6'],
    ['3284','INAYA AZAMY ATHIFA','6'],['3207','MUHAMMAD ADI NUR SAPUTRA','6'],['3208','MUHAMMAD RENDRA ALIYANSYAH','6'],['3209','NAILA ZAKIYAH AQILA','6'],
    ['3210','NUR LAILIYA RIZKI','6'],['3211','RAISSA AZZAHRA','6'],['3212','RIZKIYAH AKHMAD','6'],['3213','SYARIFATUS SUAIBA','6'],['3214','WAHYUNIA ANGGRAENI','6']
  ];
  var KELAS_LABEL = { '3': 'Kelas III (Tiga)', '4': 'Kelas IV (Empat)', '5': 'Kelas V (Lima)', '6': 'Kelas VI (Enam)' };

  /* ---------- Login pengirim: sesi & akun guru ---------- */
  function getSession() {
    try { return JSON.parse(sessionStorage.getItem(LS_SESSION)); } catch (e) { return null; }
  }
  function setSession(s) { sessionStorage.setItem(LS_SESSION, JSON.stringify(s)); }
  function clearSession() { sessionStorage.removeItem(LS_SESSION); }
  function loadGuru() {
    try { return JSON.parse(localStorage.getItem(LS_GURU)) || []; } catch (e) { return []; }
  }
  function saveGuru(a) { localStorage.setItem(LS_GURU, JSON.stringify(a)); }

  function populateNama() {
    var kelas = $('l-kelas').value;
    var sel = $('l-nama');
    var daftar = SISWA.filter(function (s) { return s[2] === kelas; });
    sel.innerHTML = daftar.map(function (s) { return '<option value="' + s[0] + '">' + esc(s[1]) + '</option>'; }).join('');
  }

  /* ---------- Sesi di header (pojok kanan atas) + logout ---------- */
  function renderHeaderSesi() {
    var ses = getSession();
    var box = $('sesi-box'), namaEl = $('sesi-nama'), adminNav = $('hamburger-admin'), adminKeluar = $('admin-keluar');
    updateGaleriNav();
    updateChatNav();
    if (!box || !namaEl) return;
    if (ses) {
      var peran = ses.role === 'guru' ? 'Guru/Tendik (GTK)' : 'Murid · Kelas ' + ses.kelasDigit;
      namaEl.innerHTML = esc(ses.nama) + '<small>' + peran + '</small>';
      box.style.display = 'flex';
      if (adminNav) adminNav.style.display = ses.role === 'guru' ? '' : 'none';
    } else {
      box.style.display = 'none';
      namaEl.innerHTML = '';
      if (adminNav) adminNav.style.display = '';
    }
    if (adminKeluar) adminKeluar.style.display = adminUnlocked() ? 'flex' : 'none';
  }
  function doLogout() {
    clearSession();
    renderLoginUi();
    fCounter();
    showPage('kirim');
  }

  function renderLoginUi() {
    renderHeaderSesi();
    updateChatBadge();
    if (typeof updateNotificationBannerUi === 'function') updateNotificationBannerUi();
    var ses = getSession();
    var box = $('login-box'), wrap = $('form-kirim-wrap');
    if (ses) {
      box.style.display = 'none';
      wrap.style.display = 'block';
      $('f-nama').value = ses.nama;
      $('f-kelas').value = ses.role === 'guru' ? 'Guru/Tendik (GTK)' : KELAS_LABEL[ses.kelasDigit];
      $('profil-wrap').style.display = ses.role === 'guru' ? 'block' : 'none';
    } else {
      box.style.display = 'block';
      wrap.style.display = 'none';
    }
  }

  function initLoginUi() {
    var sb = $('btn-sesi-keluar');
    if (sb) sb.addEventListener('click', doLogout);
    populateNama();
    $('l-kelas').addEventListener('change', populateNama);
    function showTab(which) {
      $('tab-murid').classList.toggle('tab-murid-active', which === 'murid');
      $('tab-guru').classList.toggle('tab-guru-active', which === 'guru');
      $('form-login-murid').style.display = which === 'murid' ? 'block' : 'none';
      $('form-login-guru').style.display = which === 'guru' ? 'block' : 'none';
      $('form-daftar-guru').style.display = which === 'daftar' ? 'block' : 'none';
    }
    $('tab-murid').addEventListener('click', function () { showTab('murid'); });
    $('tab-guru').addEventListener('click', function () { showTab('guru'); });
    showTab('murid');
    $('link-daftar').addEventListener('click', function (e) {
      e.preventDefault();
      $('tab-murid').classList.remove('tab-murid-active');
      $('tab-guru').classList.remove('tab-guru-active');
      $('form-login-murid').style.display = 'none';
      $('form-login-guru').style.display = 'none';
      $('form-daftar-guru').style.display = 'block';
    });
    $('link-login-guru').addEventListener('click', function (e) {
      e.preventDefault();
      showTab('guru');
    });
    $('form-login-murid').addEventListener('submit', function (e) {
      e.preventDefault();
      var nis = $('l-nama').value;
      var s = SISWA.filter(function (x) { return x[0] === nis; })[0];
      if (!s) { toast('Data murid tidak ditemukan.'); return; }
      if ($('l-pass').value.trim() !== s[0]) { toast('Kata sandi salah. Kata sandi murid = NIS.'); return; }
      setSession({ role: 'murid', nis: s[0], nama: s[1], kelasDigit: s[2] });
      renderLoginUi(); fCounter();
    });
    $('form-login-guru').addEventListener('submit', function (e) {
      e.preventDefault();
      var nama = $('g-nama').value.trim();
      var g = loadGuru().filter(function (x) { return x.nama.toLowerCase() === nama.toLowerCase(); })[0];
      if (!g) { toast('Akun GTK tidak ditemukan — daftar dulu lewat tautan "Daftar di sini".'); return; }
      if ($('g-pass').value !== g.pass) { toast('Kata sandi salah.'); return; }
      setSession({ role: 'guru', nama: g.nama });
      renderLoginUi(); fCounter();
    });
    /* ---------- Toolbar murid: Tulis Baru / Edit / Hapus / Kirim ---------- */
    function hideChooser() { $('aksi-chooser').style.display = 'none'; $('aksi-chooser').innerHTML = ''; }
    $('tb-baru').addEventListener('click', function () {
      hideChooser();
      $('f-judul').value = '';
      $('f-isi').value = '';
      $('f-profil').value = '';
      var old = document.getElementById('success-box');
      if (old) old.remove();
      fCounter();
      $('f-judul').focus();
      toast('Form dibersihkan — silakan tulis puisi baru.');
    });
    function pilihKarya(teksTombol, aksi) {
      var list = myPoems();
      if (!list.length) { toast(aksi === 'edit' ? 'Belum ada karya untuk diedit — tulis dulu puisinya.' : 'Belum ada karya untuk dihapus.'); return; }
      if (list.length === 1) { aksi === 'edit' ? openModal(list[0].code, 'owner') : (deletePoem(list[0].code, 'owner') && renderTokenChip()); return; }
      var box = $('aksi-chooser');
      box.innerHTML = '<b>' + teksTombol + '</b><div style="margin-top:10px; display:flex; flex-direction:column; gap:8px; align-items:flex-start;">' +
        list.map(function (p) {
          return '<button type="button" class="btn secondary small" data-pilih="' + esc(p.code) + '">' + (aksi === 'edit' ? '✏️' : '🗑️') + ' ' + esc(p.judul) + ' — dikirim ' + fmtDT(p.time) + '</button>';
        }).join('') + '</div>';
      box.style.display = 'block';
      box.querySelectorAll('[data-pilih]').forEach(function (b) {
        b.addEventListener('click', function () {
          var code = b.getAttribute('data-pilih');
          hideChooser();
          if (aksi === 'edit') openModal(code, 'owner');
          else if (deletePoem(code, 'owner')) { renderTokenChip(); toast('Puisi berhasil dihapus.'); }
        });
      });
    }
    $('tb-edit').addEventListener('click', function () { hideChooser(); pilihKarya('Pilih karya yang akan diedit:', 'edit'); });
    $('tb-hapus').addEventListener('click', function () { hideChooser(); pilihKarya('Pilih karya yang akan dihapus:', 'hapus'); });
    $('tb-kirim').addEventListener('click', function () {
      hideChooser();
      if (!$('f-judul').value.trim()) { toast('Judul masih kosong — tulis dulu puisinya.'); $('f-judul').focus(); return; }
      if (!lineCount($('f-isi').value.trim())) { toast('Isi puisi masih kosong.'); $('f-isi').focus(); return; }
      if (!$('f-setuju').checked) { toast('Centang dulu pernyataan karya asli.'); return; }
      var f = $('form-kirim');
      f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event('submit'));
    });

    $('form-daftar-guru').addEventListener('submit', function (e) {
      e.preventDefault();
      var nama = $('gd-nama').value.trim();
      var pass = $('gd-pass').value;
      if (pass.length < 4) { toast('Kata sandi minimal 4 karakter.'); return; }
      if (pass !== $('gd-pass2').value) { toast('Ulangi kata sandi tidak sama.'); return; }
      var guru = loadGuru();
      if (guru.some(function (x) { return x.nama.toLowerCase() === nama.toLowerCase(); })) { toast('Nama ini sudah terdaftar — gunakan menu Masuk.'); return; }
      guru.push({ nama: nama, pass: pass, time: new Date().toISOString() });
      saveGuru(guru);
      setSession({ role: 'guru', nama: nama });
      renderLoginUi(); fCounter();
    });
    renderLoginUi();
  }

  /* ---------- Kirim puisi ---------- */
  function genCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var s = '';
    for (var i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return 'KYM-' + s;
  }
  function uniqueCode(poems) {
    var code;
    do { code = genCode(); } while (poems.some(function (p) { return p.code === code; }));
    return code;
  }

  $('form-kirim').addEventListener('submit', function (e) {
    e.preventDefault();
    var isi = $('f-isi').value.trim();
    var n = lineCount(isi);
    var ses = getSession();
    if (!ses) { toast('Silakan login terlebih dahulu.'); renderLoginUi(); return; }
    if (!isi) { toast('Isi puisi masih kosong.'); return; }
    if (n > 20) { toast('Isi puisi melebihi 20 baris. Mohon diringkas.'); return; }
    if (ses.role === 'guru' && !$('f-profil').value.trim()) { toast('GTK wajib mengisi profil penulis (bio narasi).'); return; }
    var jenjang = ses.role === 'guru' ? 'Guru/Tendik (GTK)' : 'SD';
    var poems = loadPoems();
    var poem = {
      code: uniqueCode(poems),
      nama: ses.nama,
      nis: ses.role === 'murid' ? ses.nis : '',
      jenjang: jenjang,
      kelas: ses.role === 'guru' ? 'Guru/Tendik (GTK)' : KELAS_LABEL[ses.kelasDigit],
      wa: '',
      sekolah: 'SD Negeri Semambung',
      tahap: '1',
      judul: $('f-judul').value.trim(),
      isi: isi,
      profil: $('f-profil').value.trim(),
      time: new Date().toISOString(),
      updatedAt: null,
      device: getDeviceId()
    };
    poems.push(poem);
    savePoems(poems);
    addLog('KIRIM', poem, poem.nama);
    syncPoem('create', poem);
    saveDbToFile();
    showSuccess(poem);
    e.target.reset();
    renderLoginUi(); /* isi ulang nama & kelas terkunci setelah form direset */
    fCounter();
  });

  function showSuccess(poem) {
    var old = document.getElementById('success-box');
    if (old) old.remove();
    var div = document.createElement('div');
    div.innerHTML =
      '<div class="card" id="success-box" style="border:2px solid #10b981; background:#f0fdf4;">' +
      '<h2 style="color:#065f46;">✅ Puisi berhasil dikirim!</h2>' +
      '<p>Terima kasih, <b>' + esc(poem.nama) + '</b>. Karya berjudul <b>&ldquo;' + esc(poem.judul) + '&rdquo;</b> sudah tersimpan.</p>' +
      '<p class="muted">Karya Anda tampil di menu <b>Karya Saya</b> — bisa diedit atau dihapus kapan saja.</p>' +
      '<div style="margin-top:10px;">' +
      '<button class="btn secondary" data-nav="karyaku">📚 Buka Karya Saya</button>' +
      '</div></div>';
    var box = div.firstElementChild;
    $('page-kirim').insertBefore(box, $('page-kirim').firstChild);
  }

  /* ---------- Karya Saya (otomatis dari sesi login — tanpa kode unik) ---------- */
  function myPoems() {
    var ses = getSession();
    if (!ses) return [];
    return loadPoems().filter(function (p) {
      return p.nama === ses.nama && (ses.role === 'guru' ? p.jenjang === 'Guru/Tendik (GTK)' : p.jenjang === 'SD');
    });
  }
  function renderTokenChip() {
    var box = $('saved-token-chip');
    var ses = getSession();
    if (!ses) {
      box.innerHTML = '<div class="callout">Silakan <b><a href="#" data-nav="kirim">login</a></b> untuk melihat karya Anda.</div>';
      $('karyaku-result').innerHTML = '';
      return;
    }
    box.innerHTML = '<div class="chip">🔐 ' + esc(ses.nama) + (ses.role === 'guru' ? ' · Guru/Tendik (GTK)' : ' · Kelas ' + ses.kelasDigit) + '</div>';
    renderMyPoems();
  }
  function renderMyPoems() {
    var list = myPoems(), res = $('karyaku-result');
    if (!list.length) {
      res.innerHTML = '<div class="callout" style="margin-top:16px;">Belum ada karya dari akun ini. <a href="#" data-nav="kirim">Kirim puisi pertama Anda</a>.</div>';
      return;
    }
    res.innerHTML = list.map(function (p) { return renderMyPoemHtml(p); }).join('') +
      '<p class="muted" style="margin-top:10px;">Total: <b>' + list.length + '</b> karya.</p>';
    list.forEach(function (p) {
      res.querySelector('[data-edit="' + p.code + '"]').addEventListener('click', function () { openModal(p.code, 'owner'); });
      res.querySelector('[data-del="' + p.code + '"]').addEventListener('click', function () {
        if (deletePoem(p.code, 'owner')) { renderTokenChip(); toast('Puisi berhasil dihapus.'); }
      });
    });
  }
  function renderMyPoemHtml(p) {
      return '<div class="poem-item" style="margin-top:16px;">' +
      '<h4>&ldquo;' + esc(p.judul) + '&rdquo;</h4>' +
      '<div class="meta">' + esc(p.nama) + ' · ' + esc(p.jenjang) + ' · ' + esc(p.kelas) + ' · ' + esc(p.sekolah) +
      ' · dikirim ' + fmtDT(p.time) + (p.updatedAt ? ' · terakhir diedit ' + fmtDT(p.updatedAt) : '') + '</div>' +
      '<pre>' + esc(p.isi) + '</pre>' +
      (p.profil ? '<p class="muted" style="margin-top:8px;"><b>Profil:</b> ' + esc(p.profil) + '</p>' : '') +
      '<div class="actions">' +
      '<button class="btn small" data-edit="' + esc(p.code) + '">✏️ Edit</button>' +
      '<button class="btn danger small" data-del="' + esc(p.code) + '">🗑️ Hapus</button>' +
      '</div></div>';
  }

  function deletePoem(code, actor) {
    var poems = loadPoems();
    var poem = poems.filter(function (x) { return x.code === code; })[0];
    if (!poem) return false;
    if (!confirm('Yakin menghapus karya \u201C' + poem.judul + '\u201D dari ' + poem.nama + '?')) return false;
    savePoems(poems.filter(function (x) { return x.code !== code; }));
    addLog('HAPUS', poem, actor);
    saveDbToFile();
    gasSend('delete', { code: code }).then(function () {
      setGasStatus('☁️ Karya juga dihapus dari Sheets.', true);
    }).catch(function (e) {
      if (e.message !== 'Belum terhubung ke Google Sheets.') setGasStatus('📮 Penghapusan akan disinkronkan nanti.', false);
    });
    renderAdmin();
    return true;
  }

  /* ---------- Modal edit (dipakai pemilik & admin) ---------- */
  var modalCtx = null; // { code, actor }
  var mCounter = bindCounter('m-isi', 'count-m-isi', function () { return $('m-jenjang').value; });
  $('m-jenjang').addEventListener('change', mCounter);

  function openModal(code, actor) {
    var p = findPoem(code);
    if (!p) { toast('Karya tidak ditemukan.'); return; }
    modalCtx = { code: code, actor: actor };
    $('m-nama').value = p.nama;
    $('m-jenjang').value = p.jenjang;
    /* Kelas: dropdown III–VI; nilai lama di luar pilihan tetap tampil agar tidak hilang */
    var mk = $('m-kelas');
    Array.prototype.slice.call(mk.querySelectorAll('option[data-temp]')).forEach(function (o) { o.remove(); });
    var hasOpt = Array.prototype.some.call(mk.options, function (o) { return o.value === p.kelas; });
    if (!hasOpt && p.kelas) {
      var opt = document.createElement('option');
      opt.value = p.kelas; opt.textContent = p.kelas + ' (nilai lama)'; opt.setAttribute('data-temp', '1');
      mk.appendChild(opt);
    }
    mk.value = p.kelas || mk.options[0].value;
    /* Sekolah permanen: SD Negeri Semambung (tidak diubah dari data) */
    $('m-judul').value = p.judul;
    $('m-isi').value = p.isi;
    $('m-profil').value = p.profil || '';
    $('modal-title').textContent = 'Edit Karya \u2014 ' + p.judul;
    $('modal-sub').innerHTML = 'Perubahan akan tercatat pada <b>Riwayat Log</b> admin.';
    mCounter();
    $('modal-back').classList.add('open');
  }
  function closeModal() { $('modal-back').classList.remove('open'); modalCtx = null; }
  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-back').addEventListener('click', function (e) {
    if (e.target === $('modal-back')) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeModal();
  });

  $('modal-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!modalCtx) return;
    var isi = $('m-isi').value.trim();
    if (!isi) { toast('Isi puisi tidak boleh kosong.'); return; }
    if (lineCount(isi) > 20) { toast('Isi puisi melebihi 20 baris.'); return; }
    var poems = loadPoems();
    var idx = poems.findIndex(function (x) { return x.code === modalCtx.code; });
    if (idx === -1) { toast('Karya tidak ditemukan.'); closeModal(); return; }
    var old = poems[idx];
    poems[idx] = {
      code: old.code,
      nama: $('m-nama').value.trim(),
      jenjang: $('m-jenjang').value,
      kelas: $('m-kelas').value,
      wa: old.wa || '',
      sekolah: ($('m-sekolah') && $('m-sekolah').value.trim()) || old.sekolah || 'SD Negeri Semambung',
      tahap: old.tahap || '1',
      judul: $('m-judul').value.trim(),
      isi: isi,
      profil: $('m-profil').value.trim(),
      time: old.time,
      updatedAt: new Date().toISOString()
    };
    savePoems(poems);
    addLog('EDIT', poems[idx], modalCtx.actor);
    syncPoem('update', poems[idx], true);
    saveDbToFile();
    closeModal();
    toast('Perubahan berhasil disimpan.');
    renderAdmin();
    // refresh tampilan pemilik bila sedang terbuka
    if (getSession() && $('karyaku-result').innerHTML.indexOf('data-edit=') !== -1) renderMyPoems();
  });

  /* ---------- Galeri Puisi (publik, hanya tampil — tanpa tombol aksi) ---------- */
  function renderGaleri() {
    var q = ($('g-cari') && $('g-cari').value.trim().toLowerCase()) || '';
    var kelas = ($('g-kelas') && $('g-kelas').value) || '';
    var list = loadPoems().filter(function (p) {
      return p.jenjang !== 'Guru/Tendik (GTK)';
    });
    if (kelas) list = list.filter(function (p) { return p.kelas === kelas; });
    if (q) {
      list = list.filter(function (p) {
        return ((p.judul || '') + ' ' + (p.nama || '') + ' ' + (p.isi || '')).toLowerCase().indexOf(q) !== -1;
      });
    }
    list.sort(function (a, b) { return String(b.time).localeCompare(String(a.time)); });
    $('g-jumlah').textContent = list.length ? list.length + ' karya' : '';
    var box = $('galeri-list');
    if (!list.length) {
      box.innerHTML = '<div class="callout">Belum ada karya' + (q || kelas ? ' yang cocok dengan pencarian/filter.' : '. Jadilah yang pertama mengirim!') + '</div>';
      return;
    }
    function kelasRingkas(k) {
      var m = String(k || '').match(/Kelas\s+(III|IV|V|VI)\b/);
      return m ? m[1] : String(k || '').replace(/^Kelas\s+/, '');
    }
    box.innerHTML = list.map(function (p) {
      return '<details class="poem-item" style="margin-top:12px;">' +
        '<summary style="cursor:pointer; font-weight:700; color:var(--primary-2);">&ldquo;' + esc(p.judul) + '&rdquo;</summary>' +
        '<div class="meta" style="margin:6px 0 4px;">' + esc(p.nama) + ' · ' + esc(kelasRingkas(p.kelas)) + ' · SD Negeri Semambung · dikirim ' + fmtDT(p.time) + '</div>' +
        '<pre style="margin-top:6px; max-height:none; overflow:visible; height:auto;">' + esc(p.isi) + '</pre>' +
        '</details>';
    }).join('');
  }
  $('g-cari').addEventListener('input', renderGaleri);
  $('g-kelas').addEventListener('change', renderGaleri);

  /* ---------- Admin ---------- */
  var WORD_DOC = null;

  function initAdmin() {
    updateGaleriNav();
    if (adminUnlocked()) {
      $('admin-login').style.display = 'none';
      $('admin-panel').style.display = 'block';
      renderAdmin();
      initGasUi();
      // auto-sync: tarik karya terbaru dari Sheets agar puisi murid di HP lain langsung tampil
      if (gasActive() && online()) {
        gasPull().then(function () { renderAdmin(); });
        flushOutbox();
        gasChatPull();
      }
    } else {
      $('admin-login').style.display = 'block';
      $('admin-panel').style.display = 'none';
    }
  }

  $('form-admin-login').addEventListener('submit', function (e) {
    e.preventDefault();
    if ($('in-pass').value === getPass()) {
      try { sessionStorage.setItem(LS_UNLOCK, '1'); } catch (err) {}
      $('in-pass').value = '';
      renderHeaderSesi();
      initAdmin();
      updateChatBadge();
    } else {
      toast('Password salah.');
    }
  });

  $('btn-admin-keluar').addEventListener('click', function () {
    try { sessionStorage.removeItem(LS_UNLOCK); } catch (e) {}
    renderHeaderSesi();
    initAdmin();
    updateChatBadge();
    showPage('admin'); /* hindari galeri menggantung tanpa akses */
    toast('Anda telah keluar dari panel admin.');
  });

  $('btn-link-pasang').addEventListener('click', function () {
    var url = location.origin + location.pathname + '#pasang';
    copyText(url);
    toast('🔗 Link pemasangan disalin — tempel di grup WhatsApp murid.');
  });

  function filteredPoems() {
    var q = ($('q-rekap').value || '').toLowerCase();
    var j = $('q-jenjang').value;
    return loadPoems().filter(function (p) {
      if (j && p.jenjang !== j) return false;
      if (!q) return true;
      return [p.nama, p.judul, p.sekolah, p.kelas, p.code]
        .join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderAdmin() {
    if (!adminUnlocked()) return;
    var poems = loadPoems();
    var list = filteredPoems();

    // statistik
    var penulis = {}, t1 = 0, t2 = 0, gtk = 0;
    poems.forEach(function (p) {
      penulis[(p.nama || '').toLowerCase() + '|' + p.sekolah] = 1;
      if (p.tahap === '2') t2++; else t1++;
      if (p.jenjang === 'Guru/Tendik (GTK)') gtk++;
    });
    $('st-total').textContent = poems.length;
    $('st-penulis').textContent = Object.keys(penulis).length;
    $('st-tahap1').textContent = t1;
    $('st-tahap2').textContent = t2;
    $('st-gtk').textContent = gtk;
    $('st-siswa').textContent = poems.length - gtk;

    // tabel rekap
    var tb = $('tbody-rekap');
    var rn = document.getElementById('rekap-n');
    if (rn) rn.textContent = list.length ? '— ' + list.length + ' karya' : '';
    /* Kelas ringkas: "Kelas IV (Empat)" -> "IV" */
    function kelasRingkas(k) {
      var s = String(k || '');
      var m = s.match(/Kelas\s+(III|IV|V|VI)\b/);
      if (m) return m[1];
      return s.replace(/^Kelas\s+/, '') || '';
    }
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center; padding:24px;">Belum ada karya yang dikirim.</td></tr>';
    } else {
      tb.innerHTML = list.map(function (p, i) {
        return '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td><b>' + esc(p.judul) + '</b> <span class="muted" style="font-size:.75rem; white-space:nowrap;">' + esc(p.code) + '</span></td>' +
          '<td>' + esc(p.nama) + '</td>' +
          '<td><b>' + esc(kelasRingkas(p.kelas)) + '</b><br><span class="muted" style="font-size:.8rem;">' + esc(p.sekolah) + '</span></td>' +
          '<td>' + lineCount(p.isi) + '</td>' +
          '<td>Tahap ' + esc(p.tahap || '1') + '</td>' +
          '<td>' + fmtDT(p.time) + (p.updatedAt ? '<br><span class="muted" style="font-size:.78rem;">edit: ' + fmtDT(p.updatedAt) + '</span>' : '') + '</td>' +
          '<td class="td-actions">' +
            '<button class="btn small" data-edit="' + esc(p.code) + '" title="Edit karya">✏️</button> ' +
            '<button class="btn small" data-word="' + esc(p.code) + '" title="Unduh file Word puisi ini">📄</button> ' +
            '<button class="btn danger small" data-del="' + esc(p.code) + '" title="Hapus karya">🗑️</button>' +
          '</td></tr>';
      }).join('');
    }
    tb.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openModal(b.getAttribute('data-edit'), 'admin'); });
    });
    tb.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (deletePoem(b.getAttribute('data-del'), 'admin')) toast('Karya telah dihapus.');
      });
    });
    tb.querySelectorAll('[data-word]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = findPoem(b.getAttribute('data-word'));
        if (!p) { toast('Karya tidak ditemukan.'); return; }
        var fname = wordFileName(p);
        saveFile(singleWordDoc(p), fname, 'application/msword');
        addLog('UNDUH WORD', p, 'admin');
        saveDbToFile();
        renderAdmin();
        toast('File Word diunduh: ' + fname);
      });
    });

    // log
    var log = loadLog();
    $('tbody-log').innerHTML = log.length
      ? log.map(function (l) {
          return '<tr><td>' + fmtDT(l.time) + '</td><td>' + esc(l.action) + '</td><td>' +
            esc(l.title) + (l.code ? ' <span class="muted">(' + esc(l.code) + ')</span>' : '') +
            '</td><td>' + esc(l.by) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="4" class="muted" style="text-align:center;">Belum ada aktivitas.</td></tr>';

    renderRekapMurid(poems);
  }

  /* ---------- Rekap kirim murid (80 murid terdaftar): sudah vs belum ---------- */
  function renderRekapMurid(poems) {
    var kelas = $('rm-kelas') ? $('rm-kelas').value : '';
    var status = $('rm-status') ? $('rm-status').value : '';
    var q = ($('rm-cari') && $('rm-cari').value.trim().toLowerCase()) || '';
    var karyaPerNis = {};
    (poems || []).forEach(function (p) {
      if (p.jenjang === 'Guru/Tendik (GTK)') return;
      var nis = String(p.nis || '');
      if (!nis) {
        /* karya sebelum sistem login: cocokkan nama */
        var s = SISWA.filter(function (x) { return x[1] === p.nama; })[0];
        nis = s ? s[0] : '';
      }
      if (nis) {
        if (!karyaPerNis[nis]) karyaPerNis[nis] = [];
        karyaPerNis[nis].push(p);
      }
    });
    var daftar = SISWA.filter(function (s) {
      if (kelas && s[2] !== kelas) return false;
      var sudah = !!karyaPerNis[s[0]];
      if (status === 'sudah' && !sudah) return false;
      if (status === 'belum' && sudah) return false;
      if (q && (s[1].toLowerCase().indexOf(q) === -1 && s[0].indexOf(q) === -1)) return false;
      return true;
    });
    var totalSudah = SISWA.filter(function (s) { return !!karyaPerNis[s[0]]; }).length;
    var totalBelum = SISWA.length - totalSudah;
    $('rm-n').textContent = '— ' + SISWA.length + ' murid terdaftar';
    $('rm-stats').innerHTML =
      '<span>✅ Sudah mengirim: <b style="color:#059669;">' + totalSudah + '</b></span>' +
      '<span>⬜ Belum mengirim: <b style="color:#dc2626;">' + totalBelum + '</b></span>' +
      '<span>👥 Total murid: <b>' + SISWA.length + '</b></span>' +
      '<span>📄 Total karya murid: <b>' + Object.keys(karyaPerNis).reduce(function (a, k) { return a + karyaPerNis[k].length; }, 0) + '</b></span>';
    var tb = $('tbody-rm');
    if (!daftar.length) {
      tb.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center; padding:20px;">Tidak ada murid yang cocok dengan filter.</td></tr>';
      return;
    }
    tb.innerHTML = daftar.map(function (s, i) {
      var karya = karyaPerNis[s[0]] || [];
      var sudah = karya.length > 0;
      var judul = sudah
        ? karya.map(function (p) { return esc(p.judul); }).join(', ')
        : '<span class="muted">—</span>';
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + esc(s[0]) + '</td>' +
        '<td style="font-weight:' + (sudah ? '600' : '400') + ';">' + esc(s[1]) + '</td>' +
        '<td><b>' + s[2] + '</b></td>' +
        '<td style="max-width:260px;">' + judul + (karya.length > 1 ? ' <span class="muted" style="font-size:.75rem;">(' + karya.length + ' karya)</span>' : '') + '</td>' +
        '<td>' + (sudah
          ? '<span style="color:#059669; font-weight:700;">✅ Sudah</span>'
          : '<span style="color:#dc2626; font-weight:700;">⬜ Belum</span>') + '</td>' +
      '</tr>';
    }).join('');
  }
  ['rm-kelas', 'rm-status'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', function () { renderAdmin(); });
  });
  var rmCariEl = document.getElementById('rm-cari');
  if (rmCariEl) rmCariEl.addEventListener('input', function () { renderAdmin(); });

  $('q-rekap').addEventListener('input', renderAdmin);
  $('q-jenjang').addEventListener('change', renderAdmin);

  $('btn-clear-all').addEventListener('click', function () {
    if (!confirm('Hapus SEMUA data karya dan log? Tindakan ini tidak dapat dibatalkan!')) return;
    if (!confirm('Sekali lagi: yakin menghapus semua data secara permanen?')) return;
    localStorage.removeItem(LS_POEMS);
    localStorage.removeItem(LS_LOG);
    renderAdmin();
    addLog('HAPUS SEMUA', null, 'admin');
    toast('Semua data telah dihapus.');
  });

  $('btn-change-pass').addEventListener('click', function () {
    var baru = prompt('Masukkan password admin baru:');
    if (baru === null) return;
    if (baru.length < 5) { toast('Password minimal 5 karakter.'); return; }
    localStorage.setItem(LS_PASS, baru);
    toast('Password admin berhasil diganti.');
  });

  /* ---------- UI Integrasi Google Sheets ---------- */
  function initGasUi() {
    $('gas-url').value = getGasUrl();
    saveOutbox(loadOutbox()); // segarkan badge antrean
    if (gasActive()) setGasStatus('Terhubung. Gunakan Tarik/Dorong untuk sinkronisasi.', true);
    else setGasStatus('Belum terhubung.');
  }

  $('btn-gas-save').addEventListener('click', function () {
    var u = $('gas-url').value.trim();
    if (u.indexOf('http') !== 0) { setGasStatus('❌ URL tidak valid — tempel Web App URL yang berakhiran /exec.', false); return; }
    setGasUrl(u);
    setGasStatus('⏳ Menguji koneksi…');
    gasApi({ action: 'list' }).then(function (res) {
      setGasStatus('✅ Terhubung! ' + (res.poems ? res.poems.length : 0) + ' karya saat ini di Sheets.', true);
      toast('Google Sheets berhasil terhubung.');
    }).catch(function (e) {
      setGasStatus('❌ Gagal: ' + e.message + ' — pastikan akses deployment "Anyone" dan URL berakhiran /exec.', false);
    });
  });

  $('btn-gas-guide').addEventListener('click', function () {
    $('gas-code').textContent = APPS_SCRIPT_CODE;
    $('guide-back').classList.add('open');
  });
  $('guide-copy').addEventListener('click', function () {
    copyText(APPS_SCRIPT_CODE);
    toast('Kode Apps Script disalin — tempel di editor Apps Script.');
  });
  $('guide-close').addEventListener('click', function () { $('guide-back').classList.remove('open'); });
  $('guide-back').addEventListener('click', function (e) {
    if (e.target === $('guide-back')) $('guide-back').classList.remove('open');
  });  $('btn-gas-pull').addEventListener('click', gasPull);
  $('btn-gas-push').addEventListener('click', gasPushAll);

  // Cek header spreadsheet: baca baris header terkini hasil baca server (action 'list'
  // sudah mengembalikan values[0] setelah fixHeader server berjalan), lalu bandingkan
  // dengan struktur 12 kolom yang diharapkan.
  var GAS_EXPECTED_HEADER = ['code', 'nama', 'jenjang', 'kelas', 'sekolah', 'tahap', 'judul', 'isi', 'profil', 'time', 'updatedAt', 'device'];
  function showGasHeaderBox(title, header, noteHtml, ok) {
    $('gas-header-title').textContent = title;
    $('gas-header-title').style.color = ok === false ? '#dc2626' : (ok === true ? '#059669' : '');
    var body = $('gas-header-body');
    body.innerHTML = header.map(function (h, i) {
      var val = String(h === undefined || h === null ? '' : h);
      var sisa = i >= 12;
      var benar = !sisa && val === GAS_EXPECTED_HEADER[i];
      var warna = (!sisa && !benar) || (sisa && val) ? '#b45309' : (ok === false ? '#dc2626' : '#059669');
      var label = sisa
        ? (val ? ' <span style="color:#b45309; font-size:.75rem;">(kolom sisa berisi data — sebaiknya dihapus)</span>' : ' <span style="color:#64748b; font-size:.75rem;">(kolom sisa kosong — tidak berpengaruh)</span>')
        : (benar ? '' : ' <span style="color:#b45309; font-size:.75rem;">(harusnya: ' + esc(GAS_EXPECTED_HEADER[i] || '—') + ')</span>');
      return '<tr>' +
        '<td style="padding:4px 10px 4px 0; color:#64748b; white-space:nowrap;">Kolom ' + (i + 1) + '</td>' +
        '<td style="padding:4px 0; font-weight:600; color:' + warna + '; white-space:nowrap;">' + esc(val || '(kosong)') + label + '</td>' +
      '</tr>';
    }).join('');
    $('gas-header-note').innerHTML = noteHtml;
    $('gas-header-box').style.display = 'block';
  }
  function hideGasHeaderBox() {
    var b = $('gas-header-box');
    if (b) b.style.display = 'none';
  }
  $('btn-gas-header').addEventListener('click', function () {
    if (!gasActive()) { toast('Simpan URL Google Sheets terlebih dahulu.'); return; }
    setGasStatus('⏳ Membaca header dari server…');
    gasApi({ action: 'list' }).then(function (res) {
      var hdr = res.header;
      var n = (res.poems || []).length;
      if (!hdr || !hdr.length) {
        showGasHeaderBox('❌ Baris header tidak terbaca', ['?'], 'Server tidak mengembalikan baris pertama. Kemungkinan spreadsheet masih kosong atau kode Apps Script versi lama — salin ulang kode dari 📖 Panduan & Kode lalu re-deploy.', false);
        setGasStatus('❌ Header tidak terbaca dari server.', false);
        return;
      }
      var hdr12 = hdr.slice(0, 12);
      var extra = hdr.slice(12);
      var extraBerisi = extra.some(function (h) { return String(h || '').trim() !== ''; });
      var sama = hdr12.length === 12 && hdr12.every(function (h, i) { return String(h) === GAS_EXPECTED_HEADER[i]; });
      if (sama && !extraBerisi) {
        var catatan = 'Urutan kolom: <b>code → nama → jenjang → kelas → sekolah → tahap → judul → isi → profil → time → updatedAt → device</b>. Kiriman baru tersimpan rapi di kolom yang benar.' + (n ? ' Jumlah karya di Sheets saat ini: <b>' + n + '</b>.' : ' Spreadsheet masih kosong.');
        if (extra.length) catatan += ' Ada ' + extra.length + ' kolom sisa kosong di kanan header — tidak berpengaruh; hapus kolomnya langsung di spreadsheet jika ingin tampilan benar-benar rapi.';
        showGasHeaderBox('✅ Header sejajar — 12 kolom sesuai struktur terbaru', hdr, catatan, true);
        setGasStatus('✅ Header spreadsheet sejajar (12 kolom).', true);
      } else {
        showGasHeaderBox('⚠️ Header TIDAK sejajar dengan struktur terbaru', hdr,
          'Baris header di spreadsheet berbeda dari struktur 12 kolom terbaru (code, nama, jenjang, kelas, sekolah, tahap, judul, isi, profil, time, updatedAt, device). Perbaiki dengan: 📖 Panduan &amp; Kode → 📋 Salin Kode Apps Script → tempel di Apps Script → Deploy → New version. Header akan diperbaiki otomatis saat kiriman masuk.', false);
        setGasStatus('⚠️ Header spreadsheet tidak sejajar — lihat detail di bawah.', false);
      }
    }).catch(function (e) {
      showGasHeaderBox('❌ Gagal membaca header', ['?'], 'Terjadi galat: <b>' + esc(e.message) + '</b>. Periksa koneksi internet, akses deployment "Siapa saja", dan URL berakhiran /exec.', false);
      setGasStatus('❌ Gagal membaca header: ' + e.message, false);
    });
  });

  $('btn-gas-retry').addEventListener('click', function () {
    setGasStatus('⏳ Mengirim ulang antrean…');
    flushOutbox().then(function (n) {
      if (n) { setGasStatus('✅ ' + n + ' kiriman tertunda berhasil disinkronkan.', true); toast(n + ' kiriman tertunda terkirim.'); }
      else setGasStatus('Tidak ada yang bisa dikirim sekarang — periksa koneksi atau URL.', false);
    });
  });

  /* ---------- File Database: tombol UI ---------- */
  function refreshDbUi() {
    var ub = $('btn-db-unlink');
    if (dbFileHandle) {
      ub.style.display = 'inline-block';
      setDbStatus('🔗 Terhubung ke "' + dbFileHandle.name + '" — perubahan tersimpan otomatis.', true);
    } else {
      ub.style.display = 'none';
      setDbStatus('Mode saat ini: localStorage browser. Belum ada file database terhubung.');
    }
  }

  // Simpan handle ke IDB; jika lingkungan tidak bisa mengkloning, simpan deskriptor saja
  function idbSetSafe(key, handle) {
    return idbSet(key, handle).catch(function () {
      return idbSet(key, { name: (handle && handle.name) || 'kym-database.json', descriptorOnly: true }).catch(function () {});
    });
  }

  $('btn-db-connect').addEventListener('click', function () {
    if (!fsaSupported()) {
      toast('Browser ini tidak mendukung file otomatis — gunakan tombol Unduh/Pulihkan.');
      setDbStatus('Browser tidak mendukung koneksi file otomatis (pakai Chrome/Edge di desktop). Unduh & Pulihkan tetap berfungsi.', false);
      return;
    }
    showSaveFilePicker({ suggestedName: 'kym-database.json', types: [{ description: 'KYM Database', accept: { 'application/json': ['.json'] } }] })
      .then(function (handle) {
        dbFileHandle = handle;
        return idbSetSafe('fileHandle', handle).then(function () {
          return writeFileToHandle(handle, buildDbObject());
        }).then(function () {
          refreshDbUi();
          toast('File database terhubung — tersimpan otomatis dari sekarang.');
        });
      })
      .catch(function (e) {
        if (e && e.name === 'AbortError') return;
        setDbStatus('❌ Gagal menghubungkan file: ' + (e.message || e), false);
      });
  });

  $('btn-db-unlink').addEventListener('click', function () {
    dbFileHandle = null;
    idbDel('fileHandle').then(refreshDbUi);
    toast('File database dilepas. Data tetap aman di browser.');
  });

  $('btn-db-download').addEventListener('click', function () {
    var obj = buildDbObject();
    var d = new Date();
    var stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
    saveFile(serializeDb(obj), 'kym-database-' + stamp + '.json', 'application/json');
    toast('Database diunduh — simpan di tempat aman (Drive/flashdisk).');
  });

  /* ---------- Ekspor Excel (.xlsx) — ZIP+XML ditulis langsung, tanpa library ---------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Buat file ZIP (stored, tanpa kompresi) dari daftar {name, data:Uint8Array}
  function makeZip(files) {
    var chunks = [], central = [], offset = 0;
    var te = new TextEncoder();
    files.forEach(function (f) {
      var nameU8 = te.encode(f.name);
      var data = f.data;
      var crc = crc32(data);
      var local = new Uint8Array(30 + nameU8.length);
      var dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);   // local file header signature
      dv.setUint16(4, 20, true);           // version needed
      dv.setUint16(6, 0x0800, true);       // UTF-8 flag
      dv.setUint16(8, 0, true);            // method: stored
      dv.setUint16(10, 0, true);           // mod time
      dv.setUint16(12, 0x21, true);        // mod date (1996-01-01; cukup untuk Excel)
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true); // compressed size
      dv.setUint32(22, data.length, true); // uncompressed size
      dv.setUint16(26, nameU8.length, true);
      dv.setUint16(28, 0, true);           // extra len
      local.set(nameU8, 30);
      chunks.push(local, data);

      var cen = new Uint8Array(46 + nameU8.length);
      var cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);   // central dir signature
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed
      cv.setUint16(8, 0x0800, true);       // UTF-8 flag
      cv.setUint16(10, 0, true);           // method stored
      cv.setUint16(12, 0, true);           // time
      cv.setUint16(14, 0x21, true);        // date
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameU8.length, true);
      cv.setUint32(42, offset, true);      // local header offset
      cen.set(nameU8, 46);
      central.push(cen);

      offset += local.length + data.length;
    });
    var centralSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);     // EOCD signature
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [end]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function xmlEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
    });
  }

  // Buat XML satu sheet; rows = array of array (string | number)
  function sheetXml(rows) {
    var out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    rows.forEach(function (row, ri) {
      out += '<row r="' + (ri + 1) + '">';
      row.forEach(function (cell, ci) {
        var ref = String.fromCharCode(65 + ci) + (ri + 1);
        if (typeof cell === 'number' && isFinite(cell)) {
          out += '<c r="' + ref + '"><v>' + cell + '</v></c>';
        } else {
          out += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(cell) + '</t></is></c>';
        }
      });
      out += '</row>';
    });
    return out + '</sheetData></worksheet>';
  }

  function buildXlsx() {
    var te = new TextEncoder();
    var db = buildDbObject();
    var poems = db.poems, log = db.log;

    // Sheet 1: Karya
    var karyaRows = [['Kode', 'Judul', 'Penulis', 'Jenjang', 'Kelas', 'Sekolah', 'Jumlah Baris', 'Tahap', 'Waktu Kirim', 'Terakhir Edit', 'Perangkat', 'Isi Puisi', 'Profil Penulis']];
    poems.forEach(function (p) {
      karyaRows.push([p.code, p.judul, p.nama, p.jenjang, p.kelas, p.sekolah, lineCount(p.isi), 'Tahap ' + (p.tahap || '1'), fmtDT(p.time), p.updatedAt ? fmtDT(p.updatedAt) : '-', p.device || '', p.isi, p.profil || '']);
    });

    // Sheet 2: Log Aktivitas
    var logRows = [['Waktu', 'Aksi', 'Karya', 'Kode', 'Oleh']];
    log.forEach(function (l) {
      logRows.push([fmtDT(l.time), l.action, l.title, l.code || '', l.by || '']);
    });

    // Sheet 3: Ringkasan
    var penulis = {}, t1 = 0, t2 = 0, gtk = 0, sekolah = {};
    poems.forEach(function (p) {
      penulis[(p.nama || '').toLowerCase() + '|' + p.sekolah] = 1;
      sekolah[p.sekolah] = (sekolah[p.sekolah] || 0) + 1;
      if (p.tahap === '2') t2++; else t1++;
      if (p.jenjang === 'Guru/Tendik (GTK)') gtk++;
    });
    var sumRows = [['Ringkasan Database KYM'], [''], ['Keterangan', 'Nilai'],
      ['Diekspor', new Date().toLocaleString('id-ID')],
      ['Tema', 'Rukun dengan Teman'],
      ['Total karya', poems.length],
      ['Penulis unik', Object.keys(penulis).length],
      ['Sekolah/lembaga', Object.keys(sekolah).length],
      ['Tahap 1', t1], ['Tahap 2', t2],
      ['GTK', gtk], ['Siswa', poems.length - gtk],
      ['Entri log aktivitas', log.length]];
    Object.keys(sekolah).sort().forEach(function (s) {
      sumRows.push(['Karya dari ' + s, sekolah[s]]);
    });

    var sheets = [
      { name: 'Karya', xml: sheetXml(karyaRows) },
      { name: 'Log Aktivitas', xml: sheetXml(logRows) },
      { name: 'Ringkasan', xml: sheetXml(sumRows) }
    ];

    // Rakit bagian-bagian paket .xlsx
    var files = [{ name: '[Content_Types].xml', data: te.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
      '</Types>') }];
    files.push({ name: '_rels/.rels', data: te.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>') });
    files.push({ name: 'xl/workbook.xml', data: te.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + sheets.map(function (s, i) { return '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets></workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: te.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '</Relationships>') });
    sheets.forEach(function (s, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: te.encode(s.xml) });
    });
    return makeZip(files);
  }

  $('btn-db-xlsx').addEventListener('click', function () {
    var poems = loadPoems();
    if (!poems.length) { toast('Belum ada karya untuk diekspor.'); return; }
    var d = new Date();
    var stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
    var blob = buildXlsx();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'kym-database-' + stamp + '.xlsx';
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 150);
    addLog('EKSPOR EXCEL', null, 'admin');
    renderAdmin();
    toast('Database Excel (.xlsx) diunduh — 3 sheet: Karya, Log, Ringkasan.');
  });

  $('btn-db-open').addEventListener('click', function () { $('file-db-open').click(); });
  $('file-db-open').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var merge = $('db-merge').checked;
    readDbFromFile(f).then(function (data) {
      if (!merge && loadPoems().length && !confirm('Mode TIMPA: seluruh data saat ini akan diganti isi file "' + f.name + '". Lanjutkan?')) return;
      commitDb(data, merge, f.name);
    }).catch(function (err) {
      setDbStatus('❌ ' + err.message, false);
      toast(err.message);
    });
    e.target.value = '';
  });

  // Pulihkan koneksi file saat panel admin dibuka (izin ulang otomatis oleh browser)
  function restoreDbHandle() {
    if (!fsaSupported() || dbFileHandle) return Promise.resolve();
    return idbGet('fileHandle').then(function (h) {
      if (!h || h.descriptorOnly) return;
      return h.queryPermission({ mode: 'readwrite' }).then(function (st) {
        if (st === 'granted') { dbFileHandle = h; refreshDbUi(); return; }
        return h.requestPermission({ mode: 'readwrite' }).then(function (st2) {
          if (st2 === 'granted') { dbFileHandle = h; refreshDbUi(); }
        }).catch(function () {});
      }).catch(function () {});
    }).catch(function () {});
  }

  var _initAdmin = initAdmin;
  initAdmin = function () {
    _initAdmin();
    refreshDbUi();
    restoreDbHandle();
  };

  $('btn-import').addEventListener('click', function () { $('file-import').click(); });
  $('file-import').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var data = JSON.parse(r.result);
        var poems = Array.isArray(data.poems) ? data.poems : (Array.isArray(data) ? data : null);
        if (!poems) throw new Error('format');
        if (!confirm('Impor ' + poems.length + ' karya? Data yang sama (kode sama) akan ditimpa.')) return;
        var cur = loadPoems();
        poems.forEach(function (p) {
          var i = cur.findIndex(function (x) { return x.code === p.code; });
          if (i !== -1) cur[i] = p; else cur.push(p);
        });
        if (Array.isArray(data.log)) localStorage.setItem(LS_LOG, JSON.stringify(data.log));
        savePoems(cur);
        addLog('IMPOR', null, 'admin');
        saveDbToFile();
        renderAdmin();
        toast('Impor berhasil: ' + poems.length + ' karya.');
      } catch (err) {
        toast('File tidak valid. Gunakan backup JSON dari aplikasi ini.');
      }
    };
    r.readAsText(f);
    e.target.value = '';
  });

  $('btn-export').addEventListener('click', function () {
    var data = { app: 'KYM', exportedAt: new Date().toISOString(), poems: loadPoems(), log: loadLog() };
    saveFile(JSON.stringify(data, null, 2), 'kym-backup-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json');
    toast('Backup JSON diunduh.');
  });

  /* ---------- Unduh CSV ---------- */
  $('btn-csv').addEventListener('click', function () {
    var list = filteredPoems();
    if (!list.length) { toast('Belum ada data untuk diunduh.'); return; }
    var head = ['No', 'Kode', 'Judul', 'Penulis', 'Jenjang', 'Kelas', 'Sekolah', 'Jumlah Baris', 'Tahap', 'Waktu Kirim', 'Terakhir Edit'];
    var rows = list.map(function (p, i) {
      return [i + 1, p.code, p.judul, p.nama, p.jenjang, p.kelas, p.sekolah, lineCount(p.isi), 'Tahap ' + (p.tahap || '1'), fmtDT(p.time), p.updatedAt ? fmtDT(p.updatedAt) : '-'];
    });
    var csv = '\ufeff' + [head].concat(rows).map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(';');
    }).join('\r\n');
    saveFile(csv, 'kym-rekap.csv', 'text/csv');
    toast('Rekap CSV diunduh.');
  });

  /* ---------- Unduh semua puisi dalam satu file Word ---------- */
  var WORD_STYLES =
    '@page { size: 21cm 29.7cm; margin: 4cm 3cm 4cm 3cm; }' +
    'body { font-family: "Times New Roman", serif; font-size: 12pt; line-height: 1.5; }' +
    '.covertitle { font-size: 16pt; font-weight: bold; text-align: center; }' +
    '.coverinfo { text-align: center; }' +
    '.sep { page-break-before: always; }' +
    '.ptitle { text-align: center; font-weight: bold; text-transform: uppercase; }' +
    '.pauthor { text-align: center; }' +
    '.pschool { text-align: center; margin-bottom: 18pt; }' +
    '.verse { margin: 0; }' +
    '.pbio { margin-top: 18pt; text-align: justify; }';
  function wordDocStart(title) {
    return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><meta charset="utf-8"><title>' + title + '</title>' +
      '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->' +
      '<style>' + WORD_STYLES + '</style></head><body>';
  }
  var WORD_DOC_END = '</body></html>';

  function wordEscape(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function poemWordHtml(p) {
    var isiLines = String(p.isi || '').split('\n').map(function (l) {
      return '<p class="verse">' + (wordEscape(l) || '&nbsp;') + '</p>';
    }).join('');
    /* Struktur resmi KYM: JUDUL -> Nama Penulis -> Nama Sekolah -> Isi Puisi.
       Biodata narasi hanya untuk GTK (murid tidak ada bionarasi). */
    var isGtk = p.jenjang === 'Guru/Tendik (GTK)';
    return '<div class="poem">' +
      '<p class="ptitle">' + wordEscape(p.judul) + '</p>' +
      '<p class="pauthor">' + wordEscape(p.nama) + '</p>' +
      '<p class="pschool">' + wordEscape(p.sekolah) + '</p>' +
      isiLines +
      (isGtk && p.profil ? '<p class="pbio">' + wordEscape(p.profil) + '</p>' : '') +
      '</div>';
  }
  function buildWordDoc(poems) {
    var n = poems.length;
    var body = poems.map(poemWordHtml).join('<div class="sep"></div>');
    return wordDocStart('Rekap Karya Puisi KYM') +
      '<p class="covertitle">REKAP KARYA PUISI MURID</p>' +
      '<p class="coverinfo">KYM &mdash; Tema: Rukun dengan Teman</p>' +
      '<p class="coverinfo">Total: ' + n + ' karya &mdash; Diunduh: ' + new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) + '</p>' +
      '<div class="sep"></div>' + body +
      WORD_DOC_END;
  }

  /* ---------- Unduh Word per-puisi ---------- */
  function sanitizeFilename(s) {
    return String(s == null ? '' : s)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ').trim()
      .slice(0, 60).trim();
  }
  function wordFileName(p) {
    var nama = sanitizeFilename(p.nama);
    var judul = sanitizeFilename(p.judul);
    var base = (nama && judul) ? nama + ' - ' + judul : (nama || judul || p.code);
    return base + '.doc';
  }
  function singleWordDoc(p) {
    return wordDocStart(wordEscape(p.judul) + ' \u2014 ' + wordEscape(p.nama)) +
      poemWordHtml(p) +
      WORD_DOC_END;
  }
  $('btn-word').addEventListener('click', function () {
    var list = filteredPoems();
    if (!list.length) { toast('Belum ada karya untuk diunduh.'); return; }
    /* Nama file sesuai ketentuan KYM: SDN_Guru PJ_Nubar Menteri_Jumlah (dengan sekolah Semambung) */
    var fname = 'SDN_Semambung_Guru PJ_Nubar Menteri_' + list.length + ' Karya.doc';
    saveFile(buildWordDoc(list), fname, 'application/msword');
    toast(list.length + ' karya diunduh sebagai file Word.');
  });

  /* ---------- Cetak rekap (print-friendly) ---------- */
  function buildPrintHtml(list) {
    var poems = loadPoems();
    var penulis = {}, t1 = 0, t2 = 0, gtk = 0;
    poems.forEach(function (p) {
      penulis[(p.nama || '').toLowerCase() + '|' + p.sekolah] = 1;
      if (p.tahap === '2') t2++; else t1++;
      if (p.jenjang === 'Guru/Tendik (GTK)') gtk++;
    });
    var tgl = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    var rows = list.map(function (p, i) {
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td><b>' + esc(p.judul) + '</b><br><span class="muted">' + esc(p.code) + '</span></td>' +
        '<td>' + esc(p.nama) + '</td>' +
        '<td>' + esc(p.jenjang) + '</td>' +
        '<td>' + esc(p.kelas) + '</td>' +
        '<td>' + esc(p.sekolah) + '</td>' +
        '<td>' + lineCount(p.isi) + '</td>' +
        '<td>' + esc(p.tahap || '1') + '</td>' +
        '<td>' + fmtDT(p.time) + '</td>' +
      '</tr>';
    }).join('');
    return '<h1>Rekap Karya Puisi Murid \u2014 KYM</h1>' +
      '<p class="psub">Tema: \u201CRukun dengan Teman\u201D</p>' +
      '<p class="pstats">Total karya: <b>' + list.length + '</b>' +
      ' \u00B7 Penulis unik: <b>' + Object.keys(penulis).length + '</b>' +
      ' \u00B7 Tahap 1: <b>' + t1 + '</b> \u00B7 Tahap 2: <b>' + t2 + '</b>' +
      ' \u00B7 GTK: <b>' + gtk + '</b> \u00B7 Siswa: <b>' + (poems.length - gtk) + '</b></p>' +
      '<table class="ptable"><thead><tr>' +
      '<th>No</th><th>Judul / Kode</th><th>Penulis</th><th>Jenjang</th><th>Kelas</th>' +
      '<th>Sekolah</th><th>Baris</th><th>Tahap</th><th>Terkirim</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="pfoot">Dicetak: ' + tgl + ' \u00B7 KYM \u2014 Rukun dengan Teman</p>';
  }

  $('btn-print').addEventListener('click', function () {
    var list = filteredPoems();
    if (!list.length) { toast('Belum ada karya untuk dicetak.'); return; }
    $('print-area').innerHTML = buildPrintHtml(list);
    window.print();
  });

  /* ---------- Cetak kartu kata sandi murid (NIS) per kelas ---------- */
  function buildKartuHtml(kelasFilter) {
    var daftar = SISWA.filter(function (s) { return !kelasFilter || s[2] === kelasFilter; });
    var KELAS_NAMA = { '3': 'III (Tiga)', '4': 'IV (Empat)', '5': 'V (Lima)', '6': 'VI (Enam)' };
    var kelasJudul = kelasFilter ? 'Kelas ' + KELAS_NAMA[kelasFilter] : 'Semua Kelas';
    var cards = daftar.map(function (s) {
      return '<div class="kart">' +
        '<div class="kh">🪪 Kartu Sandi KYM<br>SD Negeri Semambung</div>' +
        '<div class="kn">' + esc(s[1]) + '<small>Kelas ' + KELAS_NAMA[s[2]] + '</small></div>' +
        '<div class="ks">Kata Sandi (NIS): <b>' + esc(s[0]) + '</b></div>' +
        '<div class="kf">Tema “Rukun dengan Teman” · kym-website</div>' +
      '</div>'; 
    }).join('');
    return '<h1>Kartu Kata Sandi Murid — KYM</h1>' +
      '<p class="psub">' + esc(kelasJudul) + ' · ' + daftar.length + ' murid · potong sepanjang garis kartu</p>' +
      '<div class="karts">' + cards + '</div>' +
      '<p class="pfoot">Dicetak: ' + new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) + ' · Kata sandi = NIS · KYM — Rukun dengan Teman</p>';
  }
  $('btn-cetak-kartu').addEventListener('click', function () {
    var kelas = $('rm-kelas').value;
    var n = SISWA.filter(function (s) { return !kelas || s[2] === kelas; }).length;
    if (!n) { toast('Tidak ada murid pada filter ini.'); return; }
    $('print-area').innerHTML = buildKartuHtml(kelas);
    addLog('CETAK KARTU SANDI', null, 'admin');
    saveDbToFile();
    window.print();
  });
  window.addEventListener('afterprint', function () { $('print-area').innerHTML = ''; });

  // Rute awal dari hash (mendukung shortcut PWA & tautan #kirim / #admin)
  initLoginUi();
  _showPage(pageFromHash());

  /* ============================================================
     CHAT MODULE — admin ↔ murid, admin ↔ guru only
     ============================================================ */
  var chatPollTimer = null;
  var _chatLastCount = 0;
  var _chatGasPullTimer = null;
  /* --- Session helpers --- */
  function chatSession() {
    var ses = getSession();
    if (ses) return ses;
    if (adminUnlocked()) return { role: 'admin', nama: 'Admin', id: 'admin' };
    return null;
  }
  function chatUserId(ses) {
    if (!ses) return '';
    if (ses.id) return ses.id;
    var uid = ses.nis || ses.nama || 'admin';
    return uid;
  }
  function isAdmin(ses) { return ses && (ses.role === 'admin' || ses.id === 'admin'); }

  /* --- Storage --- */
  function loadChat() {
    try { return JSON.parse(localStorage.getItem(LS_CHAT)) || []; }
    catch (e) { return []; }
  }
  function saveChat(msgs) {
    try { localStorage.setItem(LS_CHAT, JSON.stringify(msgs)); } catch (e) {}
  }
  function chatId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }
  function chatTime(ts) {
    var d = new Date(ts);
    var now = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : n; };
    if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function getChatKey(uid1, uid2) {
    return [uid1, uid2].sort().join('_');
  }

  /* --- Only allow chat involving admin --- */
  function isAllowedChat(key) {
    if (!key || key.indexOf('admin') === -1) return false;
    var parts = key.split('_');
    return parts.indexOf('admin') !== -1;
  }
  function lookupNameById(uid) {
    if (uid === 'admin') return 'Admin KYM';
    var s = SISWA.filter(function (x) { return x[0] === uid; })[0];
    if (s) return s[1];
    var g = loadGuru().filter(function (x) { return x.nama === uid; })[0];
    if (g) return g.nama;
    return uid;
  }
  function lookupRoleById(uid) {
    if (uid === 'admin') return 'admin';
    if (SISWA.some(function (x) { return x[0] === uid; })) return 'murid';
    if (loadGuru().some(function (x) { return x.nama === uid; })) return 'guru';
    return 'murid';
  }

  /* ============================================================
     AUDIO & HAPTIC NOTIFICATION ENGINE
     Notifikasi perangkat untuk Murid, GTK, dan Admin
     ============================================================ */
  var _audioCtx = null;
  function getAudioContext() {
    try {
      if (!_audioCtx) {
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) _audioCtx = new AudioCtx();
      }
      if (_audioCtx && _audioCtx.state === 'suspended') {
        _audioCtx.resume().catch(function () {});
      }
      return _audioCtx;
    } catch (e) { return null; }
  }

  ['click', 'touchstart', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      if (_audioCtx && _audioCtx.state === 'suspended') {
        _audioCtx.resume().catch(function () {});
      }
    }, { once: true, passive: true });
  });

  function playChatSound(isIncoming) {
    try {
      var ctx = getAudioContext();
      if (!ctx) return;
      var now = ctx.currentTime;
      if (isIncoming) {
        // Melodi notifikasi lembut 2 nada (A5 880Hz -> E6 1318.5Hz)
        var osc1 = ctx.createOscillator();
        var gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(880, now);
        gain1.gain.setValueAtTime(0.22, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.3);

        var osc2 = ctx.createOscillator();
        var gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1318.5, now + 0.09);
        gain2.gain.setValueAtTime(0, now);
        gain2.gain.setValueAtTime(0.28, now + 0.09);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now + 0.09);
        osc2.stop(now + 0.5);
      } else {
        // Suara kirim pesan (pop halus 520Hz)
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(740, now + 0.08);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.12);
      }
    } catch (e) {}
  }

  function vibrateDevice(pattern) {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(pattern || [150, 80, 150]);
      }
    } catch (e) {}
  }

  function updateAppBadge(count) {
    try {
      if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
        if (count > 0) navigator.setAppBadge(count).catch(function () {});
        else navigator.clearAppBadge().catch(function () {});
      }
    } catch (e) {}
  }

  var _origDocTitle = document.title || 'KYM — Kumpulan Karya Murid';
  var _docTitleFlashTimer = null;
  function flashDocumentTitle(snippet) {
    if (!document.hidden) return;
    clearInterval(_docTitleFlashTimer);
    var flip = false;
    _docTitleFlashTimer = setInterval(function () {
      if (!document.hidden) {
        resetDocumentTitle();
        return;
      }
      var unread = getUnreadTotal();
      var countStr = unread > 0 ? '(' + unread + ') ' : '';
      document.title = (flip ? '💬 ' + countStr + 'Pesan Baru!' : '🔔 ' + countStr + 'KYM Chat') + (snippet ? ' — ' + snippet : '');
      flip = !flip;
    }, 1400);
  }
  function resetDocumentTitle() {
    if (_docTitleFlashTimer) {
      clearInterval(_docTitleFlashTimer);
      _docTitleFlashTimer = null;
    }
    document.title = _origDocTitle;
  }

  /* --- Notified messages tracker (mencegah duplikasi notifikasi) --- */
  function loadNotifiedMsgIds() {
    try { return JSON.parse(localStorage.getItem(LS_CHAT_NOTIFIED)) || {}; }
    catch (e) { return {}; }
  }
  function markMsgNotified(id) {
    if (!id) return;
    try {
      var map = loadNotifiedMsgIds();
      map[id] = Date.now();
      var keys = Object.keys(map);
      if (keys.length > 350) {
        var keep = {};
        keys.slice(keys.length - 250).forEach(function (k) { keep[k] = map[k]; });
        map = keep;
      }
      localStorage.setItem(LS_CHAT_NOTIFIED, JSON.stringify(map));
    } catch (e) {}
  }

  var _initialMsgsSeeded = false;
  function seedInitialNotifiedMsgs() {
    if (_initialMsgsSeeded) return;
    _initialMsgsSeeded = true;
    var existing = loadChat();
    if (!existing.length) return;
    var map = loadNotifiedMsgIds();
    var changed = false;
    existing.forEach(function (m) {
      if (!map[m.id]) { map[m.id] = m.ts || Date.now(); changed = true; }
    });
    if (changed) {
      try { localStorage.setItem(LS_CHAT_NOTIFIED, JSON.stringify(map)); } catch (e) {}
    }
  }

  /* --- Cek apakah pesan ditujukan untuk sesi yang aktif di perangkat ini --- */
  function isMessageForCurrentSession(msg) {
    if (!msg || msg.deleted || msg.read) return false;
    var ses = chatSession();
    if (!ses) return false;
    var uid = chatUserId(ses);
    if (!uid || msg.senderId === uid) return false;

    if (isAdmin(ses)) {
      // Perangkat Admin: menerima pesan dari siapa pun (murid atau GTK)
      return msg.chatKey && msg.chatKey.indexOf('admin') !== -1;
    } else {
      // Perangkat Murid atau GTK: menerima pesan dari admin yang ditujukan ke murid/guru ini
      var parts = (msg.chatKey || '').split('_');
      return parts.indexOf(uid) !== -1;
    }
  }

  /* --- Buka room chat berdasarkan chatKey (untuk klik notifikasi & deep link) --- */
  function openChatByKey(chatKey) {
    if (!chatKey || !isAllowedChat(chatKey)) return;
    var ses = chatSession();
    if (!ses) {
      showPage('kirim');
      toast('Silakan login terlebih dahulu untuk membuka pesan chat.');
      return;
    }
    var uid = chatUserId(ses);
    var parts = chatKey.split('_');
    var otherId = (parts[0] === uid) ? parts[1] : parts[0];
    var otherName = lookupNameById(otherId);
    var otherRole = lookupRoleById(otherId);
    showPage('chat');
    openChatRoom(chatKey, otherId, otherName, otherRole);
  }

  /* --- In-App Floating Toast Notification --- */
  var _inAppToastTimer = null;
  function showInAppToast(msg) {
    var toastEl = $('chat-inapp-toast');
    if (!toastEl) return;
    var avatarEl = $('chat-inapp-avatar');
    var senderEl = $('chat-inapp-sender');
    var bodyEl = $('chat-inapp-body');
    var roleCls = msg.senderRole === 'guru' ? 'guru' : msg.senderRole === 'admin' ? 'admin' : 'murid';
    var roleIco = msg.senderRole === 'guru' ? '👨‍🏫' : msg.senderRole === 'admin' ? '🛡️' : '👩‍🎓';

    if (avatarEl) {
      avatarEl.className = 'chat-inapp-avatar ' + roleCls;
      avatarEl.textContent = roleIco;
    }
    if (senderEl) {
      var roleName = msg.senderRole === 'guru' ? 'Guru/Tendik' : msg.senderRole === 'admin' ? 'Admin KYM' : 'Murid';
      senderEl.textContent = msg.senderName + ' (' + roleName + ')';
    }
    if (bodyEl) {
      bodyEl.textContent = chatPreviewText(msg, 120);
    }

    toastEl.setAttribute('data-chat', msg.chatKey);
    toastEl.classList.add('show');
    clearTimeout(_inAppToastTimer);
    _inAppToastTimer = setTimeout(function () {
      hideInAppToast();
    }, 6500);
  }
  function hideInAppToast() {
    var toastEl = $('chat-inapp-toast');
    if (toastEl) toastEl.classList.remove('show');
    clearTimeout(_inAppToastTimer);
  }

  /* --- Eksekusi Tampilkan Notifikasi Sistem / PWA --- */
  function showChatNotification(msg) {
    if (!msg || !msg.id) return;
    var isLookingAtCurrentRoom = (!document.hidden &&
      $('page-chat') && $('page-chat').classList.contains('active') &&
      $('chat-room-view') && $('chat-room-view').style.display !== 'none' &&
      $('chat-messages') && $('chat-messages').getAttribute('data-chat') === msg.chatKey);

    if (isLookingAtCurrentRoom) {
      playChatSound(false);
      return;
    }

    playChatSound(true);
    vibrateDevice([150, 80, 150]);
    updateAppBadge(getUnreadTotal());

    var preview = chatPreviewText(msg, 90);
    flashDocumentTitle((msg.senderName || 'Pesan') + ': ' + preview);
    showInAppToast(msg);

    var roleLabel = msg.senderRole === 'guru' ? ' (Guru/GTK)' : msg.senderRole === 'admin' ? '' : ' (Murid)';
    var title = '💬 Pesan Baru: ' + (msg.senderName || 'KYM') + roleLabel;
    var notifOptions = {
      body: preview,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'kym-chat-' + msg.chatKey,
      renotify: true,
      vibrate: [150, 80, 150],
      data: {
        chatKey: msg.chatKey,
        msgId: msg.id,
        senderId: msg.senderId
      }
    };

    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(function (reg) {
        return reg.showNotification(title, notifOptions);
      }).catch(function () {
        fallbackDesktopNotification(title, notifOptions, msg.chatKey);
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      fallbackDesktopNotification(title, notifOptions, msg.chatKey);
    }
  }

  function fallbackDesktopNotification(title, options, chatKey) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      var n = new Notification(title, {
        body: options.body,
        icon: options.icon,
        badge: options.badge,
        tag: options.tag
      });
      n.onclick = function () {
        window.focus();
        openChatByKey(chatKey);
        n.close();
      };
    } catch (e) {}
  }

  /* --- Handler saat ada pesan baru dari remote GAS atau storage --- */
  function handleIncomingChatNotifications(newMsgs) {
    if (!Array.isArray(newMsgs) || !newMsgs.length) return;
    var notifiedMap = loadNotifiedMsgIds();
    var ses = chatSession();
    if (!ses) return;

    newMsgs.forEach(function (m) {
      if (notifiedMap[m.id]) return;
      if (!isMessageForCurrentSession(m)) return;
      if (m.ts && (Date.now() - m.ts) > 12 * 3600 * 1000) {
        markMsgNotified(m.id);
        return;
      }
      markMsgNotified(m.id);
      showChatNotification(m);
    });
  }

  /* --- Izin & UI Notifikasi --- */
  function getNotificationPermission() {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return Notification.permission;
  }

  function requestChatNotificationPermission() {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      toast('Perangkat/browser ini tidak mendukung Web Notification API.');
      return Promise.resolve('unsupported');
    }
    getAudioContext();
    return Notification.requestPermission().then(function (perm) {
      updateNotificationBannerUi();
      if (perm === 'granted') {
        toast('🔔 Izin notifikasi aktif! Mengirim notifikasi tes…');
        testChatNotification();
      } else if (perm === 'denied') {
        toast('⚠️ Notifikasi diblokir di browser. Izinkan via setelan situs browser Anda.');
      }
      return perm;
    });
  }

  function updateNotificationBannerUi() {
    var banner = $('chat-notif-banner');
    var titleEl = $('chat-notif-title');
    var descEl = $('chat-notif-desc');
    var btnAction = $('btn-chat-notif-action');
    var btnTest = $('btn-chat-notif-test');
    var roomBtn = $('btn-room-notif-status');
    var ses = chatSession();

    if (!banner) return;
    var perm = getNotificationPermission();

    if (perm === 'unsupported' || !ses) {
      banner.style.display = 'none';
      if (roomBtn) roomBtn.style.display = 'none';
      return;
    }

    banner.style.display = 'flex';
    banner.classList.remove('active', 'denied');

    var targetHint = isAdmin(ses) ? 'murid atau guru' : 'Admin';

    if (perm === 'granted') {
      banner.classList.add('active');
      if (titleEl) titleEl.textContent = '🔔 Notifikasi Chat Aktif';
      if (descEl) descEl.textContent = 'Perangkat Anda siap menerima pemberitahuan pesan baru dari ' + targetHint + '.';
      if (btnAction) { btnAction.style.display = 'none'; }
      if (btnTest) { btnTest.style.display = ''; }
      if (roomBtn) { roomBtn.textContent = '🔔'; roomBtn.title = 'Notifikasi Aktif (Klik untuk uji coba)'; }
    } else if (perm === 'denied') {
      banner.classList.add('denied');
      if (titleEl) titleEl.textContent = '⚠️ Izin Notifikasi Diblokir';
      if (descEl) descEl.textContent = 'Browser memblokir notifikasi. Ketuk setelan situs di browser untuk mengizinkan.';
      if (btnAction) { btnAction.style.display = 'none'; }
      if (btnTest) { btnTest.style.display = 'none'; }
      if (roomBtn) { roomBtn.textContent = '🔕'; roomBtn.title = 'Notifikasi Diblokir di Browser'; }
    } else {
      if (titleEl) titleEl.textContent = '🔔 Aktifkan Notifikasi Pesan di Perangkat Ini';
      if (descEl) descEl.textContent = 'Dapatkan pemberitahuan di HP / Komputer Anda saat ada balasan atau pesan baru dari ' + targetHint + '.';
      if (btnAction) { btnAction.style.display = ''; btnAction.textContent = 'Aktifkan'; }
      if (btnTest) { btnTest.style.display = 'none'; }
      if (roomBtn) { roomBtn.textContent = '🔔'; roomBtn.title = 'Klik untuk mengaktifkan notifikasi'; }
    }
  }

  function testChatNotification() {
    var ses = chatSession();
    var perm = getNotificationPermission();
    if (perm !== 'granted') {
      requestChatNotificationPermission();
      return;
    }
    var fakeMsg = null;
    var now = Date.now();
    if (!ses || isAdmin(ses)) {
      fakeMsg = {
        id: 'test_' + now,
        chatKey: '1001_admin',
        senderId: '1001',
        senderName: 'Ahmad Dahlan',
        senderRole: 'murid',
        text: 'Halo Admin KYM! Ini pesan uji coba notifikasi dari murid. 🌟',
        ts: now,
        read: false,
        edited: false,
        deleted: false
      };
    } else if (ses.role === 'guru') {
      fakeMsg = {
        id: 'test_' + now,
        chatKey: getChatKey(chatUserId(ses), 'admin'),
        senderId: 'admin',
        senderName: 'Admin KYM',
        senderRole: 'admin',
        text: 'Halo ' + (ses.nama || 'Bapak/Ibu Guru') + '! Ini adalah pesan uji coba notifikasi chat GTK. 😊',
        ts: now,
        read: false,
        edited: false,
        deleted: false
      };
    } else {
      fakeMsg = {
        id: 'test_' + now,
        chatKey: getChatKey(chatUserId(ses), 'admin'),
        senderId: 'admin',
        senderName: 'Admin KYM',
        senderRole: 'admin',
        text: 'Halo ' + (ses.nama || 'Murid') + '! Puisi karyamu sudah kami terima. Semangat terus berkarya! 👏',
        ts: now,
        read: false,
        edited: false,
        deleted: false
      };
    }
    showChatNotification(fakeMsg);
    toast('🔔 Notifikasi uji coba telah dikirim ke perangkat Anda.');
  }

  /* --- Conversation list --- */
  function getConversations() {
    var ses = chatSession();
    var uid = chatUserId(ses);
    if (!uid) return [];
    var msgs = loadChat();
    var convos = {};
    msgs.forEach(function (m) {
      if (m.deleted && !m.read) { /* keep deleted for unread? skip */ }
      if (m.deleted) {
        // still need key for unread? skip deleted messages for convo building
        // but keep lastMsg as previous non-deleted
        var kDel = m.chatKey;
        if (!convos[kDel]) convos[kDel] = { key: kDel, users: {}, lastMsg: null, unread: {} };
        // ensure participants from chatKey are present even if deleted
        kDel.split('_').forEach(function (pid) {
          if (!convos[kDel].users[pid]) convos[kDel].users[pid] = { id: pid, name: lookupNameById(pid), role: lookupRoleById(pid) };
        });
        return;
      }
      if (!isAllowedChat(m.chatKey)) return;
      var key = m.chatKey;
      if (!convos[key]) convos[key] = { key: key, users: {}, lastMsg: null, unread: {} };
      convos[key].users[m.senderId] = { id: m.senderId, name: m.senderName, role: m.senderRole };
      // ensure both participants from chatKey are in users map
      key.split('_').forEach(function (pid) {
        if (!convos[key].users[pid]) convos[key].users[pid] = { id: pid, name: lookupNameById(pid), role: lookupRoleById(pid) };
      });
      if (!convos[key].lastMsg || m.ts > convos[key].lastMsg.ts) convos[key].lastMsg = m;
      if (m.senderId !== uid && !m.read) {
        convos[key].unread[uid] = (convos[key].unread[uid] || 0) + 1;
      }
    });
    // also ensure lastMsg is correctly set (for keys that only had deleted msgs, find last non-deleted)
    Object.keys(convos).forEach(function (k) {
      if (!convos[k].lastMsg) {
        var last = msgs.filter(function (m) { return m.chatKey === k && !m.deleted; }).sort(function (a,b){return b.ts-a.ts;})[0];
        if (last) convos[k].lastMsg = last;
      }
    });
    var arr = Object.values(convos).filter(function (c) { return !!c.lastMsg; });
    arr.sort(function (a, b) { return (b.lastMsg ? b.lastMsg.ts : 0) - (a.lastMsg ? a.lastMsg.ts : 0); });
    return arr;
  }
  function getUnreadTotal() {
    var ses = chatSession();
    if (!ses) return 0;
    var uid = chatUserId(ses);
    var total = 0;
    getConversations().forEach(function (c) {
      if (c.unread[uid]) total += c.unread[uid];
    });
    return total;
  }
  function updateChatBadge() {
    var badge = $('chat-badge');
    var n = getUnreadTotal();
    if (badge) {
      if (n > 0) { badge.textContent = n > 99 ? '99+' : n; badge.style.display = ''; }
      else { badge.style.display = 'none'; }
    }
    updateAppBadge(n);
  }

  /* --- Render conversation list --- */
  function renderChatList() {
    var ses = chatSession();
    var uid = chatUserId(ses);
    var list = $('chat-list');
    if (!list) return;
    if (!ses) {
      list.innerHTML = '<div class="chat-empty"><div class="chat-empty-icon">💬</div><p>Login untuk menggunakan chat.</p></div>';
      return;
    }
    var convos = getConversations();
    if (!convos.length) {
      var hint = isAdmin(ses) ? 'Pilih kontak untuk mulai chat.' : 'Belum ada pesan. Chat dengan admin akan muncul di sini.';
      list.innerHTML = '<div class="chat-empty"><div class="chat-empty-icon">💬</div><p>' + hint + '</p></div>';
      return;
    }
    var html = '';
    convos.forEach(function (c) {
      var other = null;
      Object.values(c.users).forEach(function (u) {
        if (u.id !== uid) other = u;
      });
      if (!other) return;
      var avatarCls = other.role === 'guru' ? 'guru' : other.role === 'admin' ? 'admin' : 'murid';
      var avatarIcon = other.role === 'guru' ? '👨‍🏫' : other.role === 'admin' ? '🛡️' : '👩‍🎓';
      var preview = c.lastMsg ? chatPreviewText(c.lastMsg, 40) : '';
      var time = c.lastMsg ? chatTime(c.lastMsg.ts) : '';
      var unread = c.unread[uid] || 0;
      html += '<div class="chat-list-item" data-chat="' + c.key + '" data-user="' + other.id + '" data-name="' + esc(other.name) + '" data-role="' + other.role + '">'
        + '<div class="chat-list-avatar ' + avatarCls + '">' + avatarIcon + '</div>'
        + '<div class="chat-list-info">'
        + '<div class="chat-list-name">' + esc(other.name) + '</div>'
        + '<div class="chat-list-preview">' + esc(preview) + '</div>'
        + '</div>'
        + '<div class="chat-list-meta">'
        + '<div class="chat-list-time">' + time + '</div>'
        + (unread ? '<div class="chat-list-unread">' + unread + '</div>' : '')
        + '</div></div>';
    });
    list.innerHTML = html;
    list.querySelectorAll('.chat-list-item').forEach(function (el) {
      el.addEventListener('click', function () {
        openChatRoom(el.getAttribute('data-chat'), el.getAttribute('data-user'), el.getAttribute('data-name'), el.getAttribute('data-role'));
      });
    });
  }

  /* --- Open chat room --- */
  function openChatRoom(chatKey, otherId, otherName, otherRole) {
    if (!isAllowedChat(chatKey)) { toast('Chat hanya tersedia dengan admin.'); return; }
    $('chat-list-view').style.display = 'none';
    $('chat-contacts-view').style.display = 'none';
    $('chat-room-view').style.display = '';
    $('chat-room-name').textContent = otherName;
    var roleLabel = otherRole === 'guru' ? 'Guru/Tendik (GTK)' : otherRole === 'admin' ? 'Admin' : 'Murid';
    $('chat-room-role').textContent = roleLabel;
    var container = $('chat-messages');
    container.setAttribute('data-chat', chatKey);
    container.setAttribute('data-other', otherId);
    renderChatMessages(chatKey);
    $('chat-input').focus();
  }

  /* --- Render messages in room (anti kedip) --- */
  function renderChatMessages(chatKey) {
    var ses = chatSession();
    var uid = chatUserId(ses);
    var container = $('chat-messages');
    if (!container) return;
    var allMsgs = loadChat();
    var msgs = allMsgs.filter(function (m) { return m.chatKey === chatKey && !m.deleted; });
    msgs.sort(function (a, b) { return a.ts - b.ts; });
    if (!msgs.length) {
      // hanya update jika belum ada placeholder
      if (container.innerHTML.indexOf('Mulai percakapan') === -1) {
        container.innerHTML = '<div class="chat-msg system">Mulai percakapan. Ketik pesan di bawah.</div>';
      }
      return;
    }
    // cek apakah scroll sedang di bawah (dekat bottom) sebelum render
    var wasAtBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 80;
    var prevSig = container.getAttribute('data-sig') || '';
    var newSig = msgs.map(function(m){return m.id + (m.edited?'E':'') + (m.deleted?'D':'') + (m.text || '').length + (m.file ? 'F' + m.file.name + '|' + m.file.size : '');}).join('|');
    if (prevSig === newSig && container.getAttribute('data-chat') === chatKey) {
      // tidak ada perubahan visual, jangan re-render agar tidak kedip
      markChatRead(chatKey);
      return;
    }
    var html = '';
    var lastDate = '';
    var now = Date.now();
    msgs.forEach(function (m) {
      var d = new Date(m.ts);
      var dateStr = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
      if (dateStr !== lastDate) {
        html += '<div class="chat-msg system">' + dateStr + '</div>';
        lastDate = dateStr;
      }
      var isMe = uid && m.senderId === uid;
      var cls = isMe ? 'me' : 'other';
      var actions = isMe
        ? '<div class="chat-actions"><button class="chat-act-btn" data-action="edit" data-id="' + m.id + '" title="Edit">✏️</button><button class="chat-act-btn" data-action="hapus" data-id="' + m.id + '" title="Hapus">🗑️</button></div>'
        : '';
      var edited = m.edited ? ' <span style="opacity:.6;font-size:.7rem;">(diedit)</span>' : '';
      // hanya pesan baru (<2.5 detik) dapat animasi 'new' agar tidak kedip massal
      var isNew = (now - m.ts) < 2500;
      // placeholder lampiran (diisi async setelah render)
      var fileSlot = m.file ? '<div class="chat-file-slot" data-msgid="' + m.id + '">⏳ Memuat lampiran…</div>' : '';
      html += '<div class="chat-msg ' + cls + (isNew ? ' new' : '') + '" data-msgid="' + m.id + '">'
        + (isMe ? '' : '<div class="chat-sender">' + esc(m.senderName) + '</div>')
        + fileSlot
        + (m.text ? '<div class="chat-text">' + esc(m.text) + edited + '</div>' : (m.file ? (edited ? '<div class="chat-text">' + edited + '</div>' : '') : '<div class="chat-text">' + edited + '</div>'))
        + actions
        + '<div class="chat-time">' + chatTime(m.ts) + '</div>'
        + '</div>';
    });
    container.innerHTML = html;
    container.setAttribute('data-sig', newSig);
    // auto-scroll hanya jika sebelumnya di bawah atau ada pesan baru dari self
    var lastIsMe = msgs.length && msgs[msgs.length-1].senderId === uid;
    if (wasAtBottom || lastIsMe) {
      container.scrollTop = container.scrollHeight;
    }
    markChatRead(chatKey);
    bindChatActions();
    // Isi slot lampiran secara async
    msgs.forEach(function (m) {
      if (!m.file) return;
      var slot = container.querySelector('.chat-file-slot[data-msgid="' + m.id + '"]');
      if (!slot) return;
      chatFileLoad(m.id).then(function (dataUrl) {
        if (!slot.parentNode) return; // sudah di-replace
        if (dataUrl) {
          if ((m.file.type || '').indexOf('image/') === 0) {
            var imgEl = document.createElement('img');
            imgEl.src = dataUrl;
            imgEl.className = 'chat-msg-image';
            imgEl.alt = m.file.name;
            imgEl.title = m.file.name;
            imgEl.addEventListener('click', function () {
              var win = window.open('', '_blank');
              if (!win) return;
              win.document.title = m.file.name;
              var big = win.document.createElement('img');
              big.src = dataUrl;
              big.style.maxWidth = '100%';
              big.style.cursor = 'zoom-out';
              big.onclick = function () { win.close(); };
              win.document.body.appendChild(big);
            });
            slot.replaceWith(imgEl);
          } else {
            var a = document.createElement('a');
            a.href = dataUrl;
            a.download = m.file.name;
            a.className = 'chat-msg-file';
            a.innerHTML = '<span class="chat-msg-file-icon">' + fileIcon(m.file.type, m.file.name) + '</span>'
              + '<span class="chat-msg-file-info"><span class="chat-msg-file-name">' + esc(m.file.name) + '</span><span class="chat-msg-file-size">' + fmtFileSize(m.file.size) + ' · Ketuk untuk unduh</span></span>';
            slot.replaceWith(a);
          }
        } else {
          // File belum ada di IndexedDB perangkat ini — coba unduh, ketuk untuk retry
          var noFile = document.createElement('div');
          noFile.className = 'chat-msg-file';
          noFile.style.opacity = '.6';
          var tooBig = (m.file.size || 0) > CHAT_FILE_ONLINE_MAX;
          var fid = m.file.msgId || m.id;
          noFile.innerHTML = '<span class="chat-msg-file-icon">' + fileIcon(m.file.type, m.file.name) + '</span>'
            + '<span class="chat-msg-file-info"><span class="chat-msg-file-name">' + esc(m.file.name) + '</span><span class="chat-msg-file-size">' + fmtFileSize(m.file.size)
            + (tooBig ? ' · Hanya tersedia di perangkat pengirim' : ' · Belum diterima · ketuk untuk unduh') + '</span></span>';
          if (!tooBig) {
            noFile.style.cursor = 'pointer';
            noFile.title = 'Ketuk untuk mengunduh file';
            noFile.addEventListener('click', function () {
              retryDownloadChatFile(fid);
            });
          }
          slot.replaceWith(noFile);
        }
      }).catch(function () {
        if (slot.parentNode) slot.textContent = '⚠️ Gagal memuat lampiran.';
      });
    });
  }

  /* --- Bind edit/hapus buttons --- */
  function bindChatActions() {
    var container = $('chat-messages');
    if (!container) return;
    container.querySelectorAll('.chat-act-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var action = btn.getAttribute('data-action');
        var msgId = btn.getAttribute('data-id');
        if (action === 'edit') editChatMessage(msgId);
        else if (action === 'hapus') deleteChatMessage(msgId);
      });
    });
  }

  /* --- Edit message --- */
  function editChatMessage(msgId) {
    var msgs = loadChat();
    var msg = msgs.find(function (m) { return m.id === msgId; });
    if (!msg) return;
    var ses = chatSession();
    if (msg.senderId !== chatUserId(ses)) { toast('Hanya pengirim yang bisa edit pesan.'); return; }
    var newText = prompt('Edit pesan:', msg.text || '');
    if (newText === null || !newText.trim()) return;
    if (newText.trim() === (msg.text || '')) return;
    msg.text = newText.trim();
    msg.edited = true;
    saveChat(msgs);
    syncChatMessage('update', msg);
    renderChatMessages(msg.chatKey);
    toast('Pesan diedit.');
  }

  /* --- Delete message --- */
  function deleteChatMessage(msgId) {
    if (!confirm('Hapus pesan ini?')) return;
    var msgs = loadChat();
    var msg = msgs.find(function (m) { return m.id === msgId; });
    if (!msg) return;
    var ses = chatSession();
    if (msg.senderId !== chatUserId(ses)) { toast('Hanya pengirim yang bisa hapus pesan.'); return; }
    // Hapus file lampiran dari IndexedDB jika ada
    if (msg.file && msg.file.msgId) {
      chatFileDel(msg.file.msgId);
      // hapus chunk online + batalkan antrean upload
      shiftChatFilePending(msg.file.msgId);
      if (gasActive() && online()) {
        gasApi({ action: 'file_del', fileId: msg.file.msgId }).catch(function () {});
      }
    }
    msg.deleted = true;
    saveChat(msgs);
    syncChatMessage('delete', msg);
    renderChatMessages(msg.chatKey);
    toast('Pesan dihapus.');
  }

  /* --- Mark read --- */
  function markChatRead(chatKey) {
    var ses = chatSession();
    var uid = chatUserId(ses);
    if (!uid) return;
    var msgs = loadChat();
    var changed = false;
    var changedMsgs = [];
    msgs.forEach(function (m) {
      if (m.chatKey === chatKey && m.senderId !== uid && !m.read) {
        m.read = true;
        changed = true;
        changedMsgs.push(m);
      }
    });
    if (changed) {
      saveChat(msgs);
      changedMsgs.forEach(function (m) { syncChatMessage('update', m); });
    }
    updateChatBadge();
  }

  /* --- Send message --- */
  function sendChatMessage(text) {
    var ses = chatSession();
    var uid = chatUserId(ses);
    var hasFile = !!_pendingFile;
    if (!uid || (!text.trim() && !hasFile)) { toast('Pesan atau file tidak boleh kosong.'); return; }
    var container = $('chat-messages');
    var chatKey = container ? container.getAttribute('data-chat') : '';
    // fallback: jika room belum punya chatKey, buat otomatis (murid/GTK -> admin)
    if (!chatKey) {
      if (!isAdmin(ses)) {
        chatKey = getChatKey(uid, 'admin');
        var c2 = $('chat-messages');
        if (c2) c2.setAttribute('data-chat', chatKey);
      } else {
        toast('Pilih kontak terlebih dahulu.');
        return;
      }
    }
    if (!isAllowedChat(chatKey)) { toast('Chat hanya tersedia dengan admin.'); return; }
    var msg = {
      id: chatId(),
      chatKey: chatKey,
      senderId: uid,
      senderName: ses.nama || 'Admin',
      senderRole: ses.role || 'admin',
      text: text.trim(),
      ts: Date.now(),
      read: false,
      edited: false,
      deleted: false
    };
    // Sisipkan metadata file jika ada lampiran (gambar / PDF / dokumen)
    if (hasFile) {
      if (_pendingFile.compressing) { toast('⏳ Gambar masih dioptimasi, tunggu sebentar…'); return; }
      var _pf = { name: _pendingFile.name, type: _pendingFile.type, size: _pendingFile.size, dataUrl: _pendingFile.dataUrl };
      msg.file = { name: _pf.name, type: _pf.type, size: _pf.size, msgId: msg.id };
      clearPendingFile();
      // PENTING: tunggu biner tersimpan di IndexedDB dulu, baru antrekan upload.
      // ( IDB async — baca sebelum tulis commit membuat upload batal permanen. )
      chatFileSave(msg.id, _pf.dataUrl).then(function () {
        // File ≤1 MB ikut terkirim online realtime via chunk; selebihnya lokal saja
        if (_pf.size <= CHAT_FILE_ONLINE_MAX) {
          enqueueChatFileUpload(msg.id);
        } else {
          toast('📎 File >1 MB tersimpan di perangkat ini — teks tetap tersinkron.');
        }
      }).catch(function () {
        toast('❌ Gagal menyimpan file di perangkat.');
      });
    }
    var msgs = loadChat();
    msgs.push(msg);
    saveChat(msgs);
    markMsgNotified(msg.id);
    syncChatMessage('create', msg);
    _chatLastCount = msgs.length;
    playChatSound(false);
    renderChatMessages(chatKey);
    renderChatListIfVisible();
    updateChatBadge();
  }

  /* --- Helpers for GAS sync --- */
  function renderChatListIfVisible() {
    var v = $('chat-list-view');
    if (v && v.style.display !== 'none') renderChatList();
  }
  function refreshChatRoomIfOpen() {
    var rv = $('chat-room-view');
    if (!rv || rv.style.display === 'none') return;
    var c = $('chat-messages');
    var k = c ? c.getAttribute('data-chat') : '';
    if (k) renderChatMessages(k);
  }

  /* --- Init chat page --- */
  function initChat() {
    var ses = chatSession();
    var chatView = $('chat-list-view');
    var contactsView = $('chat-contacts-view');
    var roomView = $('chat-room-view');
    if (!chatView || !roomView) return;
    seedInitialNotifiedMsgs();
    updateNotificationBannerUi();
    if (ses) {
      chatView.style.display = '';
      if (contactsView) contactsView.style.display = 'none';
      roomView.style.display = 'none';
      // auto-create welcome chat for murid/GTK
      ensureAdminChat();
      renderChatList();
      updateChatTabs(ses);
      if (isAdmin(ses)) {
        renderChatContacts();
      } else {
        // murid/GTK: jika hanya 1 percakapan (dengan admin), auto-buka room
        var convs = getConversations();
        if (convs.length === 1) {
          var c = convs[0];
          var other = null;
          Object.values(c.users).forEach(function (u) { if (u.id !== chatUserId(ses)) other = u; });
          if (other) {
            // jangan auto-buka jika kontak tab aktif
            var tabC = $('chat-tab-contacts');
            if (!tabC || !tabC.classList.contains('active')) {
              // tunda sedikit agar render list selesai
              setTimeout(function () { openChatRoom(c.key, other.id, other.name, other.role); }, 50);
            }
          }
        }
      }
      // pull dari GAS jika online
      if (gasActive() && online()) {
        gasChatPull();
        flushChatOutbox();
      }
    } else {
      chatView.innerHTML = '<div class="chat-empty"><div class="chat-empty-icon">💬</div><p>Login untuk menggunakan chat.</p></div>';
      if (contactsView) contactsView.style.display = 'none';
      roomView.style.display = 'none';
    }
    _chatLastCount = loadChat().length;
    updateChatBadge();
  }

  /* --- Show/hide contacts tab for admin --- */
  function updateChatTabs(ses) {
    var contactsBtn = $('chat-tab-contacts');
    if (contactsBtn) contactsBtn.style.display = isAdmin(ses) ? '' : 'none';
  }

  /* --- Render contacts (admin only: SISWA + Guru) --- */
  function renderChatContacts(filter) {
    var list = $('chat-contacts-list');
    if (!list) return;
    var ses = chatSession();
    var uid = chatUserId(ses);
    if (!uid) return;
    var keyword = (filter || '').toLowerCase();
    var kelasNama = { '3': 'Kelas III', '4': 'Kelas IV', '5': 'Kelas V', '6': 'Kelas VI' };
    var allMsgs = loadChat();
    var html = '';

    /* Murid contacts — single pass */
    SISWA.forEach(function (s) {
      var nis = s[0], nama = s[1], kelas = s[2];
      if (keyword && nama.toLowerCase().indexOf(keyword) === -1 && nis.indexOf(keyword) === -1) return;
      var chatKey = getChatKey(uid, nis);
      var msgs = allMsgs.filter(function (m) { return m.chatKey === chatKey && !m.deleted; });
      var lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
      var unread = 0;
      for (var i = 0; i < msgs.length; i++) if (msgs[i].senderId !== uid && !msgs[i].read) unread++;
      var preview = lastMsg ? chatPreviewText(lastMsg, 35) : '';
      html += '<div class="chat-contact" data-nis="' + nis + '" data-nama="' + esc(nama) + '" data-role="murid">'
        + '<div class="chat-contact-avatar">👩‍🎓</div>'
        + '<div class="chat-contact-info">'
        + '<div class="chat-contact-name">' + esc(nama) + '</div>'
        + '<div class="chat-contact-meta">' + (kelasNama[kelas] || 'Kelas ' + kelas) + ' · NIS ' + nis + (preview ? ' · ' + esc(preview) : '') + '</div>'
        + '</div>'
        + (unread ? '<div class="chat-contact-unread">' + unread + '</div>' : '<div class="chat-contact-badge">' + (lastMsg ? '💬' : '✉️') + '</div>')
        + '</div>';
    });

    /* Guru contacts */
    var guruList = loadGuru();
    guruList.forEach(function (g) {
      var nama = g.nama;
      if (keyword && nama.toLowerCase().indexOf(keyword) === -1) return;
      var chatKey = getChatKey(uid, nama);
      var msgs = allMsgs.filter(function (m) { return m.chatKey === chatKey && !m.deleted; });
      var lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
      var unread = 0;
      for (var i = 0; i < msgs.length; i++) if (msgs[i].senderId !== uid && !msgs[i].read) unread++;
      var preview = lastMsg ? chatPreviewText(lastMsg, 35) : '';
      html += '<div class="chat-contact" data-nis="' + esc(nama) + '" data-nama="' + esc(nama) + '" data-role="guru">'
        + '<div class="chat-contact-avatar" style="background:#d1fae5;color:#065f46;">👨‍🏫</div>'
        + '<div class="chat-contact-info">'
        + '<div class="chat-contact-name">' + esc(nama) + '</div>'
        + '<div class="chat-contact-meta">Guru/Tendik (GTK)' + (preview ? ' · ' + esc(preview) : '') + '</div>'
        + '</div>'
        + (unread ? '<div class="chat-contact-unread">' + unread + '</div>' : '<div class="chat-contact-badge">' + (lastMsg ? '💬' : '✉️') + '</div>')
        + '</div>';
    });

    if (!html) {
      list.innerHTML = '<div class="chat-empty"><p>Tidak ditemukan.</p></div>';
      return;
    }
    list.innerHTML = html;
    list.querySelectorAll('.chat-contact').forEach(function (el) {
      el.addEventListener('click', function () {
        var nis = el.getAttribute('data-nis');
        var nama = el.getAttribute('data-nama');
        var role = el.getAttribute('data-role');
        var chatKey = getChatKey(uid, nis);
        openChatRoom(chatKey, nis, nama, role);
      });
    });
  }

  /* --- Auto-create chat room for murid/GTK with admin --- */
  function ensureAdminChat() {
    var ses = chatSession();
    if (!ses || isAdmin(ses)) return;
    var uid = chatUserId(ses);
    var chatKey = getChatKey(uid, 'admin');
    var msgs = loadChat();
    var exists = msgs.some(function (m) { return m.chatKey === chatKey && !m.deleted; });
    if (!exists) {
      var welcome = {
        id: chatId(), chatKey: chatKey,
        senderId: 'admin', senderName: 'Admin KYM', senderRole: 'admin',
        text: 'Halo ' + ses.nama + '! Ada yang bisa kami bantu? 😊',
        ts: Date.now(), read: false, edited: false, deleted: false
      };
      msgs.push(welcome);
      saveChat(msgs);
      syncChatMessage('create', welcome);
    }
  }

  /* --- Bind events --- */
  (function () {
    var chatForm = $('chat-form');
    var chatInput = $('chat-input');
    var chatBack = $('chat-back');
    var tabConv = $('chat-tab-conv');
    var tabContacts = $('chat-tab-contacts');
    var contactSearch = $('chat-contact-search');
    var btnAttach = $('btn-chat-attach');
    var fileInput = $('chat-file-input');
    var btnFileClear = $('btn-chat-file-clear');

    if (chatForm) {
      chatForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var hasText = chatInput && chatInput.value.trim();
        var hasPending = !!_pendingFile;
        if (hasText || hasPending) {
          sendChatMessage(chatInput ? chatInput.value : '');
          if (chatInput) { chatInput.value = ''; chatInput.focus(); }
        }
      });
    }

    // Tombol 📎 membuka file picker
    if (btnAttach && fileInput) {
      btnAttach.addEventListener('click', function () { fileInput.click(); });
    }
    // File picker berubah
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        if (fileInput.files && fileInput.files[0]) {
          handleChatFileSelect(fileInput.files[0]);
        }
      });
    }
    // Tombol ✕ batal lampiran
    if (btnFileClear) {
      btnFileClear.addEventListener('click', function () { clearPendingFile(); });
    }
    // Paste gambar dari clipboard ke input chat
    if (chatInput) {
      chatInput.addEventListener('paste', function (e) {
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (var i = 0; i < items.length; i++) {
          if (items[i].type.indexOf('image/') === 0) {
            e.preventDefault();
            var file = items[i].getAsFile();
            if (file) handleChatFileSelect(file);
            break;
          }
        }
      });
    }
    if (chatBack) {
      chatBack.addEventListener('click', function () {
        clearPendingFile();
        $('chat-room-view').style.display = 'none';
        if (tabConv && tabConv.classList.contains('active')) {
          $('chat-list-view').style.display = '';
          renderChatList();
        } else {
          $('chat-contacts-view').style.display = '';
          renderChatContacts();
        }
      });
    }
    if (tabConv) {
      tabConv.addEventListener('click', function () {
        tabConv.classList.add('active');
        if (tabContacts) tabContacts.classList.remove('active');
        $('chat-list-view').style.display = '';
        $('chat-contacts-view').style.display = 'none';
        renderChatList();
      });
    }
    if (tabContacts) {
      tabContacts.addEventListener('click', function () {
        tabContacts.classList.add('active');
        tabConv.classList.remove('active');
        $('chat-list-view').style.display = 'none';
        $('chat-contacts-view').style.display = '';
        renderChatContacts();
      });
    }
    if (contactSearch) {
      contactSearch.addEventListener('input', function () {
        renderChatContacts(contactSearch.value);
      });
    }

    /* Tombol izin notifikasi & tes notifikasi di halaman Chat */
    var btnNotifAct = $('btn-chat-notif-action');
    if (btnNotifAct) {
      btnNotifAct.addEventListener('click', function () {
        requestChatNotificationPermission();
      });
    }
    var btnNotifTest = $('btn-chat-notif-test');
    if (btnNotifTest) {
      btnNotifTest.addEventListener('click', function () {
        testChatNotification();
      });
    }
    var btnRoomNotif = $('btn-room-notif-status');
    if (btnRoomNotif) {
      btnRoomNotif.addEventListener('click', function () {
        if (getNotificationPermission() === 'granted') testChatNotification();
        else requestChatNotificationPermission();
      });
    }

    /* Tombol tes notifikasi di panel Admin */
    var btnAdminNotifTest = $('btn-admin-notif-test');
    if (btnAdminNotifTest) {
      btnAdminNotifTest.addEventListener('click', function () {
        testChatNotification();
      });
    }

    /* Floating In-App Toast klik handler */
    var inAppToastEl = $('chat-inapp-toast');
    var inAppToastOpen = $('chat-inapp-open');
    var inAppToastClick = $('chat-inapp-click');
    var inAppToastClose = $('chat-inapp-close');
    if (inAppToastOpen) {
      inAppToastOpen.addEventListener('click', function (e) {
        e.stopPropagation();
        var k = inAppToastEl ? inAppToastEl.getAttribute('data-chat') : '';
        hideInAppToast();
        if (k) openChatByKey(k);
      });
    }
    if (inAppToastClick) {
      inAppToastClick.addEventListener('click', function () {
        var k = inAppToastEl ? inAppToastEl.getAttribute('data-chat') : '';
        hideInAppToast();
        if (k) openChatByKey(k);
      });
    }
    if (inAppToastClose) {
      inAppToastClose.addEventListener('click', function (e) {
        e.stopPropagation();
        hideInAppToast();
      });
    }

    /* Listener Service Worker message (saat notifikasi sistem diklik) */
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'KYM_NOTIFICATION_CLICK' && e.data.chatKey) {
          openChatByKey(e.data.chatKey);
        }
      });
    }
  })();

  /* --- Real-time polling (local 2s) + GAS pull adaptif (6s active / 10s background) --- */
  chatPollTimer = setInterval(function () {
    if (document.hidden) return;
    var pg = $('page-chat');
    if (!pg || !pg.classList.contains('active')) { updateChatBadge(); return; }
    var all = loadChat();
    var newCount = all.length;
    var roomOpen = $('chat-room-view') && $('chat-room-view').style.display !== 'none';
    if (roomOpen) {
      var container = $('chat-messages');
      var chatKey = container ? container.getAttribute('data-chat') : '';
      if (chatKey) {
        // hash sederhana untuk deteksi edit/read: gabung id+edited+deleted+read
        var sig = all.filter(function(m){return m.chatKey===chatKey;}).map(function(m){return m.id+(m.edited?'E':'')+(m.deleted?'D':'')+(m.read?'R':'');}).join('|');
        if (sig !== chatPollTimer._lastSig) {
          renderChatMessages(chatKey);
          chatPollTimer._lastSig = sig;
          _chatLastCount = newCount;
        }
      }
    }
    var listView = $('chat-list-view');
    if (listView && listView.style.display !== 'none') renderChatList();
    var contactsView = $('chat-contacts-view');
    if (contactsView && contactsView.style.display !== 'none') renderChatContacts($('chat-contact-search') ? $('chat-contact-search').value : '');
    updateChatBadge();
    _chatLastCount = newCount;
  }, 2000);

  var _lastChatGasPull = 0;
  function doAdaptiveChatGasPull() {
    if (!gasActive() || !online()) return;
    var now = Date.now();
    // 6 detik saat aktif, 10 detik saat tab di background/layar diminimalkan
    var interval = document.hidden ? 10000 : 6000;
    if (now - _lastChatGasPull < interval) return;
    _lastChatGasPull = now;
    gasChatPull().then(function (n) {
      if (n) { flushChatOutbox(); }
    });
    flushChatOutbox();
    pumpChatFileUpload();
  }

  _chatGasPullTimer = setInterval(doAdaptiveChatGasPull, 3000);

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      resetDocumentTitle();
      updateChatBadge();
      doAdaptiveChatGasPull();
    }
  });

  var _poemPullTimer = null;
  _poemPullTimer = setInterval(function () {
    if (document.hidden) return;
    if (!gasActive() || !online()) return;
    silentPoemPull();
    flushOutbox();
    doAdaptiveChatGasPull();
  }, 12000);
  // pull awal 3 detik setelah load (auto tanpa klik)
  setTimeout(function () {
    if (gasActive() && online()) {
      silentPoemPull();
      gasChatPull();
      flushOutbox();
      flushChatOutbox();
      repairChatFileUploads().then(function () { pumpChatFileUpload(); });
    }
  }, 3000);

  window.addEventListener('online', function () {
    flushOutbox().then(function(){ silentPoemPull(); });
    flushChatOutbox().then(function(){ gasChatPull(); });
    pumpChatFileUpload();
    syncChatFiles();
  });

  /* --- Cross-tab sync via storage event --- */
  window.addEventListener('storage', function (e) {
    if (e.key !== LS_CHAT && e.key !== LS_CHAT_OUTBOX) return;
    updateChatBadge();
    var all = loadChat();
    if (typeof handleIncomingChatNotifications === 'function') {
      handleIncomingChatNotifications(all);
    }
    var pg = $('page-chat');
    if (!pg || !pg.classList.contains('active')) return;
    var roomOpen = $('chat-room-view') && $('chat-room-view').style.display !== 'none';
    if (roomOpen) {
      var container = $('chat-messages');
      var chatKey = container ? container.getAttribute('data-chat') : '';
      if (chatKey) renderChatMessages(chatKey);
    }
    renderChatListIfVisible();
    var cv = $('chat-contacts-view');
    if (cv && cv.style.display !== 'none') renderChatContacts($('chat-contact-search') ? $('chat-contact-search').value : '');
  });

  seedInitialNotifiedMsgs();
  updateNotificationBannerUi();
  updateChatBadge();
  checkChatDeepLink();

})();
