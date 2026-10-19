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
  var STATE_NAME = 'reader_state.json';          // 마지막으로 읽은 화 (휴대폰·PC 공유, PropertiesService 대신)
  var DEFAULT_HIDDEN_FOLDERS = ['00_설정과_대화'];
  var BLOCK_START = '<!-- 재독피드백:시작 (리더 앱이 자동 관리하는 구역) -->';
  var BLOCK_END = '<!-- 재독피드백:끝 -->';
  var RATING_LABEL = { best: '⭐ 최고', like: '👍 좋아요', dislike: '👎 별로', '': '평가 없음' };

  var EPISODE_RE = /^(\d+)_(.+)\.md$/i;
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
                if (EXCLUDED_FOLDERS.indexOf(f.name) === -1) schedule(f.id);
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
      var byNumber = {};
      var cats = {};
      var queue = [{ id: ROOT_FOLDER_ID, key: '', name: '' }];
      var seen = {};
      while (queue.length) {
        var folder = queue.shift();
        if (seen[folder.id]) continue;
        seen[folder.id] = true;
        (listings[folder.id] || []).forEach(function (f) {
          if (f.mimeType === FOLDER_MIME) {
            if (EXCLUDED_FOLDERS.indexOf(f.name) === -1) {
              queue.push({ id: f.id, key: (folder.key ? folder.key + '/' : '') + f.name, name: f.name });
            }
            return;
          }
          var m = EPISODE_RE.exec(f.name);
          if (!m) return;
          var num = parseInt(m[1], 10);
          if (num < MIN_EPISODE_NUMBER) return;
          var catKey = folder.key || '(기타)';
          if (!cats[catKey]) cats[catKey] = { key: catKey, name: cleanCategory_(folder.name) || '기타' };

          var prev = byNumber[num];
          if (!prev) {
            byNumber[num] = { id: f.id, ids: [f.id], num: num, title: cleanTitle_(m[2]), modified: f.modifiedTime, cats: [catKey] };
            return;
          }
          if (prev.ids.indexOf(f.id) === -1) prev.ids.push(f.id);
          if (prev.cats.indexOf(catKey) === -1) prev.cats.push(catKey);
          if (f.modifiedTime > prev.modified) {
            prev.id = f.id; prev.title = cleanTitle_(m[2]); prev.modified = f.modifiedTime;
          }
        });
      }
      var episodes = Object.keys(byNumber).map(function (k) { return byNumber[k]; })
        .sort(function (a, b) { return a.num - b.num; });
      var categories = Object.keys(cats).sort().map(function (k) { return cats[k]; });
      return fbPromise.then(function (fb) {
        var cand = fb.cand || {};
        return {
          episodes: episodes, categories: categories, feedback: fb.index.items,
          candidates: cand.candidates || {}, keepNovel: cand.keepNovel || {},
          hiddenFolders: DEFAULT_HIDDEN_FOLDERS, state: fb.state
        };
      });
    });
  }

  function firstByName(files, name) {
    for (var i = 0; i < files.length; i++) if (files[i].name === name && files[i].mimeType !== FOLDER_MIME) return files[i];
    return null;
  }
  function loadFeedbackFolder(folderId) {
    return listChildren(folderId).then(function (files) {
      var fi = firstByName(files, FEEDBACK_INDEX_NAME), fc = firstByName(files, CANDIDATES_NAME), fs = firstByName(files, STATE_NAME);
      if (fs) stateFile = fs;   // 숨김 전환 때 요청 한 번으로 저장할 수 있게 기억
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
          var cur = idx.items[ep.num] || {};
          return applyItem_(idx, ep, { rating: cur.rating || '', good: cur.good || '', bad: cur.bad || '', kind: kind })
            .then(function (item) { out[ep.num] = item; });
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
      if (empty) { delete idx.items[ep.num]; return null; }
      idx.items[ep.num] = {
        num: ep.num, title: ep.title, ids: ep.ids, cats: ep.catNames || [],
        rating: rating, good: good, bad: bad, kind: kind, updated: stamp
      };
      return idx.items[ep.num];
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
    var notNovel = all.filter(function (x) { return x.kind === 'notnovel'; }).sort(function (a, b) { return a.num - b.num; });
    var items = all.filter(function (x) { return x.kind !== 'notnovel' && (x.rating || x.good || x.bad); });
    var byRating = function (r) {
      return items.filter(function (x) { return x.rating === r; })
        .sort(function (a, b) { return a.num - b.num; });
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
        out.push('### ' + pad3_(x.num) + '. ' + x.title, '');
        out.push('- 분류' + (cat ? ':' + cat.slice(2) : ': -'));
        out.push('- 기록: ' + x.updated);
        if (x.good) out.push('- 좋았던 점: ' + oneBlock_(x.good));
        if (x.bad) out.push('- 아쉬웠던 점: ' + oneBlock_(x.bad));
        out.push('');
      });
    });
    if (notNovel.length) {
      out.push('## 소설 아님으로 표시한 글 (' + notNovel.length + '편)', '');
      notNovel.forEach(function (x) { out.push('- ' + pad3_(x.num) + '. ' + x.title); });
      out.push('');
    }
    return out.join('\n');
  }
  function writeSummary_(idx) { return writeFile_(FEEDBACK_SUMMARY_NAME, buildSummary_(idx)); }

  function oneBlock_(t) {
    // 여러 줄 메모를 목록 안에서 깨지지 않게 들여쓴다.
    return t.replace(/\r/g, '').split('\n').join('\n  ');
  }
  function pad3_(n) { return ('00' + n).slice(-3); }

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
    saveFeedback: saveFeedback, saveKinds: saveKinds, saveLastRead: saveLastRead, getLastRead: getLastRead,
    stamp: stamp_, buildBlock: buildBlock_, replaceBlock: replaceBlock_, buildSummary: buildSummary_,
    hasStateFile: function () { return !!stateFile; },
    onFileWritten: null
  };
  global.Core = api;
})(window);
