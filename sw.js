/* 앱 껍데기 캐시. 구글 API(드라이브·로그인) 응답은 절대 캐시하지 않는다. */
var VERSION = 'v18';
var SHELL_CACHE = 'reader-shell-' + VERSION;
var CDN_CACHE = 'reader-cdn-v1';     // 버전 고정 라이브러리·웹 글꼴
var SHELL = [
  './', 'index.html', 'style.css', 'drive.js', 'core.js', 'settings.js', 'app.js', 'config.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-192.png',
  'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'
];
var CDN = [
  'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(Promise.all([
    // HTTP 캐시(깃허브 페이지 10분)를 거치지 않고 새로 받아야 새 버전 캐시에 예전 파일이 섞이지 않는다
    caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); })); }),
    caches.open(CDN_CACHE).then(function (c) {
      return Promise.all(CDN.map(function (u) {
        return c.match(u).then(function (hit) { return hit || c.add(new Request(u, { mode: 'cors' })); });
      }));
    })
  ]).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('reader-shell-') === 0 && k !== SHELL_CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function isGoogleApi(url) {
  return /(^|\.)googleapis\.com$/.test(url.hostname) && url.hostname !== 'fonts.googleapis.com'
    || url.hostname === 'accounts.google.com' || /(^|\.)googleusercontent\.com$/.test(url.hostname);
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (isGoogleApi(url)) return;                       // 드라이브·로그인: 그대로 네트워크로

  // 버전 고정 CDN 라이브러리와 구글 웹 글꼴: 캐시 우선
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'fonts.gstatic.com' || url.hostname === 'fonts.googleapis.com') {
    e.respondWith(caches.open(CDN_CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit && url.hostname !== 'fonts.googleapis.com') return hit;
        var net = fetch(req).then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
          return res;
        });
        return hit ? (net.catch(function () {}), hit) : net;
      });
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  var scope = new URL(self.registration.scope);
  var rel = url.pathname.indexOf(scope.pathname) === 0 ? url.pathname.slice(scope.pathname.length) : url.pathname;

  // config.js: 네트워크 우선 (클라이언트 ID를 바꾸면 바로 반영)
  if (rel === 'config.js') {
    e.respondWith(fetch(req).then(function (res) {
      if (res.ok) caches.open(SHELL_CACHE).then(function (c) { c.put('config.js', res.clone()); });
      return res;
    }).catch(function () { return caches.match('config.js', { cacheName: SHELL_CACHE }); }));
    return;
  }

  // 화면 이동(?ep= 포함)과 앱 파일: 캐시를 바로 주고 뒤에서 새 버전으로 갱신
  var key = req.mode === 'navigate' || rel === '' || rel === 'index.html' ? 'index.html' : rel;
  e.respondWith(caches.open(SHELL_CACHE).then(function (c) {
    return c.match(key).then(function (hit) {
      var net = fetch(req.mode === 'navigate' ? key : req).then(function (res) {
        if (res && res.ok) c.put(key, res.clone());
        return res;
      });
      if (hit) { e.waitUntil(net.catch(function () {})); return hit; }
      return net.catch(function () { return c.match(key); });
    });
  }));
});

self.addEventListener('message', function (e) { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
