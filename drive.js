/**
 * 구글 드라이브 연결 (Google Identity Services 토큰 모델 + Drive REST v3)
 * - 액세스 토큰과 만료 시각을 localStorage에 보관해 1시간 안에 다시 열면 바로 쓴다.
 * - 팝업은 사용자가 누른 순간에만 열 수 있으므로, 만료 5분 전부터는 아무 탭에서나 조용히 갱신한다(gestureRefresh).
 * - 401·만료 때는 '연결 갱신' 막대를 띄우고, 누르면 갱신한 뒤 기다리던 요청을 다시 보낸다.
 * - 이 파일에는 삭제·휴지통 요청이 전혀 없다.
 */
(function (global) {
  'use strict';
  var cfg = global.READER_CONFIG || {};
  var SCOPE = 'https://www.googleapis.com/auth/drive';
  var API = 'https://www.googleapis.com/drive/v3';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  var GIS_SRC = 'https://accounts.google.com/gsi/client';
  var FOLDER_MIME = 'application/vnd.google-apps.folder';
  var K_TOK = 'drive.token', K_EMAIL = 'drive.email', K_EVER = 'drive.connected';
  var REFRESH_BEFORE = 5 * 60 * 1000;

  function lsGet(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { global.localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { global.localStorage.removeItem(k); } catch (e) {} }

  var tok = null;
  try { tok = JSON.parse(lsGet(K_TOK) || 'null'); } catch (e) {}
  if (tok && !(tok.access_token && tok.exp)) tok = null;
  var email = lsGet(K_EMAIL) || '';
  var ever = lsGet(K_EVER) === '1' || !!tok;
  var client = null, clientHint = null, requesting = false, reqTimer = null;
  var waiters = [], handlers = {}, needShown = false, gisPromise = null, expTimer = null;

  function on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); }
  function emit(ev, a) { (handlers[ev] || []).forEach(function (f) { try { f(a); } catch (e) { console.error(e); } }); }

  function configured() { return !!(cfg.clientId && !/^YOUR_CLIENT_ID/.test(cfg.clientId)); }
  function gisReady() { return !!(global.google && global.google.accounts && global.google.accounts.oauth2); }
  function loadGis() {
    if (gisReady()) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = GIS_SRC; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { gisPromise = null; s.remove(); reject(new Error('구글 로그인 스크립트를 불러오지 못했어요.')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }
  function ensureClient() {
    if (!gisReady() || !configured()) return null;
    if (client && clientHint === email) return client;
    var o = { client_id: cfg.clientId, scope: SCOPE, callback: onToken, error_callback: onTokenError };
    if (email) o.login_hint = email;
    client = global.google.accounts.oauth2.initTokenClient(o);
    clientHint = email;
    return client;
  }

  function setNeed() {
    if (needShown) return;
    needShown = true;
    emit('need', ever ? 'refresh' : 'connect');
  }
  function armExpiry() {
    clearTimeout(expTimer);
    if (!tok) return;
    var ms = tok.exp - Date.now() - 60000;
    if (ms > 0 && ms < 0x7fffffff) expTimer = setTimeout(function () { if (!hasValidToken()) setNeed(); }, ms + 500);
  }

  /** 사용자 탭 안에서만 부를 것. interactive=true면 처음 연결(계정 선택·동의 창). */
  function requestToken(interactive) {
    if (!configured()) { emit('error', 'config.js에 OAuth 클라이언트 ID를 넣어 주세요.'); return false; }
    var c = ensureClient();
    if (!c) { emit('error', '구글 로그인 스크립트를 아직 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'); loadGis().catch(function () {}); return false; }
    if (requesting) return true;
    requesting = true;
    clearTimeout(reqTimer);
    reqTimer = setTimeout(function () { requesting = false; }, 90000);
    var o = {};
    if (!(interactive && !ever)) o.prompt = '';
    if (email) o.login_hint = email;
    try { c.requestAccessToken(o); } catch (e) { requesting = false; emit('error', e.message || String(e)); return false; }
    return true;
  }
  function onToken(r) {
    requesting = false; clearTimeout(reqTimer);
    if (!r || r.error) { emit('error', '연결하지 못했어요' + (r && r.error ? ' (' + r.error + ')' : '') + '. 다시 눌러 주세요.'); needShown = false; setNeed(); return; }
    var oa = global.google && global.google.accounts && global.google.accounts.oauth2;
    if (oa && oa.hasGrantedAllScopes && !oa.hasGrantedAllScopes(r, SCOPE)) {
      emit('error', '드라이브 권한을 허용해야 읽고 쓸 수 있어요.'); needShown = false; setNeed(); return;
    }
    tok = { access_token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
    lsSet(K_TOK, JSON.stringify(tok));
    ever = true; lsSet(K_EVER, '1');
    needShown = false; armExpiry();
    emit('ok');
    var w = waiters; waiters = [];
    w.forEach(function (f) { f(tok.access_token); });
    if (!email) {
      about().then(function (a) {
        var em = a && a.user && a.user.emailAddress;
        if (em) { email = em; lsSet(K_EMAIL, em); emit('email', em); }
      }).catch(function () {});
    }
  }
  function onTokenError(e) {
    requesting = false; clearTimeout(reqTimer);
    var t = e && e.type;
    emit('error', t === 'popup_closed' ? '연결 창이 닫혔어요. 다시 눌러 주세요.'
      : t === 'popup_failed_to_open' ? '팝업을 열지 못했어요. 다시 눌러 주세요.' : '연결하지 못했어요. 다시 눌러 주세요.');
    needShown = false; setNeed();
  }
  function hasValidToken(marginMs) { return !!(tok && tok.exp - Date.now() > (marginMs == null ? 60000 : marginMs)); }
  function getToken() {
    if (hasValidToken()) return Promise.resolve(tok.access_token);
    setNeed();
    return new Promise(function (resolve) { waiters.push(resolve); });
  }
  /** 문서 전체 click(캡처 단계)에서 호출: 만료 5분 전이면 조용히 갱신(prompt:''). */
  function gestureRefresh() {
    if (!ever || requesting || !configured()) return;
    if (tok && tok.exp - Date.now() > REFRESH_BEFORE) return;
    requestToken(false);
  }

  // ---------- REST ----------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function qs(o) {
    return Object.keys(o).filter(function (k) { return o[k] != null && o[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&');
  }
  function isRateLimit(res) {
    return res.clone().json().then(function (j) {
      var r = j && j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
      return /rateLimit|userRateLimit/i.test(r || '');
    }).catch(function () { return false; });
  }
  function request(url, opts, tries) {
    opts = opts || {}; tries = tries || 0;
    return getToken().then(function (t) {
      var headers = {};
      Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });
      headers.Authorization = 'Bearer ' + t;
      var init = { method: opts.method || 'GET', headers: headers, body: opts.body, cache: 'no-store' };
      if (opts.keepalive) init.keepalive = true;
      return fetch(url, init).catch(function () {
        var err = new Error('인터넷 연결을 확인해 주세요.'); err.offline = true; throw err;
      }).then(function (res) {
        if (res.status === 401 && tries < 3) {
          if (tok && tok.access_token === t) { tok = null; lsDel(K_TOK); }
          needShown = false;
          return request(url, opts, tries + 1);
        }
        var retry = res.status === 429 || res.status >= 500 ? Promise.resolve(true)
          : res.status === 403 ? isRateLimit(res) : Promise.resolve(false);
        return retry.then(function (again) {
          if (again && tries < 4) return sleep(400 * Math.pow(2, tries) + Math.random() * 300).then(function () { return request(url, opts, tries + 1); });
          if (!res.ok) {
            return res.json().catch(function () { return null; }).then(function (j) {
              var e = new Error('드라이브 오류 ' + res.status + (j && j.error && j.error.message ? ': ' + j.error.message : ''));
              e.status = res.status; throw e;
            });
          }
          return res;
        });
      });
    });
  }
  function json(p) { return p.then(function (r) { return r.json(); }); }

  /** files.list: 페이지를 끝까지 넘겨 모두 모은다. */
  function list(q, fields) {
    var out = [];
    function page(token) {
      var url = API + '/files?' + qs({ q: q, fields: 'nextPageToken, files(' + fields + ')', pageSize: 1000, pageToken: token });
      return json(request(url)).then(function (j) {
        Array.prototype.push.apply(out, j.files || []);
        return j.nextPageToken ? page(j.nextPageToken) : out;
      });
    }
    return page(null);
  }
  function getMeta(id, fields) { return json(request(API + '/files/' + encodeURIComponent(id) + '?' + qs({ fields: fields || 'id,name,mimeType,modifiedTime' }))); }
  var decoder = new TextDecoder('utf-8', { ignoreBOM: true });   // BOM이 있으면 그대로 보존 (Apps Script getDataAsString과 같게)
  function download(id) {
    return request(API + '/files/' + encodeURIComponent(id) + '?alt=media').then(function (r) { return r.arrayBuffer(); })
      .then(function (buf) { return decoder.decode(buf); });
  }
  /** 내용만 바꾼다(uploadType=media). 문자열 본문은 UTF-8로 전송된다. */
  function update(id, text, mime, o) {
    return json(request(UPLOAD + '/files/' + encodeURIComponent(id) + '?' + qs({ uploadType: 'media', fields: 'id,modifiedTime' }), {
      method: 'PATCH', headers: { 'Content-Type': mime || 'text/plain' }, body: text, keepalive: !!(o && o.keepalive)
    }));
  }
  function create(name, parentId, text, mime) {
    var b = 'rdr' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var meta = { name: name, parents: [parentId], mimeType: mime };
    var body = new Blob([
      '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n',
      '--' + b + '\r\nContent-Type: ' + mime + '\r\n\r\n', text, '\r\n--' + b + '--'
    ]);
    return json(request(UPLOAD + '/files?' + qs({ uploadType: 'multipart', fields: 'id,name,mimeType,modifiedTime' }), {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body
    }));
  }
  function createFolder(name, parentId) {
    return json(request(API + '/files?' + qs({ fields: 'id,name,mimeType' }), {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name: name, mimeType: FOLDER_MIME, parents: [parentId] })
    }));
  }
  function about() { return json(request(API + '/about?' + qs({ fields: 'user(emailAddress,displayName)' }))); }

  if (configured()) loadGis().catch(function () {});
  global.addEventListener('online', function () { if (configured() && !gisReady()) loadGis().catch(function () {}); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && ever && !hasValidToken()) setNeed();
  });
  armExpiry();

  global.Drive = {
    FOLDER_MIME: FOLDER_MIME,
    on: on, configured: configured, everConnected: function () { return ever; }, email: function () { return email; },
    hasValidToken: hasValidToken, requestToken: requestToken, gestureRefresh: gestureRefresh, loadGis: loadGis,
    list: list, getMeta: getMeta, download: download, update: update, create: create, createFolder: createFolder, about: about
  };
})(window);
