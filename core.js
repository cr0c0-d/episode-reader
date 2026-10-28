/**
 * Code.gs(Apps Script 서버)를 브라우저로 옮긴 부분.
 * - 하위 폴더를 모두 훑어 에피소드 목록을 만들고(getEpisodes),
 * - 원본 md 맨 끝의 관리 구역과 80_독자_피드백 폴더의 색인·모음 파일을 Apps Script와 똑같은 형식으로 쓴다.
 * - 원본 본문은 건드리지 않고, 어떤 파일도 지우지 않는다.
 */
(function (global) {
  'use strict';
  var D = global.Drive;
  var cfg = global.READER_CONFIG || {};

  var ROOT_FOLDER_ID = cfg.rootFolderId || '1-Ats9BwA1ENPSLe7-IYQVojxbsEOMzXP';
  var EXCLUDED_FOLDERS = ['00_GROK_시작', '01_AI읽기용_통합본', '02_대표작_선별', '03_원본_백업', '99_폐기', '80_독자_피드백', '미사용_파일_삭제예정'];
  var MIN_EPISODE_NUMBER = 1;

  var FEEDBACK_FOLDER_NAME = '80_독자_피드백';
  var FEEDBACK_INDEX_NAME = 'feedback_index.json';
  var FEEDBACK_SUMMARY_NAME = '독자_피드백_정리.md';
  var CANDIDATES_NAME = 'novel_candidates.json';
  var UNAPPLIED_NAME = '미반영_피드백.md';      // 마지막 반영완료 이후 새로 남기거나 고친 피드백만 (에이전트가 먼저 읽는 짧은 파일)
  var APPLIED_LOG_NAME = '반영_기록.md';        // 에이전트가 '반영완료:' 줄을 덧붙이는 파일. 앱은 읽기만 하고 절대 쓰지 않는다.
  var STATE_NAME = 'reader_state.json';          // 마지막으로 읽은 화 (휴대폰·PC 공유, PropertiesService 대신)
  var DEFAULT_HIDDEN_FOLDERS = ['00_설정과_대화'];
  var BLOCK_START = '<!-- 재독피드백:시작 (리더 앱이 자동 관리하는 구역) -->';
  var BLOCK_END = '<!-- 재독피드백:끝 -->';
  var RATING_LABEL = { best: '⭐ 최고', like: '👍 좋아요', meh: '😐 평범', dislike: '👎 별로', '': '평가 없음' };

  var EPISODE_RE = /^(\d+)_(.+)\.md$/i;
  // 작가(생성기)별 폴더: '개별 에피소드'(또는 아카이브 맨 위) 바로 아래 '686_이후_<작가>' 폴더. 몇 개든 된다.
  // 그 아래 파일은 'GPT001_제목.md'처럼 글자 접두어가 붙어도 된다.
  var AUTHOR_RE = /^\d+_이후_(.+)$/;
  var AUTHOR_PARENT = '개별 에피소드';
  var AUTHOR_ID = { 'ChatGPT': 'gpt', '새_분류': 'grok' };        // 이미 쓰는 키(686-grok 등)를 지키는 고정 ID
  var AUTHOR_LABEL = { 'ChatGPT': 'ChatGPT', '새_분류': '그록봇' };
  var AUTHOR_BADGE = { 'ChatGPT': 'GPT', '새_분류': '그록' };
  var SOURCE_LABEL = { old: '기존', gpt: 'ChatGPT', grok: '그록봇' };   // 이번 목록에서 찾은 작가가 더해진다
  var SOURCE_ORDER = { old: 0 };
  /** 더 쓰지 않는 작가. 그록·그록봇·Grok·ChatGPT는 남기고 SuperGrok·슈퍼그록만 가린다. */
  function isRetiredSource_(name) {
    var t = String(name || '').toLowerCase().replace(/[\s_]+/g, '');
    return t.indexOf('supergrok') !== -1 || t.indexOf('슈퍼그록') !== -1;
  }
  function authorOf_(folderName, parent) {
    var m = AUTHOR_RE.exec(folderName || '');
    if (!m || !parent || !(parent.id === ROOT_FOLDER_ID || parent.name === AUTHOR_PARENT || baseName_(parent.name) === AUTHOR_PARENT)) return null;
    var raw = m[1].trim(), label = AUTHOR_LABEL[raw] || raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    var badge = AUTHOR_BADGE[raw] || (label.length > 6 ? label.slice(0, 6) : label);
    return { id: AUTHOR_ID[raw] || label, label: label, badge: badge, folder: folderName };
  }
  function srcOrder_(src) { return SOURCE_ORDER[src || 'old'] != null ? SOURCE_ORDER[src || 'old'] : 999; }
  var SETTINGS_BASE = '설정과_대화';
  var PREFIXED_RE = /^([A-Za-z]{1,8})(\d+)_(.+)\.md$/i;
  /** 폴더 이름에서 앞 번호('99_')를 뗀 이름: 어느 깊이에 있든 이 이름으로 제외·숨김을 판단한다 */
  function baseName_(n) { return String(n || '').replace(/^\d+_/, ''); }
  var EXCLUDED_BASE = EXCLUDED_FOLDERS.map(baseName_);
  function isExcluded_(name) { return EXCLUDED_FOLDERS.indexOf(name) !== -1 || EXCLUDED_BASE.indexOf(baseName_(name)) !== -1; }
  /** 피드백 색인 키: 기존 글은 번호 그대로('12'), 686 이후 출처별 글은 '686-grok'처럼 출처를 붙인다 */
  function fbKey_(ep) { return ep.key || String(ep.num); }
  var FOLDER_MIME = 'application/vnd.google-apps.folder';
  var LIST_CONCURRENCY = 6;

  // 80 폴더와 그 안 파일 ID 기억 (없어졌으면 다시 찾는다)
  var fbFolderId = null;
  var fileMemo = {};          // 80 폴더 안 파일 이름 -> {id, mimeType, modifiedTime}
  var indexCache = null;      // 이번 실행에서 마지막으로 맞춘 색인
  var indexStampMs = 0;       // 그 색인 파일의 modifiedTime(ms). 더 오래된 목록 응답으로 덮지 않는다
  var lastIndexText = '';
  var lastNorm = {};          // 생성 파일은 '마지막 갱신' 줄만 달라지면 다시 올리지 않는다
  var appliedCache = null;    // 반영_기록.md (앱은 쓰지 않음). 목록을 다시 받기 전까지 재사용
  var episodeCache = {};      // 원본 id -> {ok, text, modified, mime}

  function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
  function mimeFor(name) { return name.slice(-5) === '.json' ? 'application/json' : 'text/markdown'; }

  function pool(items, n, fn) {
    var i = 0, out = new Array(items.length);
    function worker() {
      if (i >= items.length) return Promise.resolve();
      var k = i++;
      return Promise.resolve(fn(items[k], k)).then(function (v) { out[k] = v; return worker(); });
    }
    var ws = [];
    for (var w = 0; w < Math.min(n, items.length); w++) ws.push(worker());
    return Promise.all(ws).then(function () { return out; });
  }

  function listChildren(id) {
    return D.list("'" + esc(id) + "' in parents and trashed = false", 'id, name, mimeType, modifiedTime');
  }

  /**
   * 하위 폴더를 모두 훑어 에피소드 목록, 분류, 피드백 평가를 돌려준다.
   * 폴더 목록은 최대 6개씩 동시에 받아 오고, 받은 결과는 Apps Script와 같은 너비 우선 순서로 다시 훑어
   * 같은 번호의 대표 파일·사본 ID 순서·분류 순서가 Apps Script 판과 똑같이 나오게 한다.
   */
  function getEpisodes() {
    var listings = {}, started = {};
    var fbPromise = null;

    var crawl = new Promise(function (resolve, reject) {
      var queue = [], running = 0, failed = false;
      function schedule(id) { if (started[id]) return; started[id] = true; queue.push(id); }
      function pump() {
        if (failed) return;
        if (!running && !queue.length) { resolve(); return; }
        while (running < LIST_CONCURRENCY && queue.length) {
          (function (id) {
            running++;
            listChildren(id).then(function (files) {
              listings[id] = files;
              files.forEach(function (f) {
                if (f.mimeType !== FOLDER_MIME) return;
                if (isRetiredSource_(f.name)) return;
                if (!isExcluded_(f.name)) schedule(f.id);
                else if (id === ROOT_FOLDER_ID && f.name === FEEDBACK_FOLDER_NAME && !fbPromise) {
                  fbFolderId = f.id;
                  fbPromise = loadFeedbackFolder(f.id);   // 목록 훑는 동안 함께 받아 둔다
                }
              });
              running--; pump();
            }, function (e) { failed = true; reject(e); });
          })(queue.shift());
        }
      }
      schedule(ROOT_FOLDER_ID); pump();
    });

    return crawl.then(function () {
      if (!fbPromise) { fbFolderId = null; fbPromise = Promise.resolve({ index: { version: 1, items: {} }, cand: null, state: null }); }
      var byNumber = {};   // 같은 출처 안에서만 같은 번호를 하나로 합친다 (키: 기존 '12', 출처별 '686-grok')
      var cats = {};
      var queue = [{ id: ROOT_FOLDER_ID, key: '', name: '', src: 'old', srcRoot: false }];
      var seen = {};
      var archive = [];    // 목록에서 빠진 폴더 + 설정과 대화 폴더 (보관 폴더에서 따로 본다)
      var authors = {};    // 작가 ID -> {id, label, badge, folder}
      while (queue.length) {
        var folder = queue.shift();
        if (seen[folder.id]) continue;
        seen[folder.id] = true;
        (listings[folder.id] || []).forEach(function (f) {
          if (f.mimeType === FOLDER_MIME) {
            if (isRetiredSource_(f.name)) return;
            var fpath = (folder.key ? folder.key + '/' : '') + f.name;
            if (!isExcluded_(f.name)) {
              var au = folder.src === 'old' ? authorOf_(f.name, folder) : null;
              if (au && !authors[au.id]) authors[au.id] = au;
              var fsrc = au ? au.id : folder.src;
              queue.push({ id: f.id, key: fpath, name: f.name, src: fsrc, srcRoot: !!au });
              if (baseName_(f.name) === SETTINGS_BASE) {
                // 설정과 대화: 목록에서는 기본으로 숨기지만 보관 폴더에서 언제든 전부 볼 수 있게
                archive.push({ id: f.id, name: f.name, top: false, kind: 'settings', path: fpath, src: fsrc,
                  label: (cleanCategory_(f.name) || f.name) + ' · ' + (au ? au.label : fsrc === 'old' ? SOURCE_LABEL.old : (authors[fsrc] || {}).label || fsrc) });
              }
            } else {
              var top = folder.id === ROOT_FOLDER_ID;
              archive.push({ id: f.id, name: f.name, top: top, kind: 'excluded', path: fpath,
                label: (cleanCategory_(f.name) || f.name) + (top ? '' : ' · ' + (folder.srcRoot ? (authors[folder.src] || {}).label || folder.src : (cleanCategory_(folder.name) || folder.name))) });
            }
            return;
          }
          var src = folder.src;
          if (isRetiredSource_(f.name) || isRetiredSource_(src)) return;
          var m = EPISODE_RE.exec(f.name), num, rawTitle;
          if (m) { num = parseInt(m[1], 10); rawTitle = m[2]; }
          else if (src !== 'old' && (m = PREFIXED_RE.exec(f.name))) { num = parseInt(m[2], 10); rawTitle = m[3]; }
          else return;
          if (num < MIN_EPISODE_NUMBER) return;
          var catKey = folder.key || '(기타)';
          if (!cats[catKey]) {
            cats[catKey] = { key: catKey, name: folder.srcRoot ? authors[src].label : (cleanCategory_(folder.name) || '기타') };
            if (src !== 'old') cats[catKey].src = src;
          }

          var key = src === 'old' ? String(num) : num + '-' + src;
          var prev = byNumber[key];
          if (!prev) {
            byNumber[key] = { id: f.id, ids: [f.id], num: num, title: cleanTitle_(rawTitle), modified: f.modifiedTime, cats: [catKey] };
            if (src !== 'old') { byNumber[key].src = src; byNumber[key].key = key; }
            return;
          }
          if (prev.ids.indexOf(f.id) === -1) prev.ids.push(f.id);
          if (prev.cats.indexOf(catKey) === -1) prev.cats.push(catKey);
          if (f.modifiedTime > prev.modified) {
            prev.id = f.id; prev.title = cleanTitle_(rawTitle); prev.modified = f.modifiedTime;
          }
        });
      }
      // 작가 순서: 폴더 이름순 (기존 글이 먼저)
      var sources = Object.keys(authors).map(function (k) { return authors[k]; })
        .sort(function (a, b) { return a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0; });
      sources.forEach(function (a, i) { SOURCE_ORDER[a.id] = i + 1; SOURCE_LABEL[a.id] = a.label; });
      var episodes = Object.keys(byNumber).map(function (k) { return byNumber[k]; })
        .sort(function (a, b) { return a.num - b.num || srcOrder_(a.src) - srcOrder_(b.src); });
      var categories = Object.keys(cats).sort().map(function (k) { return cats[k]; });
      archive.sort(function (a, b) {
        return ((a.kind === 'settings') - (b.kind === 'settings')) || (b.top - a.top) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      });
      return fbPromise.then(function (fb) {
        var cand = fb.cand || {};
        var mapped = mapLegacyFeedback_(fb.index.items, episodes);
        return {
          episodes: episodes, categories: categories, feedback: mapped.feedback,
          candidates: cand.candidates || {}, keepNovel: cand.keepNovel || {},
          hiddenFolders: DEFAULT_HIDDEN_FOLDERS, state: fb.state,
          legacyFb: mapped.legacy, archive: archive, sources: sources
        };
      });
    });
  }

  /**
   * 예전 색인은 번호만 키로 썼다('686'). 그 번호가 기존 글에 없고 출처별 글에만 있으면,
   * 항목의 파일 ID가 맞는 글(없으면 그 번호의 유일한 글)에 붙인다. 색인 파일은 저장할 때까지 그대로 둔다.
   */
  function mapLegacyFeedback_(items, episodes) {
    var feedback = {}, legacy = {}, byNum = {};
    Object.keys(items).forEach(function (k) { feedback[k] = items[k]; });
    episodes.forEach(function (e) { (byNum[e.num] = byNum[e.num] || []).push(e); });
    Object.keys(items).forEach(function (k) {
      if (!/^\d+$/.test(k)) return;
      var list = byNum[k];
      if (!list || list.some(function (e) { return !e.src; })) return;   // 기존 글이 있으면 그 글의 것
      var it = items[k] || {}, ids = it.ids || [];
      var hit = list.filter(function (e) { return ids.some(function (id) { return e.ids.indexOf(id) !== -1; }); });
      var target = hit.length === 1 ? hit[0] : (!hit.length && list.length === 1 ? list[0] : null);
      if (!target || feedback[target.key]) return;
      feedback[target.key] = it; delete feedback[k]; legacy[target.key] = k;
    });
    return { feedback: feedback, legacy: legacy };
  }

  function firstByName(files, name) {
    for (var i = 0; i < files.length; i++) if (files[i].name === name && files[i].mimeType !== FOLDER_MIME) return files[i];
    return null;
  }
  function loadFeedbackFolder(folderId) {
    return listChildren(folderId).then(function (files) {
      rememberListed_(files);
      var fi = firstByName(files, FEEDBACK_INDEX_NAME), fc = firstByName(files, CANDIDATES_NAME), fs = firstByName(files, STATE_NAME);
      if (fs) stateFile = fs;   // 숨김 전환 때 요청 한 번으로 저장할 수 있게 기억
      var picked = pickUnapplied_(files);
      if (picked) unappliedFile = picked;
      healUnapplied_(files, fi);
      return Promise.all([
        fi ? D.download(fi.id).then(parseIndex_) : { version: 1, items: {} },
        fc ? D.download(fc.id).then(parseJson_, function () { return null; }) : null,
        fs ? D.download(fs.id).then(parseJson_, function () { return null; }) : null
      ]).then(function (r) {
        var serverMs = fi && fi.modifiedTime ? Date.parse(fi.modifiedTime) : 0;
        if (!indexCache || !(indexStampMs && serverMs && serverMs < indexStampMs)) {
          indexCache = r[0];
          lastIndexText = JSON.stringify(indexCache, null, 1);
          if (serverMs) indexStampMs = serverMs;
        }
        return { index: indexCache, cand: r[1], state: r[2] };
      });
    });
  }

  /** 에피소드 원문(마크다운)을 읽어 온다. */
  function getEpisodeContent(fileId) { return D.download(fileId); }

  /**
   * 교정 화면이 고치는 본문과, 그대로 둘 꼬리(독자 반응·재독 피드백)를 나눈다.
   * 꼬리는 첫 독자 반응/정리 메모 제목, 없으면 재독 피드백 표식부터다.
   */
  var META_HEAD_RE = /^(?:-{3,}[ \t]*\r?\n+)?##[ \t]*(정리 메모|독자 반응)[ \t]*$/m;
  function splitEditable_(md) {
    var text = String(md || '');
    var cut = text.length;
    var a = text.indexOf(BLOCK_START);
    if (a !== -1) cut = Math.min(cut, a);
    var m = META_HEAD_RE.exec(text.slice(0, cut));
    if (m) cut = m.index;
    return { body: text.slice(0, cut).replace(/\s+$/, ''), tail: text.slice(cut) };
  }
  function joinEditable_(body, tail) {
    var b = String(body == null ? '' : body).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/, '');
    if (!tail || !String(tail).trim()) return b + '\n';
    return b + '\n\n' + String(tail).replace(/^\s+/, '');
  }
  function freshText_(id) {
    return D.getMeta(id, 'id,name,mimeType,modifiedTime').then(function (meta) {
      return D.download(id).then(function (text) {
        episodeCache[id] = { ok: true, text: text, modified: meta.modifiedTime, mime: meta.mimeType };
        return { text: text, mime: meta.mimeType || 'text/markdown', modified: meta.modifiedTime };
      });
    });
  }
  /**
   * 본문만 바꾼다. 각 사본의 독자 반응·재독 피드백 꼬리는 그 파일 것을 유지한다.
   * ep: { id, ids }
   */
  function saveEpisodeBody(ep, body) {
    var ids = (ep.ids && ep.ids.length) ? ep.ids.slice() : [ep.id];
    if (ids.indexOf(ep.id) === -1) ids.unshift(ep.id);
    return withLock_(function () {
      return Promise.all(ids.map(function (id) {
        return freshText_(id).then(function (cur) {
          var parts = splitEditable_(cur.text);
          var next = joinEditable_(body, parts.tail);
          if (next === cur.text) return { id: id, text: cur.text, modified: cur.modified, same: true };
          return D.update(id, next, cur.mime || 'text/markdown').then(function (r) {
            var modified = (r && r.modifiedTime) || cur.modified;
            episodeCache[id] = { ok: true, text: next, modified: modified, mime: cur.mime };
            if (api.onFileWritten) try { api.onFileWritten(id, next, modified); } catch (e) {}
            return { id: id, text: next, modified: modified, same: false };
          });
        }).catch(function (e) {
          if (id === ep.id) throw e;
          return { id: id, skipped: true };
        });
      })).then(function (rows) {
        var primary = rows[0];
        for (var i = 0; i < rows.length; i++) if (rows[i].id === ep.id) primary = rows[i];
        return { text: primary.text, modified: primary.modified, changed: rows.some(function (r) { return r && !r.same && !r.skipped; }) };
      });
    });
  }

  // ---------- 저장 (한 기기 안에서는 차례대로: LockService 대신) ----------
  var chain = Promise.resolve();
  function withLock_(fn) {
    var p = chain.then(function () { return fn(); });
    chain = p.catch(function () {});
    return p;
  }

  /**
   * 재독 피드백을 저장한다.
   * ep: { num, title, ids, catNames }
   * fb: { rating: 'best'|'like'|'meh'|'dislike'|'', good, bad, kind: 'notnovel'|'novel'|'' }
   */
  function saveFeedback(ep, fb) {
    return withLock_(function () {
      return readIndex_().then(function (idx) {
        return applyItem_(idx, ep, fb).then(function (item) {
          return Promise.all([writeIndex_(idx), writeSummary_(idx)]).then(function () {
            return { ok: true, updated: item ? item.updated : stamp_(), item: item };
          });
        });
      });
    });
  }

  /** 여러 편의 '소설 아님/소설 맞음' 표시를 한꺼번에 바꾼다. 평가와 메모는 유지한다. */
  function saveKinds(eps, kind) {
    return withLock_(function () {
      return readIndex_().then(function (idx) {
        var out = {};
        // 원본 파일 쓰기는 동시에 몇 편씩, 색인 반영 순서는 원래대로 앞에서부터
        return pool(eps, 4, function (ep) {
          var cur = idx.items[fbKey_(ep)] || (ep.legacyKey && idx.items[ep.legacyKey]) || {};
          return applyItem_(idx, ep, { rating: cur.rating || '', good: cur.good || '', bad: cur.bad || '', kind: kind })
            .then(function (item) { out[fbKey_(ep)] = item; });
        }).then(function () {
          return Promise.all([writeIndex_(idx), writeSummary_(idx)]);
        }).then(function () { return { ok: true, items: out }; });
      });
    });
  }

  /** Asia/Seoul 'yyyy-MM-dd HH:mm' (한국은 서머타임이 없어 항상 UTC+9) */
  function stamp_(d) {
    var t = new Date((d ? d.getTime() : Date.now()) + 9 * 3600 * 1000);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) + ' ' + p(t.getUTCHours()) + ':' + p(t.getUTCMinutes());
  }

  /** 색인 항목을 갱신하고 원본 파일(사본 포함) 끝의 관리 구역을 다시 쓴다. */
  function applyItem_(idx, ep, fb) {
    var rating = RATING_LABEL.hasOwnProperty(fb.rating) ? fb.rating : '';
    var kind = fb.kind === 'notnovel' || fb.kind === 'novel' ? fb.kind : '';
    var good = String(fb.good || '').trim();
    var bad = String(fb.bad || '').trim();
    var stamp = stamp_();
    var empty = !rating && !good && !bad && !kind;
    var block = empty ? '' : buildBlock_(rating, good, bad, kind, stamp);

    function writeBlock_(id, text, mime, modified) {
      var next = replaceBlock_(text, block);
      if (next === text) {
        episodeCache[id] = { ok: true, text: text, modified: modified, mime: mime };
        return;
      }
      return D.update(id, next, mime || 'text/markdown').then(function (r) {
        episodeCache[id] = { ok: true, text: next, modified: (r && r.modifiedTime) || modified, mime: mime };
        if (api.onFileWritten) try { api.onFileWritten(id, next, r && r.modifiedTime); } catch (e) {}
      });
    }
    return Promise.all((ep.ids || []).map(function (id) {
      var hit = episodeCache[id];
      // 이번 실행에서 이미 확인한 원본은 메타·본문을 다시 받지 않는다.
      if (hit && hit.ok && hit.text != null) return writeBlock_(id, hit.text, hit.mime, hit.modified);
      return D.getMeta(id, 'id,name,mimeType,modifiedTime').then(function (meta) {
        if (!EPISODE_RE.test(meta.name)) { episodeCache[id] = { ok: false }; return; }
        var cached = episodeCache[id];
        var same = cached && cached.text != null && cached.modified && cached.modified === meta.modifiedTime;
        var textP = same ? Promise.resolve(cached.text) : D.download(id);
        return textP.then(function (text) {
          episodeCache[id] = { text: text, modified: meta.modifiedTime, mime: meta.mimeType };
          return writeBlock_(id, text, meta.mimeType, meta.modifiedTime);
        });
      });
    })).then(function () {
      var key = fbKey_(ep);
      if (ep.legacyKey && ep.legacyKey !== key) delete idx.items[ep.legacyKey];   // 예전 번호 키는 출처 키로 옮긴다
      if (empty) { delete idx.items[key]; return null; }
      idx.items[key] = {
        num: ep.num, title: ep.title, ids: ep.ids, cats: ep.catNames || [],
        rating: rating, good: good, bad: bad, kind: kind, updated: stamp
      };
      if (ep.src && ep.src !== 'old') idx.items[key].src = ep.src;
      return idx.items[key];
    });
  }

  /** 리더가 이미 받아 둔 본문. modified가 같으면 저장 때 원본을 다시 받지 않는다. */
  function noteEpisodeText(id, text, modified) {
    if (!id || text == null) return;
    var hit = episodeCache[id];
    if (hit && hit.ok && hit.text != null && (!modified || hit.modified === modified)) return;
    episodeCache[id] = { text: text, modified: modified || '', mime: hit && hit.mime };
  }
  function dropEpisodeText(id) { if (id) delete episodeCache[id]; else episodeCache = {}; }

  /** 마지막으로 읽은 화를 80 폴더의 reader_state.json에 저장해 휴대폰과 PC가 공유하게 한다. */
  var stateFile = null;
  function saveLastRead(state, opts) {
    var text = JSON.stringify({ version: 1, lastRead: state, saved: stamp_() }, null, 1);
    if (stateFile) {
      return D.update(stateFile.id, text, stateFile.mimeType || 'application/json', opts).catch(function (e) {
        if (e && e.status === 404) { stateFile = null; return saveLastRead(state); }
        throw e;
      });
    }
    return withLock_(function () {
      return writeFile_(STATE_NAME, text).then(function (f) { stateFile = f; });
    });
  }
  function getLastRead() {
    return readJson_(STATE_NAME).then(function (d) { return d && d.lastRead ? d.lastRead : null; });
  }

  // ---------- 원본 파일의 재독 피드백 구역 ----------

  function buildBlock_(rating, good, bad, kind, stamp) {
    var lines = [BLOCK_START, '', '## 재독 피드백', ''];
    if (kind === 'notnovel') lines.push('- 분류 표시: 소설 아님 (설정·잡담 등 대화 기록이라 소설 목록에서 제외)');
    if (kind === 'novel') lines.push('- 분류 표시: 소설 맞음 (자동 분류와 상관없이 소설 목록에 표시)');
    if (rating) lines.push('- 평가: ' + RATING_LABEL[rating]);
    lines.push('- 기록: ' + stamp + ' (다시 읽으며 남긴 사용자 피드백)', '');
    if (rating || good || bad) {
      lines.push('### 좋았던 점', '', good || '(없음)', '');
      lines.push('### 아쉬웠던 점', '', bad || '(없음)', '');
    }
    lines.push(BLOCK_END);
    return lines.join('\n');
  }

  function replaceBlock_(text, block) {
    var s = text.indexOf(BLOCK_START);
    var e = text.indexOf(BLOCK_END);
    var base = text;
    if (s !== -1 && e !== -1 && e > s) {
      base = text.slice(0, s) + text.slice(e + BLOCK_END.length);
    }
    base = base.replace(/\s+$/, '');
    if (!block) return base + '\n';
    return base + '\n\n' + block + '\n';
  }

  // ---------- 피드백 색인·모음 파일 ----------

  var folderLookup = null, folderCreate = null;
  function findFolder_(create) {
    if (fbFolderId) return Promise.resolve(fbFolderId);
    if (!folderLookup) {
      folderLookup = D.list("'" + esc(ROOT_FOLDER_ID) + "' in parents and name = '" + esc(FEEDBACK_FOLDER_NAME) + "' and mimeType = '" + FOLDER_MIME + "' and trashed = false", 'id, name')
        .then(function (r) {
          folderLookup = null;
          if (r.length) fbFolderId = r[0].id;
          return fbFolderId || null;
        }, function (e) { folderLookup = null; throw e; });
    }
    return folderLookup.then(function (id) {
      if (id) return id;
      if (!create) return null;
      if (fbFolderId) return fbFolderId;
      if (!folderCreate) {
        folderCreate = D.createFolder(FEEDBACK_FOLDER_NAME, ROOT_FOLDER_ID).then(function (f) {
          folderCreate = null;
          return (fbFolderId = f.id);
        }, function (e) { folderCreate = null; throw e; });
      }
      return folderCreate;
    });
  }
  /** findFile_(name)와 같음: 80 폴더 안 같은 이름 파일. 한 번 찾은 ID는 다시 목록을 받지 않는다. */
  function rememberListed_(files) {
    var grouped = {};
    (files || []).forEach(function (f) {
      if (!f || f.mimeType === FOLDER_MIME) return;
      (grouped[f.name] = grouped[f.name] || []).push(f);
    });
    Object.keys(grouped).forEach(function (name) {
      var list = grouped[name];
      var picked = name === UNAPPLIED_NAME ? pickUnapplied_(list) : list[0];
      if (!picked) return;
      var prev = fileMemo[name];
      if (prev && prev.id !== picked.id) {
        if (name === APPLIED_LOG_NAME) appliedCache = null;
        prev = null;
      }
      if (prev && prev.modifiedTime && picked.modifiedTime && prev.modifiedTime !== picked.modifiedTime && name === APPLIED_LOG_NAME) appliedCache = null;
      if (!prev) fileMemo[name] = picked;
      else if (picked.modifiedTime) prev.modifiedTime = picked.modifiedTime;
      if (name === UNAPPLIED_NAME) unappliedFile = fileMemo[name];
    });
  }
  function findFile_(name) {
    if (name === UNAPPLIED_NAME) return findUnapplied_();
    if (fileMemo[name]) return Promise.resolve(fileMemo[name]);
    return findFolder_(false).then(function (folder) {
      if (!folder) return null;
      return D.list("'" + esc(folder) + "' in parents and name = '" + esc(name) + "' and mimeType != '" + FOLDER_MIME + "' and trashed = false", 'id, name, mimeType, modifiedTime')
        .then(function (r) {
          if (r[0]) fileMemo[name] = r[0];
          return r[0] || null;
        }, function (e) {
          if (e && e.status === 404) { fbFolderId = null; delete fileMemo[name]; return findFile_(name); }
          throw e;
        });
    });
  }
  /** 없으면 폴더·파일을 만든다. 404면 ID를 버리고 한 번만 다시 찾는다. */
  function writeFile_(name, text, retried) {
    return findFile_(name).then(function (f) {
      if (f) {
        return D.update(f.id, text, f.mimeType || mimeFor(name)).then(function (r) {
          if (r && r.modifiedTime) f.modifiedTime = r.modifiedTime;
          fileMemo[name] = f;
          return f;
        }, function (e) {
          if (e && e.status === 404 && !retried) { delete fileMemo[name]; if (name === UNAPPLIED_NAME) unappliedFile = null; return writeFile_(name, text, true); }
          throw e;
        });
      }
      return findFolder_(true).then(function (folder) {
        return D.create(name, folder, text, mimeFor(name)).then(function (nf) { fileMemo[name] = nf; return nf; });
      });
    });
  }

  function parseIndex_(s) {
    try {
      var data = JSON.parse(s || '{}');
      if (!data.items) data.items = {};
      return data;
    } catch (e) {
      return { version: 1, items: {} };
    }
  }
  function parseJson_(s) { try { return JSON.parse(s || 'null'); } catch (e) { return null; } }

  /** 색인을 읽는다. 이번 실행에서 이미 맞춘 색인이 있으면 다시 받지 않는다. 네트워크 오류는 그대로 던진다. */
  function readIndex_() {
    if (indexCache) return Promise.resolve(indexCache);
    return findFile_(FEEDBACK_INDEX_NAME).then(function (f) {
      if (!f) {
        indexCache = { version: 1, items: {} };
        lastIndexText = JSON.stringify(indexCache, null, 1);
        return indexCache;
      }
      return D.download(f.id).then(function (s) {
        if (indexCache && indexStampMs) return indexCache;
        indexCache = parseIndex_(s);
        lastIndexText = JSON.stringify(indexCache, null, 1);
        if (f.modifiedTime) indexStampMs = Date.parse(f.modifiedTime) || indexStampMs;
        return indexCache;
      });
    });
  }

  function readJson_(name) {
    return findFile_(name).then(function (f) {
      if (!f) return null;
      return D.download(f.id).then(parseJson_);
    });
  }

  function writeIndex_(idx) {
    var text = JSON.stringify(idx, null, 1);
    indexCache = idx;
    if (text === lastIndexText && fileMemo[FEEDBACK_INDEX_NAME]) return Promise.resolve(fileMemo[FEEDBACK_INDEX_NAME]);
    return writeFile_(FEEDBACK_INDEX_NAME, text).then(function (f) {
      lastIndexText = text;
      indexStampMs = f && f.modifiedTime ? (Date.parse(f.modifiedTime) || Date.now()) : Date.now();
      return f;
    });
  }

  function buildSummary_(idx) {
    var all = Object.keys(idx.items).filter(function (k) {
      return !isRetiredSource_(k) && !isRetiredSource_(idx.items[k] && idx.items[k].src);
    }).map(function (k) { return idx.items[k]; });
    var bySrc = function (a, b) { return a.num - b.num || srcOrder_(a.src) - srcOrder_(b.src); };
    var srcTag = function (x) { return x.src && x.src !== 'old' ? ' (' + (SOURCE_LABEL[x.src] || x.src) + ')' : ''; };
    var notNovel = all.filter(function (x) { return x.kind === 'notnovel'; }).sort(bySrc);
    var items = all.filter(function (x) { return x.kind !== 'notnovel' && (x.rating || x.good || x.bad); });
    var byRating = function (r) {
      return items.filter(function (x) { return x.rating === r; })
        .sort(bySrc);
    };
    var stamp = stamp_();
    var out = [
      '# 독자 재독 피드백 모음',
      '',
      '> 에피소드 리더 앱이 자동으로 만드는 파일이다. 직접 수정하지 말 것(다음 저장 때 덮어써짐).',
      '> 마지막 갱신: ' + stamp + ' · 피드백 ' + items.length + '편',
      '',
      '## 생성 에이전트(ChatGPT·Grok) 참고 방법',
      '',
      '- **피드백 반영은 먼저 같은 폴더의 `' + UNAPPLIED_NAME + '`만 읽는다.** 마지막 반영 이후 새로 남기거나 고친 피드백만 들어 있어 짧다. 이 전체 모음은 지난 피드백을 다시 찾아볼 때만 연다.',
      '- 반영을 마치면 `' + APPLIED_LOG_NAME + '` 맨 아래에 `반영완료:` 줄을 덧붙인다. 작가는 자기 이름만 적고, 그 줄은 그 작가의 편만 인박스에서 뺀다(형식은 미반영 파일 머리말 참고).',
      '- 사용자가 지난 글을 다시 읽으며 뒤늦게 남긴 평가다. 당시 대화의 반응보다 이 재독 피드백이 더 최신 판단이다.',
      '- `⭐ 최고`와 `👍 좋아요`의 **좋았던 점**은 살리고, 모든 편의 **아쉬웠던 점**과 `👎 별로` 편의 패턴은 반복하지 않는다.',
      '- `😐 평범`은 나쁘지는 않지만 인상이 약했던 편이다. **좋았던 점**은 살리고, **아쉬웠던 점**과 메모에서 무엇이 밋밋했는지 찾아 다음 편에서 보완한다. 폐기하거나 피할 대상은 아니다.',
      '- 같은 내용이 각 원본 파일 맨 끝 `## 재독 피드백`에도 들어 있다.',
      '- 맨 아래 `소설 아님` 목록은 설정·잡담 등 대화 기록이라 소설 참고 자료에서 제외한 번호다.',
      ''
    ];
    [['best', '⭐ 최고'], ['like', '👍 좋아요'], ['meh', '😐 평범'], ['dislike', '👎 별로'], ['', '평가 없이 메모만']].forEach(function (g) {
      var list = byRating(g[0]);
      if (!list.length) return;
      out.push('## ' + g[1] + ' (' + list.length + '편)', '');
      list.forEach(function (x) {
        var cat = x.cats && x.cats.length ? ' · ' + x.cats.join(', ') : '';
        out.push('### ' + pad3_(x.num) + '. ' + x.title + srcTag(x), '');
        out.push('- 분류' + (cat ? ':' + cat.slice(2) : ': -'));
        out.push('- 기록: ' + x.updated);
        if (x.good) out.push('- 좋았던 점: ' + oneBlock_(x.good));
        if (x.bad) out.push('- 아쉬웠던 점: ' + oneBlock_(x.bad));
        out.push('');
      });
    });
    if (notNovel.length) {
      out.push('## 소설 아님으로 표시한 글 (' + notNovel.length + '편)', '');
      notNovel.forEach(function (x) { out.push('- ' + pad3_(x.num) + '. ' + x.title + srcTag(x)); });
      out.push('');
    }
    return out.join('\n');
  }
  function stampless_(text) { return String(text || '').replace(/^> 마지막 갱신:.*$/gm, '> 마지막 갱신:'); }
  function writeGenerated_(name, text) {
    var norm = stampless_(text);
    if (lastNorm[name] === norm && fileMemo[name]) return Promise.resolve(fileMemo[name]);
    return writeFile_(name, text).then(function (f) { lastNorm[name] = norm; return f; });
  }
  function writeSummary_(idx) {
    return Promise.all([
      writeGenerated_(FEEDBACK_SUMMARY_NAME, buildSummary_(idx)),
      writeUnapplied_(idx)
    ]);
  }

  // ---------- 미반영 피드백 (반영_기록.md는 읽기만) ----------

  /** 'yyyy-MM-dd HH:mm'(한국 시각) → 분 단위 시각(ms). 형식이 아니면 null */
  function kstMs_(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || '').trim());
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 9 * 3600 * 1000;
  }
  /**
   * 반영완료 줄의 작가. 작가가 없거나 전체/알 수 없으면 all.
   * ChatGPT·GPT → gpt, Grok·그록·그록봇 → grok, 기존 → old.
   * SuperGrok·슈퍼그록은 그록으로 세지 않는다.
   */
  function writerKey_(label) {
    var t = String(label || '').trim().toLowerCase();
    if (!t || t === '전체' || t === 'all' || t === '공통') return 'all';
    if (t.indexOf('chatgpt') !== -1 || t === 'gpt' || t.indexOf('지피티') !== -1) return 'gpt';
    if (isRetiredSource_(t)) return 'retired';
    if (t.indexOf('grok') !== -1 || t.indexOf('그록') !== -1) return 'grok';
    if (t.indexOf('기존') !== -1 || t === 'old') return 'old';
    return 'all';
  }
  function srcKey_(src) {
    return (src === 'gpt' || src === 'grok' || src === 'old') ? src : 'all';
  }
  /** 반영_기록.md의 반영완료 시각. all은 작가: 전체(또는 작가 없음)의 가장 늦은 시각. */
  function appliedMarks_(text) {
    var re = /^[ \t]*(?:[-*][ \t]+)?반영완료[ \t]*:[ \t]*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?[ \t]*(Z|[+-]\d{2}:?\d{2})?(.*)$/gm;
    var marks = { all: null, gpt: null, grok: null, old: null };
    var s = String(text || '').replace(/\r/g, ''), m;
    while ((m = re.exec(s))) {
      var off = 9 * 60;
      if (m[6] === 'Z') off = 0;
      else if (m[6]) { var z = m[6].replace(':', ''); off = (z[0] === '-' ? -1 : 1) * (parseInt(z.slice(1, 3), 10) * 60 + parseInt(z.slice(3, 5), 10)); }
      var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - off * 60000;
      var wm = /작가[ \t]*:[ \t]*([^|]+)/.exec(m[7] || '');
      var key = writerKey_(wm ? wm[1] : '');
      if (marks[key] == null || ms > marks[key]) marks[key] = ms;
    }
    return marks;
  }
  /** 그 작가 시각과 전체 기준 중 더 늦은 분. 둘 다 없으면 null. */
  function cutoffFor_(src, marks) {
    var key = srcKey_(src);
    var own = key === 'all' ? null : marks[key];
    var floor = marks.all;
    if (own == null) return floor;
    if (floor == null) return own;
    return own > floor ? own : floor;
  }
  /**
   * 가장 늦은 반영완료 시각(작가 구분 없이). 옛 호출 호환.
   */
  function latestAppliedMark_(text) {
    var marks = appliedMarks_(text);
    var best = marks.all;
    ['gpt', 'grok', 'old'].forEach(function (k) {
      if (marks[k] != null && (best == null || marks[k] > best)) best = marks[k];
    });
    return best;
  }
  function markLabel_(ms) { return ms == null ? '없음' : stamp_(new Date(ms)); }
  /**
   * 미반영 피드백. 각 편은 그 작가의 마지막 반영완료와 '작가: 전체' 기준 중 더 늦은 시각 이후(같은 분 포함)만 넣는다.
   * 한 작가의 반영완료가 다른 작가 편을 지우지 않는다. 기록 시각이 없는 항목은 반영 기록이 하나도 없을 때만 넣는다.
   */
  function buildUnapplied_(idx, logText) {
    var marks = appliedMarks_(logText);
    var bySrc = function (a, b) { return a.num - b.num || srcOrder_(a.src) - srcOrder_(b.src); };
    var author = function (x) { return x.src && x.src !== 'old' ? (SOURCE_LABEL[x.src] || x.src) : SOURCE_LABEL.old; };
    var items = Object.keys(idx.items).filter(function (k) {
      return !isRetiredSource_(k) && !isRetiredSource_(idx.items[k] && idx.items[k].src);
    }).map(function (k) { return idx.items[k]; }).filter(function (x) {
      if (x.kind === 'notnovel' || !(x.rating || x.good || x.bad)) return false;
      var cut = cutoffFor_(x.src, marks);
      var t = kstMs_(x.updated);
      if (cut === null) return true;
      return t !== null && t >= cut;
    }).sort(bySrc);
    var out = [
      '# 미반영 재독 피드백',
      '',
      '> 에피소드 리더 앱이 자동으로 만드는 파일이다. 직접 수정하지 말 것(피드백을 저장할 때마다 덮어써짐).',
      '> 마지막 갱신: ' + stamp_() + ' · 미반영 피드백 ' + items.length + '편',
      '> 기준: 전체 ' + markLabel_(marks.all) + ' · ChatGPT ' + markLabel_(marks.gpt) + ' · Grok ' + markLabel_(marks.grok) + ' · 기존 ' + markLabel_(marks.old),
      '> 각 편은 그 작가의 마지막 반영완료와 전체 기준 중 더 늦은 시각 이후(같은 분 포함)만 남긴다.',
      '',
      '## 생성 에이전트 사용 방법',
      '',
      '- ChatGPT는 `## ChatGPT`만, Grok은 `## Grok`만 읽고 반영한다. 다른 작가 절은 읽지 않고, 규칙에도 올리지 않는다.',
      '- 반영을 마치면 `' + APPLIED_LOG_NAME + '` 맨 아래에 한 줄을 덧붙인다. 예: `반영완료: 2026-10-20T09:30+09:00 | 작가: Grok | 반영 편: 771, 772`',
      '- 그 줄의 작가는 자기 이름만 쓴다. ChatGPT 또는 Grok. 다른 작가의 편 번호를 적지 않는다. `작가: 전체`는 모든 작가의 기준 시각을 올리므로 지예가 말할 때만 쓴다.',
      '- 앱은 반영 기록을 읽기만 하고, 다음에 피드백을 저장할 때 이 파일을 다시 만든다. 자기 작가 시각 전에 기록된 그 작가의 편만 빠진다. 다른 작가 편은 남는다.',
      '- 다른 작가 블록을 이 파일에서 지우지 않는다. 상세 아카이브도 만들지 않는다. 원본은 각 에피소드 하단 `## 독자 반응`이다.',
      '- 평가: `⭐ 최고`·`👍 좋아요`는 좋았던 점을 살리고, `👎 별로`는 같은 패턴을 반복하지 않는다.',
      '- `😐 평범`은 나쁘지는 않지만 인상이 약했던 편이다. **좋았던 점**은 살리고, **아쉬웠던 점**과 메모에서 무엇이 밋밋했는지 찾아 다음 편에서 보완한다. 폐기하거나 피할 대상은 아니다.',
      '- 같은 내용이 각 원본 파일 맨 끝 `## 재독 피드백` 구역에도 있다. 그 구역(재독피드백 표시 사이)은 앱이 관리하므로 고치지 않는다.',
      ''
    ];
    if (!items.length) { out.push('(미반영 피드백 없음)', ''); return out.join('\n'); }
    var buckets = { gpt: [], grok: [], old: [], other: [] };
    items.forEach(function (x) {
      var k = srcKey_(x.src);
      if (buckets[k]) buckets[k].push(x);
      else buckets.other.push(x);
    });
    [['gpt', 'ChatGPT'], ['grok', 'Grok'], ['old', '기존'], ['other', '기타']].forEach(function (g) {
      var list = buckets[g[0]];
      if (!list.length) return;
      out.push('## ' + g[1] + ' (' + list.length + '편)', '');
      list.forEach(function (x) { pushUnappliedItem_(out, x, author); });
    });
    return out.join('\n');
  }
  function pushUnappliedItem_(out, x, author) {
    out.push('### ' + pad3_(x.num) + '. ' + x.title + (x.src && x.src !== 'old' ? ' (' + author(x) + ')' : ''), '');
    out.push('- 작가: ' + author(x));
    out.push('- 평가: ' + (RATING_LABEL[x.rating || ''] || RATING_LABEL['']));
    out.push('- 분류: ' + (x.cats && x.cats.length ? x.cats.join(', ') : '-'));
    out.push('- 드라이브 파일 ID: ' + ((x.ids || []).join(', ') || '-'));
    out.push('- 기록: ' + (x.updated || '(시각 없음)'));
    out.push('- 좋았던 점: ' + (x.good ? oneBlock_(x.good) : '(없음)'));
    out.push('- 아쉬웠던 점: ' + (x.bad ? oneBlock_(x.bad) : '(없음)'));
    if (x.memo) out.push('- 메모: ' + oneBlock_(String(x.memo)));
    out.push('');
  }
  // 미반영 파일은 한 번 찾은 ID를 계속 쓴다. 같은 이름이 여러 개면 기억한 ID → 가장 먼저 만든 파일 순으로 고른다(새로 만들지 않음).
  var unappliedFile = null;
  function pickUnapplied_(list) {
    var same = (list || []).filter(function (f) { return f.name === UNAPPLIED_NAME && f.mimeType !== FOLDER_MIME; });
    if (!same.length) return null;
    if (unappliedFile) for (var i = 0; i < same.length; i++) if (same[i].id === unappliedFile.id) return same[i];
    same.sort(function (a, b) {
      var ca = a.createdTime || '', cb = b.createdTime || '';
      return ca < cb ? -1 : ca > cb ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    return same[0];
  }
  function findUnapplied_() {
    if (unappliedFile) return Promise.resolve(unappliedFile);
    if (fileMemo[UNAPPLIED_NAME]) return Promise.resolve(unappliedFile = fileMemo[UNAPPLIED_NAME]);
    return findFolder_(false).then(function (folder) {
      if (!folder) return null;
      return D.list("'" + esc(folder) + "' in parents and name = '" + esc(UNAPPLIED_NAME) + "' and mimeType != '" + FOLDER_MIME + "' and trashed = false", 'id, name, mimeType, createdTime, modifiedTime')
        .then(function (list) {
          var picked = pickUnapplied_(list);
          if (picked) { unappliedFile = picked; fileMemo[UNAPPLIED_NAME] = picked; }
          return picked;
        }, function (e) {
          if (e && e.status === 404) { fbFolderId = null; return findUnapplied_(); }
          throw e;
        });
    });
  }
  /**
   * 목록을 불러올 때 미반영 파일이 없거나, 색인·반영 기록보다 오래됐으면 뒤에서 다시 만든다.
   * 본문이 같으면(갱신 시각만 다르면) 올리지 않는다. 그 시각 조합은 이 기기에 기억해 다음 실행에서 다시 받지 않는다.
   * 목록 표시는 기다리지 않고, 실패해도 다음 저장 때 다시 쓴다.
   */
  var HEAL_LS = 'reader.unappliedHeal';
  var healing = null;
  function healSig_(fi, uf, logFile) {
    return [(fi && fi.modifiedTime) || '', (uf && uf.modifiedTime) || '', (logFile && logFile.modifiedTime) || ''].join('|');
  }
  function healSeen_(sig) {
    try { return global.localStorage.getItem(HEAL_LS) === sig; } catch (e) { return false; }
  }
  function healMark_(sig) {
    try { global.localStorage.setItem(HEAL_LS, sig); } catch (e) {}
  }
  function shouldHeal_(fi, uf, logFile) {
    if (!uf || !uf.modifiedTime) return true;
    var ufMs = Date.parse(uf.modifiedTime) || 0;
    var idxMs = fi && fi.modifiedTime ? (Date.parse(fi.modifiedTime) || 0) : 0;
    if (!idxMs || idxMs > ufMs) return true;
    if (logFile && logFile.modifiedTime && (Date.parse(logFile.modifiedTime) || 0) > ufMs) return true;
    return false;
  }
  function healUnapplied_(files, fi) {
    if (!fi || healing) return;
    var uf = pickUnapplied_(files);
    var logFile = firstByName(files, APPLIED_LOG_NAME);
    if (!shouldHeal_(fi, uf, logFile)) return;
    var sig = healSig_(fi, uf, logFile);
    if (uf && healSeen_(sig)) return;
    healing = withLock_(function () {
      return readIndex_().then(function (idx) {
        return readAppliedLog_().then(function (log) {
          var text = buildUnapplied_(idx, log);
          var norm = stampless_(text);
          function wrote(f) {
            if (f) { unappliedFile = f; fileMemo[UNAPPLIED_NAME] = f; }
            return f;
          }
          if (!uf) return writeGenerated_(UNAPPLIED_NAME, text).then(wrote);
          return D.download(uf.id).then(function (old) {
            if (stampless_(old) === norm) {
              lastNorm[UNAPPLIED_NAME] = norm;
              unappliedFile = uf;
              fileMemo[UNAPPLIED_NAME] = uf;
              healMark_(sig);
              return uf;
            }
            return writeGenerated_(UNAPPLIED_NAME, text).then(wrote);
          }, function () { return writeGenerated_(UNAPPLIED_NAME, text).then(wrote); });
        });
      });
    }).then(function () { if (api.onUnappliedHealed) try { api.onUnappliedHealed(); } catch (e) {} }, function (e) {
      if (global.console) console.warn('미반영_피드백.md 갱신 실패', e);
    }).then(function () { healing = null; });
  }
  function readAppliedLog_() {
    return findFile_(APPLIED_LOG_NAME).then(function (f) {
      if (!f) { appliedCache = { id: '', modified: '', text: '' }; return ''; }
      if (appliedCache && appliedCache.id === f.id && appliedCache.modified === (f.modifiedTime || '') && appliedCache.text != null) return appliedCache.text;
      return D.download(f.id).then(function (t) {
        appliedCache = { id: f.id, modified: f.modifiedTime || '', text: t || '' };
        return appliedCache.text;
      });
    });
  }
  /** 항상 같은 파일 ID를 덮어쓴다. 없을 때만 새로 만든다. 본문이 같으면(갱신 시각만 달라도) 올리지 않는다. */
  function writeUnapplied_(idx) {
    return readAppliedLog_().then(function (log) {
      return writeGenerated_(UNAPPLIED_NAME, buildUnapplied_(idx, log)).then(function (f) {
        if (f) { unappliedFile = f; fileMemo[UNAPPLIED_NAME] = f; }
        return f;
      });
    });
  }

  function oneBlock_(t) {
    // 여러 줄 메모를 목록 안에서 깨지지 않게 들여쓴다.
    return t.replace(/\r/g, '').split('\n').join('\n  ');
  }
  function pad3_(n) {
    var s = String(n);
    return s.length > 3 ? s : ('00' + s).slice(-3);
  }

  // ---------- 보관 폴더 (설정집 마크다운·텍스트만 같은 파일에 저장) ----------
  var ARCHIVE_FIELDS = 'id, name, mimeType, modifiedTime, size';
  function listArchiveFolder(id) {
    return D.list("'" + esc(id) + "' in parents and trashed = false", ARCHIVE_FIELDS).then(function (files) {
      var coll = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
      return files.slice().sort(function (a, b) {
        var fa = a.mimeType === FOLDER_MIME, fb2 = b.mimeType === FOLDER_MIME;
        if (fa !== fb2) return fa ? -1 : 1;
        return coll.compare(a.name, b.name);
      });
    });
  }
  /** 보관 폴더의 파일 내용: 구글 문서는 일반 텍스트로 내보내고, 나머지는 그대로 받는다. */
  function getArchiveContent(file) {
    if (file.mimeType === 'application/vnd.google-apps.document') return D.exportText(file.id, 'text/plain');
    return D.download(file.id);
  }
  function archiveTextMime_(file, metaMime) {
    var mt = metaMime || (file && file.mimeType) || '';
    if (/^text\//.test(mt)) return mt;
    var n = String((file && file.name) || '').toLowerCase();
    if (/\.(md|markdown)$/.test(n)) return 'text/markdown';
    return 'text/plain';
  }
  /** 고치기 직전에 최신 본문과 수정 시각을 함께 받는다. */
  function peekArchive(file) {
    return D.getMeta(file.id, 'id,name,mimeType,modifiedTime').then(function (meta) {
      return getArchiveContent(file).then(function (text) {
        return { text: text, modified: (meta && meta.modifiedTime) || '', mime: archiveTextMime_(file, meta && meta.mimeType) };
      });
    });
  }
  /**
   * 설정 파일 내용만 같은 ID로 덮어쓴다. 새 파일을 만들지 않는다.
   * file.modified가 있고 그 사이 드라이브에서 바뀌었으면 conflict로 거절한다.
   */
  function saveArchiveText(file, text) {
    return withLock_(function () {
      return D.getMeta(file.id, 'id,name,mimeType,modifiedTime').then(function (meta) {
        if (file.modified && meta.modifiedTime && meta.modifiedTime !== file.modified) {
          var err = new Error('다른 곳에서 먼저 수정됨');
          err.conflict = true;
          throw err;
        }
        var mime = archiveTextMime_(file, meta && meta.mimeType);
        return D.update(file.id, text, mime).then(function (r) {
          return { changed: true, modified: (r && r.modifiedTime) || '' };
        });
      });
    });
  }

  function cleanTitle_(raw) {
    var t = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/[.\s]+$/, '').trim();
    return t || '(제목 없음)';
  }
  function cleanCategory_(folderName) {
    if (!folderName) return '';
    return folderName.replace(/^\d+_/, '').replace(/_/g, ' ').replace(/\s*\(.*\)\s*$/, '').trim();
  }

  var api = {
    BLOCK_START: BLOCK_START, BLOCK_END: BLOCK_END, ROOT_FOLDER_ID: ROOT_FOLDER_ID,
    getEpisodes: getEpisodes, getEpisodeContent: getEpisodeContent, saveEpisodeBody: saveEpisodeBody,
    splitEditable: splitEditable_, joinEditable: joinEditable_,
    listArchiveFolder: listArchiveFolder, getArchiveContent: getArchiveContent, peekArchive: peekArchive, saveArchiveText: saveArchiveText,
    SOURCE_LABEL: SOURCE_LABEL, baseName: baseName_, fbKey: fbKey_, retiredSource: isRetiredSource_,
    saveFeedback: saveFeedback, saveKinds: saveKinds, saveLastRead: saveLastRead, getLastRead: getLastRead,
    noteEpisodeText: noteEpisodeText, dropEpisodeText: dropEpisodeText,
    stamp: stamp_, buildBlock: buildBlock_, replaceBlock: replaceBlock_, buildSummary: buildSummary_, buildUnapplied: buildUnapplied_, latestAppliedMark: latestAppliedMark_,
    hasStateFile: function () { return !!stateFile; },
    onFileWritten: null, onUnappliedHealed: null,
    healingDone: function () { return healing || Promise.resolve(); }
  };
  global.Core = api;
})(window);
