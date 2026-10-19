/**
 * 보기 설정: 글꼴·글자 크기·줄 간격·문단 간격·좌우 여백·정렬·들여쓰기·테마·넘김 방식·화면 꺼짐 방지·전체화면.
 * localStorage('viewSettings')에 저장하고 바로 적용한다. 예전 'fs'·'theme' 값은 처음 한 번 옮겨 온다.
 */
(function (global) {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var LS = global.localStorage;
  function safeGet(k) { try { return LS.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { LS.setItem(k, v); } catch (e) {} }

  var SYS = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", "Malgun Gothic", sans-serif';
  var FONTS = {
    system: { label: '시스템 고딕', stack: SYS },
    'noto-sans': { label: '본고딕', css: 'Noto+Sans+KR:wght@400;700', stack: '"Noto Sans KR", ' + SYS },
    'nanum-gothic': { label: '나눔고딕', css: 'Nanum+Gothic:wght@400;700', stack: '"Nanum Gothic", "NanumGothic", ' + SYS },
    'gowun-dodum': { label: '고운돋움', css: 'Gowun+Dodum', stack: '"Gowun Dodum", ' + SYS },
    'noto-serif': { label: '본명조', css: 'Noto+Serif+KR:wght@400;700', stack: '"Noto Serif KR", "Nanum Myeongjo", "AppleMyungjo", serif' },
    'nanum-myeongjo': { label: '나눔명조', css: 'Nanum+Myeongjo:wght@400;700', stack: '"Nanum Myeongjo", "NanumMyeongjo", "Noto Serif KR", serif' }
  };
  var THEME_COLOR = { light: '#faf8f5', sepia: '#f4ecd8', dark: '#16141a', black: '#000000' };
  var LIMITS = { fs: [13, 32], lh: [1.3, 2.5], ps: [0, 2.5], mx: [4, 56] };

  function prefersDark() { return !!(global.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches); }
  function defaults() {
    return { font: 'system', fs: 18, lh: 1.85, ps: 1.05, mx: 16, align: 'left', indent: false,
      theme: prefersDark() ? 'dark' : 'light', mode: 'scroll', wake: false, spread: 'auto', hideBar: true, source: 'all' };
  }
  /** 넓은 화면(폴드 안쪽 화면 등): 양쪽 보기 '자동'과 상태표시줄 숨기기가 같은 기준을 쓴다 */
  function isWide() {
    var w = document.documentElement.clientWidth || global.innerWidth, h = global.innerHeight || 1;
    return w >= 560 && w / h >= 0.65;
  }

  // ---------- 내 글꼴 (기기에만 저장: IndexedDB 'reader-fonts') ----------
  var CUSTOM_PREFIX = 'custom:';
  var BIG_FONT = 30 * 1024 * 1024;
  var customMeta = [];        // [{id, name, size}] — localStorage에도 적어 두어 첫 화면에서 바로 목록을 그린다
  try { customMeta = JSON.parse(safeGet('customFonts') || '[]') || []; } catch (e) { customMeta = []; }
  var customFaces = {};       // id -> FontFace
  function customMetaById(key) {
    if (typeof key !== 'string' || key.indexOf(CUSTOM_PREFIX) !== 0) return null;
    var id = key.slice(CUSTOM_PREFIX.length);
    for (var i = 0; i < customMeta.length; i++) if (customMeta[i].id === id) return customMeta[i];
    return null;
  }
  function familyOf(id) { return 'ReaderCustom-' + id; }
  function saveMeta() { safeSet('customFonts', JSON.stringify(customMeta)); }
  var fontDb = (function () {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        if (!global.indexedDB) { rej(new Error('no idb')); return; }
        var r = indexedDB.open('reader-fonts', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('fonts', { keyPath: 'id' }); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
      dbp.catch(function () { dbp = null; });
      return dbp;
    }
    function run(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction('fonts', mode), req = fn(t.objectStore('fonts'));
          t.oncomplete = function () { res(req && req.result); };
          t.onerror = t.onabort = function () { rej(t.error || new Error('idb')); };
        });
      });
    }
    return {
      all: function () { return run('readonly', function (st) { return st.getAll(); }); },
      put: function (rec) { return run('readwrite', function (st) { st.put(rec); }); },
      del: function (id) { return run('readwrite', function (st) { st['delete'](id); }); }
    };
  })();
  var fontLoadedFns = [];
  function onFontLoaded(fn) { fontLoadedFns.push(fn); }
  function fireFontLoaded() { fontLoadedFns.forEach(function (f) { try { f(); } catch (e) { console.error(e); } }); }
  function registerFace(id, data) {
    var face = new FontFace(familyOf(id), data, { display: 'swap' });
    return face.load().then(function (f) {
      document.fonts.add(f);
      customFaces[id] = f;
      return f;
    });
  }
  /** 시작할 때: 저장해 둔 글꼴을 모두 등록. 고른 글꼴이 내 글꼴이면 잠깐(최대 0.4초) 본문을 가려 깜빡임을 줄인다. */
  var fontsReady = (function restoreCustomFonts() {
    var waiting = false;
    try {
      var saved = JSON.parse(safeGet('viewSettings') || 'null');
      if (saved && typeof saved.font === 'string' && saved.font.indexOf(CUSTOM_PREFIX) === 0 && customMetaById(saved.font)) {
        waiting = true;
        document.documentElement.classList.add('font-wait');
      }
    } catch (e) {}
    var unhide = function () { document.documentElement.classList.remove('font-wait'); };
    if (waiting) setTimeout(unhide, 400);
    return fontDb.all().then(function (recs) {
      recs = recs || [];
      var have = {};
      return Promise.all(recs.map(function (r) {
        have[r.id] = true;
        return registerFace(r.id, r.data).catch(function () { return null; });
      })).then(function () {
        // 저장소와 목록 맞추기 (다른 탭에서 지운 경우 등)
        var meta = recs.map(function (r) { return { id: r.id, name: r.name, size: r.size }; });
        var changed = JSON.stringify(meta) !== JSON.stringify(customMeta);
        customMeta = meta; saveMeta();
        if (s && s.font && s.font.indexOf(CUSTOM_PREFIX) === 0 && !customMetaById(s.font)) set({ font: 'system' });
        else if (changed) { renderFontButtons(); paintSheet(); }
      });
    }).catch(function () {}).then(function () { unhide(); fireFontLoaded(); });
  })();

  var s = defaults();
  (function load() {
    var saved = null;
    try { saved = JSON.parse(safeGet('viewSettings') || 'null'); } catch (e) {}
    if (saved && typeof saved === 'object') {
      Object.keys(s).forEach(function (k) { if (saved[k] !== undefined && saved[k] !== null) s[k] = saved[k]; });
    } else {
      // 예전 리더의 '가-/가+'와 다크 모드 값 옮기기
      var oldFs = parseInt(safeGet('fs') || '', 10);
      if (oldFs >= 10 && oldFs <= 40) s.fs = oldFs;
      var oldTheme = safeGet('theme');
      if (oldTheme === 'dark' || oldTheme === 'light') s.theme = oldTheme;
    }
    if (!FONTS[s.font] && !customMetaById(s.font)) s.font = 'system';
    if (['auto', 'on', 'off'].indexOf(s.spread) === -1) s.spread = 'auto';
    if (typeof s.hideBar !== 'boolean') s.hideBar = true;
    if (['all', 'old', 'gpt', 'grok'].indexOf(s.source) === -1) s.source = 'all';
    if (!THEME_COLOR[s.theme]) s.theme = 'light';
    if (s.mode !== 'page') s.mode = 'scroll';
    Object.keys(LIMITS).forEach(function (k) { s[k] = clamp(k, Number(s[k])); });
  })();

  function clamp(k, v) {
    var L = LIMITS[k];
    if (!isFinite(v)) v = defaults()[k];
    v = Math.min(L[1], Math.max(L[0], v));
    return Math.round(v * 100) / 100;
  }

  var before = [], after = [];
  function onBeforeChange(fn) { before.push(fn); }
  function onChange(fn) { after.push(fn); }

  var fontLinks = {};
  function ensureFont(key) {
    var f = FONTS[key];
    if (!f || !f.css || fontLinks[key]) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=' + f.css + '&display=swap';
    l.crossOrigin = 'anonymous';
    document.head.appendChild(l);
    fontLinks[key] = l;
  }

  function fontStack(key) {
    if (FONTS[key]) return FONTS[key].stack;
    var m = customMetaById(key);
    if (m) return '"' + familyOf(m.id) + '", ' + SYS;   // 불러오는 동안은 시스템 글꼴로
    return SYS;
  }
  function applyCss() {
    var r = document.documentElement.style;
    ensureFont(s.font);
    r.setProperty('--font', fontStack(s.font));
    r.setProperty('--fs', s.fs + 'px');
    r.setProperty('--lh', String(s.lh));
    r.setProperty('--ps', s.ps + 'em');
    r.setProperty('--mx', s.mx + 'px');
    r.setProperty('--align', s.align === 'justify' ? 'justify' : 'left');
    r.setProperty('--indent', s.indent ? '1' : '0');
    document.documentElement.setAttribute('data-theme', s.theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) { meta.remove(); meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    if (meta) meta.setAttribute('content', THEME_COLOR[s.theme]);
    document.documentElement.style.colorScheme = (s.theme === 'dark' || s.theme === 'black') ? 'dark' : 'light';
    var tb = $('themeBtn');
    if (tb) tb.textContent = s.theme === 'dark' || s.theme === 'black' ? '☀️' : '🌙';
  }

  function set(patch) {
    var changed = {};
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (LIMITS[k]) v = clamp(k, Number(v));
      if (s[k] !== v) changed[k] = { from: s[k], to: v };
    });
    if (!Object.keys(changed).length) return;
    before.forEach(function (f) { try { f(changed, s); } catch (e) { console.error(e); } });
    Object.keys(changed).forEach(function (k) { s[k] = changed[k].to; });
    safeSet('viewSettings', JSON.stringify(s));
    applyCss();
    paintSheet();
    if (changed.wake) syncWake();
    if (changed.hideBar) syncHideBar();
    after.forEach(function (f) { try { f(changed, s); } catch (e) { console.error(e); } });
  }
  function get() { return s; }
  function reset() {
    var d = defaults();
    d.mode = s.mode; d.wake = s.wake; d.hideBar = s.hideBar; d.source = s.source;   // 넘김 방식·화면 꺼짐 방지·상태표시줄 숨기기는 그대로 둔다
    set(d);
  }

  // ---------- 화면 꺼짐 방지 ----------
  var wakeLock = null, reading = false;
  function wakeSupported() { return !!(navigator.wakeLock && navigator.wakeLock.request); }
  function syncWake() {
    var want = s.wake && reading && document.visibilityState === 'visible';
    if (!wakeSupported()) return;
    if (want && !wakeLock) {
      navigator.wakeLock.request('screen').then(function (l) {
        wakeLock = l;
        l.addEventListener('release', function () { if (wakeLock === l) wakeLock = null; });
        if (!(s.wake && reading)) { l.release().catch(function () {}); }
      }).catch(function () {});
    } else if (!want && wakeLock) {
      var l = wakeLock; wakeLock = null; l.release().catch(function () {});
    }
  }
  function setReading(v) { reading = !!v; syncWake(); }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { wakeLock = null; }
    syncWake();
  });

  // ---------- 전체화면 ----------
  function fullSupported() { return !!(document.fullscreenEnabled && document.documentElement.requestFullscreen); }
  // 전체화면 버튼으로 직접 켠 것과 '상태표시줄 숨기기'로 저절로 켠 것을 구분한다
  var fsAuto = false;          // 지금 전체화면이 우리가 저절로 켠 것인가
  var fsPending = null;        // 요청 중인 전체화면의 종류: 'auto' | 'manual'
  var fsArmed = true;          // 다음 탭에서 저절로 켜도 되는가 (처음 실행·접고 펴기·앱 복귀 때 다시 켠다)
  var lastWide = null;
  function requestFull(kind) {
    fsPending = kind;
    try {
      var p = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (p && p.catch) p.catch(function () { if (fsPending === kind) fsPending = null; });
    } catch (e) { fsPending = null; }
  }
  function exitFull() {
    try { var p = document.exitFullscreen(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }
  function toggleFull() {
    if (!fullSupported()) return;
    if (document.fullscreenElement) { fsArmed = false; exitFull(); }   // 직접 끈 것: 다음 탭에서 다시 켜지 않는다
    else requestFull('manual');
  }
  /** 사용자 동작(탭·키) 안에서만 부를 것. 조건이 맞으면 전체화면을 요청하고, 탭 자체는 막지 않는다. */
  function maybeAutoFull() {
    if (!s.hideBar || !fsArmed || !fullSupported() || document.fullscreenElement || fsPending) return;
    if (document.visibilityState === 'hidden' || !isWide()) return;
    fsArmed = false;
    requestFull('auto');
  }
  function onGesture(e) {
    if (e.type === 'keydown' && (e.key === 'Escape' || e.key === 'F11')) return;
    if (e.target && e.target.closest && e.target.closest('#fullBtn')) return;   // 전체화면 버튼은 그 버튼이 처리한다
    maybeAutoFull();
  }
  ['pointerup', 'click', 'keydown'].forEach(function (t) {
    document.addEventListener(t, onGesture, { capture: true, passive: true });
  });
  function syncHideBar() {
    if (!s.hideBar) { if (fsAuto && document.fullscreenElement) exitFull(); }
    else { fsArmed = true; maybeAutoFull(); }   // 켜기 버튼을 누른 그 탭으로 바로 숨긴다
  }
  function checkWide() {
    var w = isWide();
    if (lastWide !== null && w !== lastWide) {
      fsArmed = true;                            // 접거나 펼쳤다: 다시 켤 준비
      if (!w && fsAuto && document.fullscreenElement) exitFull();   // 접으면 테마 색 상태표시줄이 다시 보이게
    }
    lastWide = w;
  }
  global.addEventListener('resize', checkWide);
  checkWide();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { fsArmed = true; checkWide(); }
  });
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement) { fsAuto = false; fsPending = null; }
    else if (fsPending) { fsAuto = fsPending === 'auto'; fsPending = null; }   // 요청 없이 온 알림이면 그대로 둔다
    paintSheet();
  });

  // ---------- 설정 시트 ----------
  var sheetOpen = false;
  function openSheet() {
    paintSheet();
    $('sheetBack').hidden = false; $('sheet').hidden = false; sheetOpen = true;
    $('sheet').scrollTop = 0;
  }
  function closeSheet() { $('sheetBack').hidden = true; $('sheet').hidden = true; sheetOpen = false; }
  function isOpen() { return sheetOpen; }

  function segPaint(id, val) {
    Array.prototype.forEach.call($(id).querySelectorAll('button[data-v]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-v') === String(val));
    });
  }
  function fmt(k, v) {
    if (k === 'fs') return v + 'px';
    if (k === 'mx') return v + 'px';
    if (k === 'ps') return v.toFixed(2).replace(/0$/, '');
    return v.toFixed(2);
  }
  function paintSheet() {
    if (!$('sheet')) return;
    segPaint('setFont', s.font);
    ['fs', 'lh', 'ps', 'mx'].forEach(function (k) {
      var id = 'set' + k.charAt(0).toUpperCase() + k.slice(1);
      $(id).value = s[k];
      $('out' + k.charAt(0).toUpperCase() + k.slice(1)).textContent = fmt(k, s[k]);
    });
    segPaint('setAlign', s.align);
    segPaint('setIndent', s.indent ? '1' : '0');
    segPaint('setTheme', s.theme);
    segPaint('setMode', s.mode);
    segPaint('setSpread', s.spread);
    segPaint('setWake', s.wake ? '1' : '0');
    segPaint('setHideBar', s.hideBar ? '1' : '0');
    $('rowHideBar').hidden = $('hideBarHint').hidden = !fullSupported();
    $('rowWake').hidden = !wakeSupported();
    $('rowFull').hidden = !fullSupported();
    $('fullBtn').textContent = document.fullscreenElement ? '전체화면 끝내기' : '전체화면으로';
    $('fullBtn').classList.toggle('on', !!document.fullscreenElement);
    $('modeHint').hidden = s.mode !== 'page';
  }

  function buildSheet() {
    renderFontButtons();
    $('setFont').addEventListener('click', function (e) {
      var x = e.target.closest('button.fx');
      if (x) { e.stopPropagation(); removeCustomFont(x.getAttribute('data-id')); return; }
      if (e.target.closest('button.addfont')) { $('fontFile').value = ''; $('fontFile').click(); }
    });
    $('fontFile').addEventListener('change', function () {
      var files = Array.prototype.slice.call($('fontFile').files || []);
      if (files.length) addFontFiles(files);
    });
    function seg(id, fn) {
      $(id).addEventListener('click', function (e) {
        var b = e.target.closest('button[data-v]');
        if (b) fn(b.getAttribute('data-v'));
      });
    }
    seg('setFont', function (v) { set({ font: v }); });
    seg('setAlign', function (v) { set({ align: v }); });
    seg('setIndent', function (v) { set({ indent: v === '1' }); });
    seg('setTheme', function (v) { set({ theme: v }); });
    seg('setMode', function (v) { set({ mode: v }); });
    seg('setWake', function (v) { set({ wake: v === '1' }); });
    seg('setSpread', function (v) { set({ spread: v }); });
    seg('setHideBar', function (v) { set({ hideBar: v === '1' }); });
    ['fs', 'lh', 'ps', 'mx'].forEach(function (k) {
      var id = 'set' + k.charAt(0).toUpperCase() + k.slice(1);
      $(id).addEventListener('input', function () { var p = {}; p[k] = Number($(id).value); set(p); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-step]'), function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-step'), p = {};
        p[k] = s[k] + Number(b.getAttribute('data-d'));
        set(p);
      });
    });
    $('fullBtn').addEventListener('click', toggleFull);
    $('setReset').addEventListener('click', reset);
    $('sheetClose').addEventListener('click', closeSheet);
    $('sheetDone').addEventListener('click', closeSheet);
    $('sheetBack').addEventListener('click', closeSheet);
    document.addEventListener('keydown', function (e) { if (sheetOpen && e.key === 'Escape') closeSheet(); });
    // 손잡이를 아래로 끌면 닫기
    var y0 = null;
    $('sheet').addEventListener('touchstart', function (e) { y0 = $('sheet').scrollTop <= 0 && e.target.closest('.grab, .shead') ? e.touches[0].clientY : null; }, { passive: true });
    $('sheet').addEventListener('touchend', function (e) {
      if (y0 != null && e.changedTouches[0].clientY - y0 > 60) closeSheet();
      y0 = null;
    }, { passive: true });
  }

  function renderFontButtons() {
    var box = $('setFont');
    if (!box) return;
    box.innerHTML = '';
    Object.keys(FONTS).forEach(function (k) {
      var b = document.createElement('button');
      b.setAttribute('data-v', k); b.textContent = FONTS[k].label;
      box.appendChild(b);
    });
    customMeta.forEach(function (m) {
      var w = document.createElement('span'); w.className = 'fontopt';
      var b = document.createElement('button');
      b.setAttribute('data-v', CUSTOM_PREFIX + m.id); b.textContent = m.name;
      b.style.fontFamily = '"' + familyOf(m.id) + '", ' + SYS;
      var x = document.createElement('button');
      x.className = 'fx'; x.setAttribute('data-id', m.id); x.setAttribute('aria-label', m.name + ' 글꼴 지우기'); x.textContent = '×';
      w.appendChild(b); w.appendChild(x);
      box.appendChild(w);
    });
    var add = document.createElement('button');
    add.className = 'addfont'; add.textContent = '+ 내 글꼴 추가';
    box.appendChild(add);
    if (s) segPaint('setFont', s.font);
  }
  function fontMsg(t, isErr) {
    var el = $('fontMsg'); if (!el) return;
    el.textContent = t || ''; el.classList.toggle('err', !!isErr);
  }
  function mb(n) { return (Math.round(n / 1024 / 1024 * 10) / 10) + 'MB'; }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  /** 파일에서 글꼴 추가: FontFace로 읽어 보고, 되면 IndexedDB에 바이트를 저장 */
  function addFontFiles(files) {
    var chain = Promise.resolve(), added = 0, lastKey = null;
    files.forEach(function (file) {
      chain = chain.then(function () {
        var name = String(file.name || '').replace(/\.[^.\/]+$/, '').trim() || '내 글꼴';
        if (file.size > BIG_FONT && !global.confirm('“' + name + '” 글꼴 파일이 커요 (' + mb(file.size) + '). 기기 저장 공간을 많이 차지할 수 있어요. 그래도 추가할까요?')) return;
        fontMsg('“' + name + '” 글꼴을 읽는 중…');
        return file.arrayBuffer().then(function (buf) {
          var id = newId();
          return registerFace(id, buf).then(function () {
            var rec = { id: id, name: name, size: file.size, type: file.type || '', data: buf, added: Date.now() };
            return fontDb.put(rec).then(function () { return true; }, function () { return false; }).then(function (stored) {
              customMeta.push({ id: id, name: name, size: file.size });
              saveMeta();
              added++; lastKey = CUSTOM_PREFIX + id;
              fontMsg(stored ? '“' + name + '” 글꼴을 추가했어요.' : '“' + name + '” 글꼴을 추가했지만 저장 공간이 부족해 이 기기에 저장하지 못했어요. 앱을 다시 열면 사라져요.', !stored);
            });
          }, function () {
            fontMsg('“' + (file.name || name) + '”을(를) 글꼴로 읽지 못했어요. 손상됐거나 지원하지 않는 형식이에요 (TTF·OTF·WOFF·WOFF2만 돼요).', true);
          });
        }, function () {
          fontMsg('파일을 읽지 못했어요. 다시 골라 주세요.', true);
        });
      });
    });
    return chain.then(function () {
      if (!added) return;
      renderFontButtons();
      set({ font: lastKey });
      paintSheet();
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) {}
    });
  }
  function removeCustomFont(id) {
    var m = customMetaById(CUSTOM_PREFIX + id);
    if (!m) return Promise.resolve();
    if (!global.confirm('“' + m.name + '” 글꼴을 지울까요?\n이 앱에 저장된 사본만 지워지고, 원래 글꼴 파일은 그대로 남아요.')) return Promise.resolve();
    return fontDb.del(id).catch(function () {}).then(function () {
      if (customFaces[id]) { try { document.fonts['delete'](customFaces[id]); } catch (e) {} delete customFaces[id]; }
      customMeta = customMeta.filter(function (x) { return x.id !== id; });
      saveMeta();
      renderFontButtons();
      if (s.font === CUSTOM_PREFIX + id) set({ font: 'system' });
      paintSheet();
      fontMsg('“' + m.name + '” 글꼴을 지웠어요.');
    });
  }

  applyCss();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { buildSheet(); paintSheet(); });
  else { buildSheet(); paintSheet(); }

  global.Settings = {
    get: get, set: set, reset: reset, onBeforeChange: onBeforeChange, onChange: onChange,
    open: openSheet, close: closeSheet, isOpen: isOpen, setReading: setReading,
    toggleFull: toggleFull, isWide: isWide,
    fullState: function () { return { auto: fsAuto, armed: fsArmed, pending: fsPending, wide: isWide() }; }, FONTS: FONTS, onFontLoaded: onFontLoaded, fontsReady: fontsReady,
    customFonts: function () { return customMeta.slice(); }, addFontFiles: addFontFiles
  };
})(window);
