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
  var EXCLUDED_FOLDERS = ['00_GROK_시작', '01_AI읽기용_통합본', '03_원본_백업', '99_폐기', '80_독자_피드백'];
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
  var RATING_LABEL = { best: '⭐ 최고', like: '👍 좋아요', dislike: '👎 별로', '': '평가 없음' };

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
      var fi = firstByName(files, FEEDBACK_INDEX_NAME), fc = firstByName(files, CANDIDATES_NAME), fs = firstByName(files, STATE_NAME);
      if (fs) stateFile = fs;   // 숨김 전환 때 요청 한 번으로 저장할 수 있게 기억
      healUnapplied_(files, fi);
      return Promise.all([
        fi ? D.download(fi.id).then(parseIndex_) : { version: 1, items: {} },
        fc ? D.download(fc.id).then(parseJson_, function () { return null; }) : null,
        fs ? D.download(fs.id).then(parseJson_, function () { return null; }) : null
      ]).then(function (r) { return { index: r[0], cand: r[1], state: r[2] }; });
    });
  }

  /** 에피소드 원문(마크다운)을 읽어 온다. */
  function getEpisodeContent(fileId) { return D.download(fileId); }

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
   * fb: { rating: 'best'|'like'|'dislike'|'', good, bad, kind: 'notnovel'|'novel'|'' }
   */
  function saveFeedback(ep, fb) {
    return withLock_(function () {
      return readIndex_().then(function (idx) {
        return applyItem_(idx, ep, fb).then(function (item) {
          return writeIndex_(idx).then(function () { return writeSummary_(idx); }).then(function () {
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
          return writeIndex_(idx).then(function () { return writeSummary_(idx); });
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

    return Promise.all((ep.ids || []).map(function (id) {
      return D.getMeta(id, 'id,name,mimeType').then(function (meta) {
        if (!EPISODE_RE.test(meta.name)) return;
        return D.download(id).then(function (text) {
          var next = replaceBlock_(text, block);
          if (next === text) return;
          return D.update(id, next, meta.mimeType || 'text/markdown').then(function (r) {
            if (api.onFileWritten) try { api.onFileWritten(id, next, r && r.modifiedTime); } catch (e) {}
          });
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

  function findFolder_(create) {
    if (fbFolderId) return Promise.resolve(fbFolderId);
    return D.list("'" + esc(ROOT_FOLDER_ID) + "' in parents and name = '" + esc(FEEDBACK_FOLDER_NAME) + "' and mimeType = '" + FOLDER_MIME + "' and trashed = false", 'id, name')
      .then(function (r) {
        if (r.length) return (fbFolderId = r[0].id);
        if (!create) return null;
        return D.createFolder(FEEDBACK_FOLDER_NAME, ROOT_FOLDER_ID).then(function (f) { return (fbFolderId = f.id); });
      });
  }
  /** findFile_(name, false)와 같음: 80 폴더 안 같은 이름 파일 (매번 새로 찾는다) */
  function findFile_(name) {
    return findFolder_(false).then(function (folder) {
      if (!folder) return null;
      return D.list("'" + esc(folder) + "' in parents and name = '" + esc(name) + "' and mimeType != '" + FOLDER_MIME + "' and trashed = false", 'id, name, mimeType')
        .then(function (r) { return r[0] || null; }, function (e) {
          if (e && e.status === 404) { fbFolderId = null; return findFile_(name); }
          throw e;
        });
    });
  }
  /** findFile_(name, true).setContent(text)와 같음: 없으면 폴더·파일을 만든다 */
  function writeFile_(name, text) {
    return findFile_(name).then(function (f) {
      if (f) return D.update(f.id, text, f.mimeType || mimeFor(name)).then(function () { return f; });
      return findFolder_(true).then(function (folder) { return D.create(name, folder, text, mimeFor(name)); });
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

  /** 색인을 읽는다. 내용이 깨졌으면 빈 색인(원본과 같음). 단, 네트워크 오류는 저장을 멈추도록 그대로 던진다. */
  function readIndex_() {
    return findFile_(FEEDBACK_INDEX_NAME).then(function (f) {
      if (!f) return { version: 1, items: {} };
      return D.download(f.id).then(parseIndex_);
    });
  }

  function readJson_(name) {
    return findFile_(name).then(function (f) {
      if (!f) return null;
      return D.download(f.id).then(parseJson_);
    });
  }

  function writeIndex_(idx) {
    return writeFile_(FEEDBACK_INDEX_NAME, JSON.stringify(idx, null, 1));
  }

  function buildSummary_(idx) {
    var all = Object.keys(idx.items).map(function (k) { return idx.items[k]; });
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
      '- 반영을 마치면 `' + APPLIED_LOG_NAME + '` 맨 아래에 `반영완료:` 줄을 덧붙인다(형식은 그 파일 머리말 참고).',
      '- 사용자가 지난 글을 다시 읽으며 뒤늦게 남긴 평가다. 당시 대화의 반응보다 이 재독 피드백이 더 최신 판단이다.',
      '- `⭐ 최고`와 `👍 좋아요`의 **좋았던 점**은 살리고, 모든 편의 **아쉬웠던 점**과 `👎 별로` 편의 패턴은 반복하지 않는다.',
      '- 같은 내용이 각 원본 파일 맨 끝 `## 재독 피드백`에도 들어 있다.',
      '- 맨 아래 `소설 아님` 목록은 설정·잡담 등 대화 기록이라 소설 참고 자료에서 제외한 번호다.',
      ''
    ];
    [['best', '⭐ 최고'], ['like', '👍 좋아요'], ['dislike', '👎 별로'], ['', '평가 없이 메모만']].forEach(function (g) {
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
  function writeSummary_(idx) {
    return writeFile_(FEEDBACK_SUMMARY_NAME, buildSummary_(idx)).then(function () { return writeUnapplied_(idx); });
  }

  // ---------- 미반영 피드백 (반영_기록.md는 읽기만) ----------

  /** 'yyyy-MM-dd HH:mm'(한국 시각) → 분 단위 시각(ms). 형식이 아니면 null */
  function kstMs_(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || '').trim());
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 9 * 3600 * 1000;
  }
  /**
   * 반영_기록.md에서 가장 늦은 '반영완료:' 시각을 찾는다. 줄 맨 앞(목록 기호 '-'/'*' 허용)에 있어야 한다.
   * 시각 형식: 2026-10-20T09:30+09:00 / 2026-10-20 09:30 (시간대 없으면 한국 시각) / ...Z. 초는 버리고 분 단위로 본다.
   */
  function latestAppliedMark_(text) {
    var re = /^[ \t]*(?:[-*][ \t]+)?반영완료[ \t]*:[ \t]*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?[ \t]*(Z|[+-]\d{2}:?\d{2})?/gm;
    var best = null, m;
    while ((m = re.exec(String(text || '').replace(/\r/g, '')))) {
      var off = 9 * 60;
      if (m[6] === 'Z') off = 0;
      else if (m[6]) { var z = m[6].replace(':', ''); off = (z[0] === '-' ? -1 : 1) * (parseInt(z.slice(1, 3), 10) * 60 + parseInt(z.slice(3, 5), 10)); }
      var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - off * 60000;
      if (best === null || ms > best) best = ms;
    }
    return best;
  }
  /**
   * 미반영 피드백 파일 내용. 기록 시각이 마지막 반영완료 시각과 같은 분이거나 그 뒤인 항목만 넣는다(같은 분은 놓치지 않게 포함).
   * 기록 시각이 없는 항목은 반영 기록이 하나도 없을 때만 넣는다.
   */
  function buildUnapplied_(idx, logText) {
    var mark = latestAppliedMark_(logText);
    var bySrc = function (a, b) { return a.num - b.num || srcOrder_(a.src) - srcOrder_(b.src); };
    var author = function (x) { return x.src && x.src !== 'old' ? (SOURCE_LABEL[x.src] || x.src) : SOURCE_LABEL.old; };
    var items = Object.keys(idx.items).map(function (k) { return idx.items[k]; }).filter(function (x) {
      if (x.kind === 'notnovel' || !(x.rating || x.good || x.bad)) return false;
      var t = kstMs_(x.updated);
      if (mark === null) return true;
      return t !== null && t >= mark;
    }).sort(bySrc);
    var out = [
      '# 미반영 재독 피드백',
      '',
      '> 에피소드 리더 앱이 자동으로 만드는 파일이다. 직접 수정하지 말 것(피드백을 저장할 때마다 덮어써짐).',
      '> 마지막 갱신: ' + stamp_() + ' · 미반영 피드백 ' + items.length + '편',
      '> 기준: ' + (mark === null ? '`' + APPLIED_LOG_NAME + '`에 반영완료 기록 없음 → 지금까지의 피드백 전부' : '마지막 반영완료 ' + stamp_(new Date(mark)) + ' (한국 시각) 이후(같은 분 포함)에 남기거나 고친 피드백'),
      '',
      '## 생성 에이전트 사용 방법',
      '',
      '- 마지막 반영 이후 새로 남기거나 고친 피드백만 모은 파일이다. 피드백 반영은 이 파일만 읽으면 된다(전체 모음 `' + FEEDBACK_SUMMARY_NAME + '` 파일은 필요할 때만 연다).',
      '- 반영을 마치면 같은 폴더 `' + APPLIED_LOG_NAME + '` 맨 아래에 한 줄을 덧붙인다. 예: `반영완료: 2026-10-20T09:30+09:00 | 작가: Grok | 반영 편: 771, 772`',
      '- 앱은 반영 기록을 읽기만 하고, 다음에 피드백을 저장할 때 이 파일을 다시 만든다. 그래서 이 파일의 기준 시각보다 늦은 `반영완료:` 줄이 반영 기록에 이미 있으면, 그 시각 전에 기록된 항목은 이미 반영된 것이니 건너뛴다.',
      '- 같은 내용이 각 원본 파일 맨 끝 `## 재독 피드백` 구역에도 있다. 그 구역(재독피드백 표시 사이)은 앱이 관리하므로 고치지 않는다.',
      ''
    ];
    if (!items.length) { out.push('(미반영 피드백 없음)', ''); return out.join('\n'); }
    out.push('## 미반영 피드백 (' + items.length + '편)', '');
    items.forEach(function (x) {
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
    });
    return out.join('\n');
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
    return findFolder_(false).then(function (folder) {
      if (!folder) return null;
      return D.list("'" + esc(folder) + "' in parents and name = '" + esc(UNAPPLIED_NAME) + "' and mimeType != '" + FOLDER_MIME + "' and trashed = false", 'id, name, mimeType, createdTime, modifiedTime')
        .then(pickUnapplied_, function (e) {
          if (e && e.status === 404) { fbFolderId = null; return findUnapplied_(); }
          throw e;
        });
    });
  }
  /**
   * 목록을 불러올 때: 색인이 미반영 파일보다 나중에 바뀌었거나(예전 버전 앱·다른 기기에서 저장) 미반영 파일이 없으면
   * 뒤에서 미반영 파일만 다시 만든다. 목록 표시는 기다리지 않고, 실패해도 다음 저장 때 다시 쓴다.
   */
  var healing = null;
  function healUnapplied_(files, fi) {
    if (!fi || healing) return;
    var uf = pickUnapplied_(files);
    if (uf && uf.modifiedTime && fi.modifiedTime && uf.modifiedTime >= fi.modifiedTime) return;
    healing = withLock_(function () {
      return readIndex_().then(function (idx) { return writeUnapplied_(idx); });
    }).then(function () { if (api.onUnappliedHealed) try { api.onUnappliedHealed(); } catch (e) {} }, function (e) {
      if (global.console) console.warn('미반영_피드백.md 갱신 실패', e);
    }).then(function () { healing = null; });
  }
  function readAppliedLog_() {
    return findFile_(APPLIED_LOG_NAME).then(function (f) {
      if (!f) return '';
      return D.download(f.id).then(function (t) { return t || ''; });
    });
  }
  /** 항상 같은 파일 ID를 덮어쓴다. 없을 때만 새로 만든다. */
  function writeUnapplied_(idx) {
    return readAppliedLog_().then(function (log) {
      var text = buildUnapplied_(idx, log);
      return findUnapplied_().then(function (f) {
        if (f) return D.update(f.id, text, f.mimeType || 'text/markdown').then(function () { unappliedFile = f; return f; });
        return findFolder_(true).then(function (folder) { return D.create(UNAPPLIED_NAME, folder, text, 'text/markdown'); })
          .then(function (nf) { unappliedFile = nf; return nf; });
      });
    });
  }

  function oneBlock_(t) {
    // 여러 줄 메모를 목록 안에서 깨지지 않게 들여쓴다.
    return t.replace(/\r/g, '').split('\n').join('\n  ');
  }
  function pad3_(n) { return ('00' + n).slice(-3); }

  // ---------- 보관 폴더 (읽기 전용: 목록·내려받기만, 쓰기 없음) ----------
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
    getEpisodes: getEpisodes, getEpisodeContent: getEpisodeContent,
    listArchiveFolder: listArchiveFolder, getArchiveContent: getArchiveContent,
    SOURCE_LABEL: SOURCE_LABEL, baseName: baseName_, fbKey: fbKey_,
    saveFeedback: saveFeedback, saveKinds: saveKinds, saveLastRead: saveLastRead, getLastRead: getLastRead,
    stamp: stamp_, buildBlock: buildBlock_, replaceBlock: replaceBlock_, buildSummary: buildSummary_, buildUnapplied: buildUnapplied_, latestAppliedMark: latestAppliedMark_,
    hasStateFile: function () { return !!stateFile; },
    onFileWritten: null, onUnappliedHealed: null,
    healingDone: function () { return healing || Promise.resolve(); }
  };
  global.Core = api;
})(window);
