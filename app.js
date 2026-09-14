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
  var IDB_NAME = 'kym-filedb';
  var IDB_STORE = 'handles';

  /* ---------- File Database (JSON) ---------- */
  var dbFileHandle = null;   // FileSystemFileHandle saat terhubung
  var dbSaving = false;
  var dbPending = false;

  function fsaSupported() { return typeof window.showSaveFilePicker === 'function'; }

  function idbOpen() {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(IDB_NAME, 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore(IDB_STORE); };
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
      app: 'KYM', format: 1,
      savedAt: new Date().toISOString(),
      poems: loadPoems(),
      log: loadLog(),
      adminPass: getPass()
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
      return { added: added, updated: updated, logAdded: log.length - loadLog().length, total: poems.length, poems: poems, log: log };
    }
    poems = remotePoems;
    log = remoteLog;
    if (typeof data.adminPass === 'string' && data.adminPass) {
      localStorage.setItem(LS_PASS, data.adminPass);
    }
    return { added: poems.length, updated: 0, logAdded: log.length, total: poems.length, poems: poems, log: log };
  }

  function commitDb(data, merge, sourceLabel) {
    var r = applyDbObject(data, merge);
    savePoems(r.poems);
    localStorage.setItem(LS_LOG, JSON.stringify(r.log));
    renderAdmin();
    setDbStatus('♻️ Pulihkan (' + sourceLabel + '): ' + r.total + ' karya' + (merge ? ' · ' + r.added + ' baru · ' + r.updated + ' diperbarui' : '') + '.', true);
    toast('Database dipulihkan: ' + r.total + ' karya.');
    saveDbToFile();
    return r;
  }
  var DEFAULT_PASS = 'alal1010';

  /* ---------- Navigasi via hash (untuk shortcut PWA & deep-link) ---------- */
  function pageFromHash() {
    var h = (location.hash || '').replace('#', '');
    return ['materi', 'kirim', 'galeri', 'karyaku', 'admin', 'pasang'].indexOf(h) !== -1 ? h : 'materi';
  }
  var _showPage = showPage;
  showPage = function (name) {
    if (location.hash !== '#' + name) { location.hash = name; return; }
    _showPage(name);
  };
  window.addEventListener('hashchange', function () {
    _showPage(pageFromHash());
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

  var APPS_SCRIPT_CODE = [
    '/** KYM \u2014 Penerima karya puisi ke Google Spreadsheet **/',
    'var HEADER = ["code","nama","jenjang","kelas","sekolah","tahap","judul","isi","profil","time","updatedAt","device"];',
    '',
    'function doPost(e) {',
    '  var out = { ok: true };',
    '  try {',
    '    var body = JSON.parse(e.postData.contents);',
    '    var ss = SpreadsheetApp.getActiveSpreadsheet();',
    '    var sh = ss.getSheetByName("Puisi") || ss.insertSheet("Puisi");',
    '    fixHeader(sh);',
    '    var p = body.poem || {};',
    '    function f(k) { return p[k] === undefined ? "" : p[k]; }',
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
    '',
    'function findRow(sh, code) {',
    '  var values = sh.getDataRange().getValues();',
    '  for (var i = 0; i < values.length; i++) if (String(values[i][0]) === String(code)) return i + 1;',
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
  function showPage(name) {
    var _ses = getSession();
    if (name === 'admin' && _ses && _ses.role !== 'guru') name = 'materi'; /* murid tidak dapat membuka admin */
    if (name === 'galeri' && !bolehLihatGaleri()) name = 'materi'; /* galeri khusus admin & GTK */
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
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-nav]');
    if (!a) return;
    e.preventDefault();
    showPage(a.getAttribute('data-nav'));
  });

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
    var box = $('sesi-box'), namaEl = $('sesi-nama'), adminNav = $('nav-admin'), adminKeluar = $('admin-keluar');
    updateGaleriNav();
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
    showPage('materi');
  }

  function renderLoginUi() {
    renderHeaderSesi();
    var ses = getSession();
    var box = $('login-box'), chip = $('user-chip'), wrap = $('form-kirim-wrap');
    if (ses) {
      box.style.display = 'none';
      chip.style.display = 'flex';
      wrap.style.display = 'block';
      var peran = ses.role === 'guru' ? '👨‍🏫 Guru/Tendik (GTK)' : '👩‍🎓 Murid — Kelas ' + ses.kelasDigit;
      chip.innerHTML = '<span>🔐 <b>' + esc(ses.nama) + '</b> · ' + peran + '</span>';
      $('f-nama').value = ses.nama;
      $('f-kelas').value = ses.role === 'guru' ? 'Guru/Tendik (GTK)' : KELAS_LABEL[ses.kelasDigit];
      $('profil-wrap').style.display = ses.role === 'guru' ? 'block' : 'none';
    } else {
      box.style.display = 'block';
      chip.style.display = 'none';
      wrap.style.display = 'none';
    }
  }

  function initLoginUi() {
    var sb = $('btn-sesi-keluar');
    if (sb) sb.addEventListener('click', doLogout);
    populateNama();
    $('l-kelas').addEventListener('change', populateNama);
    function showTab(which) {
      $('form-login-murid').style.display = which === 'murid' ? 'block' : 'none';
      $('form-login-guru').style.display = which === 'guru' ? 'block' : 'none';
      $('form-daftar-guru').style.display = which === 'daftar' ? 'block' : 'none';
    }
    $('tab-murid').addEventListener('click', function () { showTab('murid'); });
    $('tab-guru').addEventListener('click', function () { showTab('guru'); });
    $('link-daftar').addEventListener('click', function (e) {
      e.preventDefault();
      $('form-login-murid').style.display = 'none';
      $('form-login-guru').style.display = 'none';
      $('form-daftar-guru').style.display = 'block';
    });
    $('link-login-guru').addEventListener('click', function (e) {
      e.preventDefault();
      $('form-login-murid').style.display = 'none';
      $('form-login-guru').style.display = 'block';
      $('form-daftar-guru').style.display = 'none';
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
        '<pre style="margin-top:6px;">' + esc(p.isi) + '</pre>' +
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
    } else {
      toast('Password salah.');
    }
  });

  $('btn-admin-keluar').addEventListener('click', function () {
    try { sessionStorage.removeItem(LS_UNLOCK); } catch (e) {}
    renderHeaderSesi();
    initAdmin();
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
})();
