/**
 * 에피소드 리더 (PWA) — Index.html의 화면 동작을 그대로 옮기고,
 * google.script.run 대신 Core(드라이브 직접 호출), 보기 설정과 쪽 넘기기를 더했다.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var episodes = [];        // 번호순 전체
  var categories = [];      // [{key, name}]
  var catName = {};
  var view = safeGet('view') || 'groups'; // 'groups' | 'all' | 분류 key
  var seq = [];             // 이전/다음 화 이동 순서 (episodes 인덱스 배열)
  var seqCat = '';          // seq가 어느 분류인지 ('' = 전체)
  var pos = -1;             // seq 안에서의 위치
  var lastRead = null;
  var cache = {};
  var feedback = {};        // 번호 -> {rating, good, bad, updated}
  var VIRTUAL = [['@best', '⭐ 최고'], ['@unrated', '아직 평가 안 함'], ['@meh', '😐 평범'], ['@dislike', '👎 별로'],
    ['@candidate', '소설 아님 후보'], ['@notnovel', '소설 아님']];
  var candidates = {}, keepNovel = {}, hiddenFolders = [];
  var legacyFb = {};        // 출처 키 -> 예전 번호 키 (예전 색인 항목을 이어받은 경우)
  var archiveRoots = [];    // 목록에서 빠진 폴더들 (보관 폴더)
  var numCount = {};        // 번호 -> 그 번호의 글 수 (출처가 다르면 같은 번호가 여럿)
  // 작가별 구분: 기존(~685) + 드라이브에서 찾은 작가 폴더들 (ChatGPT, 그록봇, …)
  var sourceList = [];      // [{id, label, badge, folder}] 폴더 이름순
  var srcMap = {};
  function srcLabel(id) { return id === 'old' ? '기존' : (srcMap[id] ? srcMap[id].label : id); }
  function badgeOf(id) { return srcMap[id] ? srcMap[id].badge : id; }
  /** 예전 저장본(작가 목록 없음)에서도 글·분류의 작가로 목록을 만든다 */
  function deriveSources(data) {
    var seen = {}, out = [];
    var fallback = { gpt: ['ChatGPT', 'GPT'], grok: ['그록봇', '그록'] };
    (data.episodes || []).concat(data.categories || []).forEach(function (x) {
      if (!x.src || seen[x.src]) return;
      seen[x.src] = true;
      var f = fallback[x.src] || [x.src, x.src.slice(0, 6)];
      out.push({ id: x.src, label: f[0], badge: f[1], folder: x.src });
    });
    return out;
  }
  var BS = '<!-- 재독피드백:시작', BE = '<!-- 재독피드백:끝 -->';
  var FEEDBACK_MAX = Infinity; // 모든 편에 재독 피드백 칸 표시
  var LS = window.localStorage;
  var localTouch = {};      // 이 기기에서 저장한 번호 -> 시각 (백그라운드 새로 고침이 덮어쓰지 않게)
  var booted = false;       // 목록(저장본 또는 드라이브)을 한 번이라도 그렸는지
  var openSeqNo = 0;        // 본문 로딩 경쟁 방지

  function safeGet(k) { try { return LS.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { LS.setItem(k, v); } catch (e) {} }
  function errMsg(e) { return e && e.message ? e.message : String(e); }

  // ---------- IndexedDB (본문 저장본) ----------
  var idb = (function () {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        if (!window.indexedDB) { rej(new Error('no idb')); return; }
        var r = indexedDB.open('episode-reader', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
      dbp.catch(function () { dbp = null; });
      return dbp;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction('kv', mode), req = fn(t.objectStore('kv'));
          t.oncomplete = function () { res(req && req.result); };
          t.onerror = t.onabort = function () { rej(t.error); };
        });
      });
    }
    return {
      get: function (k) { return tx('readonly', function (s) { return s.get(k); }).catch(function () { return null; }); },
      put: function (k, v) { return tx('readwrite', function (s) { s.put(v, k); }).catch(function () {}); }
    };
  })();

  // ---------- 설정: 테마 버튼, 보기 설정 ----------
  $('themeBtn').onclick = function () {
    var t = Settings.get().theme;
    Settings.set({ theme: t === 'dark' || t === 'black' ? 'light' : 'dark' });
  };
  $('aaBtn').onclick = function () { Settings.open(); };

  marked.setOptions({ gfm: true, breaks: true });

  function srcOf(ep) { return ep.src || 'old'; }
  function keyOf(ep) { return ep.key || String(ep.num); }
  var sourcesPresent = false;
  function curSrc() {
    var v = Settings.get().source || 'all';
    if (!sourcesPresent) return 'all';
    return v === 'all' || v === 'old' || srcMap[v] ? v : 'all';
  }
  function srcOk(i) { var c = curSrc(); return c === 'all' || srcOf(episodes[i]) === c; }
  function catSrcOk(c) { var cs = curSrc(); return cs === 'all' || (c.src || 'old') === cs; }
  function hasSources() { return sourcesPresent; }
  /** 번호로 적힌 자료(후보·소설 맞음): 기존 글은 번호, 출처별 글은 '686-grok' 키, 번호가 겹치지 않으면 번호도 인정 */
  function byNumOrKey(map, ep) {
    if (!ep.src) return map[ep.num];
    if (map[ep.key] != null) return map[ep.key];
    return numCount[ep.num] === 1 ? map[ep.num] : undefined;
  }
  function candOf(ep) { return byNumOrKey(candidates, ep); }
  function fbOf(i) { return feedback[keyOf(episodes[i])] || {}; }
  function rating(i) { return fbOf(i).rating || ''; }
  function kindOf(i) { return fbOf(i).kind || ''; }
  /** 설정과 대화 폴더: 앞 번호를 뗀 이름으로, 어느 깊이에 있든 (00_설정과_대화, 그록봇/05_설정과_대화 …) */
  function inHiddenFolder(i) {
    var bases = hiddenFolders.map(Core.baseName);
    return episodes[i].cats.some(function (k) {
      return k.split('/').some(function (seg) { return bases.indexOf(Core.baseName(seg)) !== -1; });
    });
  }
  function defaultNotNovel(i) { return inHiddenFolder(i) && !byNumOrKey(keepNovel, episodes[i]); }
  function isNotNovel(i) {
    var k = kindOf(i);
    if (k === 'notnovel') return true;
    if (k === 'novel') return false;
    return defaultNotNovel(i);
  }
  function isCandidate(i) { return !kindOf(i) && !isNotNovel(i) && !!candOf(episodes[i]); }
  function hasReview(i) { var f = fbOf(i); return !!(f.rating || f.good || f.bad); }
  function isHidden(i) { return isNotNovel(i) || rating(i) === 'dislike' || rating(i) === 'meh'; }
  function inCat(key) {
    var out = [];
    episodes.forEach(function (ep, i) {
      if (key.charAt(0) === '@' && !srcOk(i)) return;   // 가상 분류는 고른 출처 안에서만 (실제 분류는 출처가 하나)
      var ok, nn = isNotNovel(i);
      if (key === '@best') ok = !nn && rating(i) === 'best';
      else if (key === '@unrated') ok = !nn && ep.num <= FEEDBACK_MAX && !hasReview(i);
      else if (key === '@meh') ok = !nn && rating(i) === 'meh';
      else if (key === '@dislike') ok = !nn && rating(i) === 'dislike';
      else if (key === '@candidate') ok = isCandidate(i);
      else if (key === '@notnovel') ok = nn;
      else ok = !isHidden(i) && ep.cats.indexOf(key) !== -1;   // 별로·평범·소설 아님은 일반 분류에서 숨김
      if (ok) out.push(i);
    });
    return out;
  }
  function everyIdx() { return episodes.map(function (_, i) { return i; }); }
  function srcIdx() { return everyIdx().filter(srcOk); }
  function allIdx() { return srcIdx().filter(function (i) { return !isHidden(i); }); }
  function allIdxAnySrc() { return everyIdx().filter(function (i) { return !isHidden(i); }); }
  function srcBadge(src) {
    var b = document.createElement('span');
    b.className = 'srcb ' + (src === 'gpt' || src === 'grok' ? 'srcb-' + src : 'srcb-other');
    b.setAttribute('data-src', src); b.textContent = badgeOf(src); return b;
  }
  var MARK = { best: '⭐', like: '👍', meh: '😐', dislike: '👎' };

  // ---------- 목록 ----------
  function itemLi(i, cat) {
    var ep = episodes[i];
    var li = document.createElement('li');
    if (lastRead && lastRead.id === ep.id) li.className = 'last';
    li.innerHTML = '<span class="ck"></span><span class="n"></span><span class="t"></span>';
    li.setAttribute('data-i', i);
    if (selected[i]) { li.classList.add('sel'); li.querySelector('.ck').textContent = '✓'; }
    li.querySelector('.n').textContent = ep.num;
    li.querySelector('.t').textContent = ep.title;
    if (ep.src && curSrc() === 'all') li.querySelector('.n').after(srcBadge(ep.src));
    var r = rating(i);
    if (r) { var mk = document.createElement('span'); mk.className = 'mark'; mk.textContent = MARK[r]; li.querySelector('.t').appendChild(mk); }
    var bd = isNotNovel(i) ? '소설 아님' : isCandidate(i) ? '후보' : '';
    if (bd) { var b = document.createElement('span'); b.className = 'badge'; b.textContent = bd; li.querySelector('.t').appendChild(b); }
    if (cat === '@candidate' && candOf(ep)) {
      var why = document.createElement('span'); why.className = 'c'; why.textContent = '자동 판단: ' + candOf(ep);
      li.querySelector('.t').appendChild(why);
    }
    if (cat === null) {
      var c = document.createElement('span'); c.className = 'c';
      c.textContent = ep.cats.map(function (k) { return catName[k]; }).join(' · ');
      li.querySelector('.t').appendChild(c);
    }
    li.onclick = function () {
      if (longPressed) { longPressed = false; return; }
      if (selecting) { toggleSel(i, li); return; }
      openEpisode(i, cat || '', true);
    };
    var lp = null;
    li.addEventListener('touchstart', function () {
      longPressed = false;   // 길게 누른 뒤 click이 오지 않는 기기에서 다음 탭이 씹히지 않게
      lp = setTimeout(function () { longPressed = true; if (!selecting) startSelect(); toggleSel(i, li); }, 550);
    }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(function (ev) { li.addEventListener(ev, function () { clearTimeout(lp); }, { passive: true }); });
    li.addEventListener('contextmenu', function (e) { if (selecting || longPressed) e.preventDefault(); });
    return li;
  }

  function renderSources() {
    var box = $('srcTabs'); box.innerHTML = '';
    box.hidden = !hasSources();
    if (box.hidden) return;
    var cur = curSrc();
    var tabs = [['all', '전체'], ['old', '기존 (~685)']].concat(sourceList.map(function (a) { return [a.id, a.label]; }));
    tabs.forEach(function (o) {
      var b = document.createElement('button');
      b.className = 'stab' + (cur === o[0] ? ' on' : '');
      b.setAttribute('data-src', o[0]); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', cur === o[0] ? 'true' : 'false');
      var n = episodes.filter(function (e, i) { return (o[0] === 'all' || srcOf(e) === o[0]) && !isHidden(i); }).length;
      b.innerHTML = '<span class="sl2"></span><span class="sn"></span>';
      b.firstChild.textContent = o[1]; b.lastChild.textContent = n;
      b.onclick = function () { setSource(o[0]); };
      box.appendChild(b);
    });
  }
  function setSource(v) {
    safeSet('source', v);
    Settings.set({ source: v });   // 보기 설정(localStorage viewSettings)에도 저장
    renderHome(); window.scrollTo(0, 0);
  }
  function catLabel(c) { return c.name; }
  function renderChips() {
    var box = $('chips'); box.innerHTML = '';
    var showBadge = curSrc() === 'all';
    var opts = [{ v: 'groups', label: '분류별' }, { v: 'all', label: '전체 번호순' }]
      .concat(VIRTUAL.map(function (v) { return { v: v[0], label: v[1] + ' ' + inCat(v[0]).length }; }))
      .concat(categories.filter(catSrcOk).map(function (c) { return { v: c.key, label: catLabel(c), src: showBadge && c.src }; }));
    opts.forEach(function (o) {
      var b = document.createElement('button');
      b.className = 'chip' + (view === o.v ? ' on' : '');
      b.textContent = o.label;
      if (o.src) { b.appendChild(document.createTextNode(' ')); b.appendChild(srcBadge(o.src)); }
      b.onclick = function () { view = o.v; safeSet('view', view); renderHome(); window.scrollTo(0, 0); };
      box.appendChild(b);
    });
  }

  function renderHome() {
    var q = $('search').value.trim().toLowerCase();
    var ul = $('list'), groups = $('groups');
    ul.innerHTML = ''; groups.innerHTML = '';
    $('chips').style.display = q ? 'none' : 'flex';
    $('arcEntry').hidden = !!q || !archiveRoots.length;
    if ($('arcEntry').open && !arcRootsDrawn && archiveRoots.length) drawArcRoots();
    renderSources();
    renderChips();
    var sp = curSrc() === 'all' ? '' : srcLabel(curSrc()) + ' · ';

    if (q) {
      var pool = srcIdx();   // 검색도 고른 출처 안에서
      var hits = pool.filter(function (i) {
        var ep = episodes[i];
        return (ep.num + ' ' + ep.title + ' ' + ep.cats.map(function (k) { return catName[k]; }).join(' ') + (ep.src ? ' ' + srcLabel(ep.src) + ' ' + badgeOf(ep.src) : ''))
          .toLowerCase().indexOf(q) !== -1;
      });
      hits.forEach(function (i) { ul.appendChild(itemLi(i, null)); });
      $('count').textContent = sp + hits.length + '편 찾음 / 전체 ' + pool.length + '편';
      return;
    }

    if (view === 'groups') {
      var openSet = {};
      try { openSet = JSON.parse(safeGet('openGroups') || '{}'); } catch (e) {}
      categories.forEach(function (c) {
        if (!catSrcOk(c)) return;
        var idx = inCat(c.key);
        if (!idx.length) return;
        var d = document.createElement('details'); d.className = 'group';
        var sm = document.createElement('summary');
        sm.innerHTML = '<span></span><span class="gc"></span>';
        sm.firstChild.textContent = catLabel(c);
        if (c.src && curSrc() === 'all') { sm.firstChild.appendChild(document.createTextNode(' ')); sm.firstChild.appendChild(srcBadge(c.src)); }
        sm.lastChild.textContent = idx.length + '편';
        d.appendChild(sm);
        var inner = document.createElement('ul'); inner.className = 'list';
        d.appendChild(inner);
        var fill = function () { if (!inner.childNodes.length) idx.forEach(function (i) { inner.appendChild(itemLi(i, c.key)); }); };
        if (openSet[c.key]) { d.open = true; fill(); }
        d.addEventListener('toggle', function () {
          if (d.open) fill();
          openSet[c.key] = d.open; safeSet('openGroups', JSON.stringify(openSet));
        });
        groups.appendChild(d);
      });
      $('count').textContent = sp + '소설 ' + allIdx().length + '편' + hiddenNote();
      return;
    }

    var realCat = categories.filter(function (c) { return c.key === view; })[0];
    if (view === 'all' || !catName[view] || (realCat && !catSrcOk(realCat))) {
      view = 'all';
      var all = allIdx();
      all.forEach(function (i) { ul.appendChild(itemLi(i, null)); });
      $('count').textContent = sp + '소설 ' + all.length + '편' + hiddenNote();
      return;
    }

    var list = inCat(view);
    list.forEach(function (i) { ul.appendChild(itemLi(i, view)); });
    $('count').textContent = (realCat && realCat.src && !sp ? srcLabel(realCat.src) + ' · ' : sp) + catName[view] + ' · ' + list.length + '편';
  }
  function hiddenNote() {
    var d = inCat('@dislike').length, m = inCat('@meh').length, n = inCat('@notnovel').length, parts = [];
    if (m) parts.push('평범 ' + m); if (d) parts.push('별로 ' + d); if (n) parts.push('소설 아님 ' + n);
    return parts.length ? ' · 숨김: ' + parts.join(', ') : '';
  }
  $('search').addEventListener('input', renderHome);

  // ---------- 여러 편 선택 ----------
  var selecting = false, selected = {}, longPressed = false;
  function startSelect() { selecting = true; selected = {}; document.body.classList.add('selecting'); $('selBtn').textContent = '선택 끝내기'; updSel(); }
  function endSelect() { selecting = false; selected = {}; document.body.classList.remove('selecting'); $('selBtn').textContent = '여러 편 선택'; renderHome(); }
  function toggleSel(i, li) {
    if (selected[i]) delete selected[i]; else selected[i] = true;
    li.classList.toggle('sel', !!selected[i]);
    li.querySelector('.ck').textContent = selected[i] ? '✓' : '';
    updSel();
  }
  function updSel() { $('selCount').textContent = Object.keys(selected).length + '편 선택'; }
  $('selBtn').onclick = function () { selecting ? endSelect() : startSelect(); };
  $('selCancel').onclick = endSelect;
  $('selNot').onclick = function () { applyKindBulk('notnovel'); };
  $('selNovel').onclick = function () { applyKindBulk('novel'); };
  function epMeta(i) { return metaOf(episodes[i]); }
  /** 저장용 정보: 기존 글은 예전 형식 그대로, 출처별 글은 출처·키(·예전 번호 키)를 더한다 */
  function metaOf(ep) {
    var m = { num: ep.num, title: ep.title, ids: ep.ids || [ep.id], catNames: ep.cats.map(function (k) { return catName[k]; }) };
    if (ep.src) { m.src = ep.src; m.key = ep.key; if (legacyFb[ep.key]) m.legacyKey = legacyFb[ep.key]; }
    return m;
  }
  function applyKindBulk(kind) {
    var list = Object.keys(selected).map(Number);
    if (!list.length) return;
    var chunks = [];
    for (var c = 0; c < list.length; c += 15) chunks.push(list.slice(c, c + 15));
    var done = 0;
    $('selNot').disabled = $('selNovel').disabled = true;
    var step = function () {
      if (!chunks.length) {
        $('selNot').disabled = $('selNovel').disabled = false;
        $('selCount').textContent = done + '편 저장 완료';
        saveListCache();
        setTimeout(endSelect, 700);
        return;
      }
      var chunk = chunks.shift();
      $('selCount').textContent = '저장 중… ' + done + ' / ' + list.length;
      var metas = chunk.map(epMeta);
      metas.forEach(function (m) { localTouch[m.key || String(m.num)] = Date.now(); });
      Core.saveKinds(metas, kind).then(function (res) {
        Object.keys(res.items).forEach(function (k) {
          if (res.items[k]) feedback[k] = res.items[k]; else delete feedback[k];
          if (legacyFb[k]) { delete feedback[legacyFb[k]]; delete legacyFb[k]; }
        });
        done += chunk.length; step();
      }, function (e) {
        $('selNot').disabled = $('selNovel').disabled = false;
        $('selCount').textContent = '저장 실패 (' + done + '편까지 저장됨): ' + errMsg(e);
      });
    };
    step();
  }

  function showResume() {
    $('resume').style.display = 'none';
    if (!lastRead) return;
    var idx = findLast(lastRead);
    if (idx < 0) return;
    var cat = lastRead.cat && episodes[idx].cats.indexOf(lastRead.cat) !== -1 ? lastRead.cat : '';
    var re = episodes[idx], rs = re.src ? srcLabel(re.src) : '';
    var rp = [rs, cat ? catName[cat] : ''].filter(Boolean).join(' · ');
    $('resumeTitle').textContent = re.num + '. ' + re.title + (rp ? '  (' + rp + ')' : '');
    $('resume').style.display = 'block';
    var lr = lastRead;
    $('resume').onclick = function () { openEpisode(idx, cat, true, { scroll: lr.scroll, frac: lr.frac, mode: lr.mode }); };
  }

  function indexOfId(id) {
    for (var i = 0; i < episodes.length; i++) if (episodes[i].id === id) return i;
    return -1;
  }
  function indexOfNum(num) {
    for (var i = 0; i < episodes.length; i++) if (episodes[i].num === num && !episodes[i].src) return i;
    return -1;
  }
  function indexOfKey(k) {
    for (var i = 0; i < episodes.length; i++) if (keyOf(episodes[i]) === k) return i;
    return -1;
  }
  /** 마지막으로 읽은 화 찾기: 같은 ID, 없으면(대표 사본이 바뀐 경우) 같은 키(출처+번호), 예전 기록은 기존 글 번호 */
  function findLast(lr) {
    var i = indexOfId(lr.id);
    if (i < 0 && lr.key) i = indexOfKey(lr.key);
    if (i < 0 && lr.num && !lr.key) i = indexOfNum(lr.num);
    return i;
  }

  // ---------- 주소·뒤로 가기 (history.pushState + ?ep=) ----------
  function homeUrl() { return location.pathname; }
  function epUrl(ep) { return location.pathname + '?ep=' + encodeURIComponent(keyOf(ep)); }

  // ---------- 화면 전환 ----------
  var homeScroll = 0, readerOpen = false;
  function showHome(push, toArc) {
    if (editing && !confirmLeaveEdit()) return;
    closeEdit(false);
    hideQuoteBar();
    flushFeedback();
    saveScroll();
    openSeqNo++;
    pos = -1;
    leaveArc();
    readerOpen = false; applyLayout();
    Settings.setReading(false);
    $('reader').style.display = 'none';
    $('archive').style.display = 'none';
    $('home').style.display = 'block';
    $('backBtn').style.display = 'none';
    $('headTitle').textContent = '에피소드 리더';
    renderHome(); showResume();
    if (push) history.pushState({ view: 'home' }, '', homeUrl());
    safeSet('inReader', '');
    if (toArc && !$('arcEntry').hidden) { $('arcEntry').open = true; $('arcEntry').scrollIntoView({ block: 'start' }); }
    else window.scrollTo(0, homeScroll);
  }

  function setSeq(cat) {
    seqCat = cat && catName[cat] ? cat : '';
    seq = seqCat ? inCat(seqCat) : allIdx();
  }
  function updateNav() {
    var ce = episodes[seq[pos]];
    var sp = ce && ce.src ? srcLabel(ce.src) + ' · ' : '';
    $('where').textContent = sp + (seqCat ? catName[seqCat] : '전체') + ' · ' + (pos + 1) + ' / ' + seq.length;
    ['prevTop', 'prevBottom', 'pbPrev'].forEach(function (b) { $(b).disabled = pos === 0; });
    ['nextTop', 'nextBottom', 'pbNext'].forEach(function (b) { $(b).disabled = pos === seq.length - 1; });
  }
  function normPos(p) {
    if (typeof p === 'number') return { scroll: p };
    return p || {};
  }

  function openEpisode(i, cat, push, p) {
    if (i < 0 || i >= episodes.length) return;
    if (editing && !confirmLeaveEdit()) return;
    closeEdit(false);
    hideQuoteBar();
    p = normPos(p);
    if (selecting) { selecting = false; selected = {}; document.body.classList.remove('selecting'); $('selBtn').textContent = '여러 편 선택'; }
    flushFeedback();
    if (arcOpen || arcListing) { leaveArc(); }
    else if (pos < 0) homeScroll = window.scrollY; else saveScroll();
    $('archive').style.display = 'none';
    setSeq(cat);
    pos = seq.indexOf(i);
    if (pos < 0) { setSeq(''); pos = seq.indexOf(i); }
    if (pos < 0) { seqCat = ''; seq = allIdxAnySrc(); pos = seq.indexOf(i); }   // 다른 출처의 글(이어 읽기 등)
    if (pos < 0) { seq = everyIdx(); pos = i; }   // 숨긴 글을 검색에서 연 경우
    var ep = episodes[i];
    $('home').style.display = 'none';
    $('reader').style.display = 'block';
    $('backBtn').style.display = 'inline-block';
    $('fb').style.display = '';
    $('editBtn').hidden = false;
    $('pbEdit').hidden = false;
    $('headTitle').textContent = ep.num + '. ' + ep.title;
    $('endTitle').textContent = ep.num + '. ' + ep.title + ' · 끝';
    updateNav();
    if (push) history.pushState({ view: 'ep', id: ep.id, cat: seqCat }, '', epUrl(ep));
    safeSet('inReader', '1');
    readerOpen = true; applyLayout(); hideEnd(true);
    document.body.classList.remove('chrome');
    Settings.setReading(true);
    window.scrollTo(0, 0);
    $('meta').innerHTML = '';
    fillFeedback(ep);

    var my = ++openSeqNo;
    var done = function (md) {
      cache[ep.id] = md;
      if (Core.noteEpisodeText) Core.noteEpisodeText(ep.id, md, ep.modified);
      safeSet('lastMd', JSON.stringify({ id: ep.id, num: ep.num, title: ep.title, md: md }));
      if (my !== openSeqNo) return;
      var parts = splitMd(md);
      $('article').innerHTML = DOMPurify.sanitize(marked.parse(parts.body));
      $('meta').innerHTML = '';
      if (parts.meta.trim()) {
        var d = document.createElement('details'); d.className = 'meta';
        d.innerHTML = '<summary>당시 메모 · 독자 반응 보기</summary>' + DOMPurify.sanitize(marked.parse(parts.meta));
        $('meta').appendChild(d);
      }
      textLen = $('article').textContent.length;
      watchImages();
      var frac = 0;
      if (isPaged()) {
        paginate();
        if (p.end) { goPage(pageCount - 1); curAnchor = probeAnchor(); }
        else if (p.frac != null && p.frac > 0) { curAnchor = Math.round(p.frac * textLen); goPage(pageOfChar(curAnchor)); }
        else { curAnchor = 0; goPage(0); }
        frac = textLen ? curAnchor / textLen : 0;
      } else if (p.mode === 'page' && p.frac != null && p.frac > 0) {
        var target = Math.round(p.frac * textLen);
        frac = p.frac;
        setTimeout(function () { if (my === openSeqNo) scrollToChar(target); }, 30);
      } else if (p.scroll) {
        frac = p.frac || 0;
        setTimeout(function () { window.scrollTo(0, p.scroll); }, 30);
      }
      remember(ep, p.scroll || 0, frac);
      if (pos + 1 < seq.length && cache[episodes[seq[pos + 1]].id] == null) prefetch(episodes[seq[pos + 1]]);
    };
    if (cache[ep.id] != null) { done(cache[ep.id]); return; }
    $('article').innerHTML = '<div class="status">본문을 불러오는 중이에요…</div>';
    if (isPaged()) { paginate(); goPage(0); }
    loadContent(ep).then(done, function (e) {
      if (my !== openSeqNo) return;
      $('article').innerHTML = '<div class="status">본문을 불러오지 못했어요. <button class="retry">다시 시도</button><br><small></small></div>';
      $('article').querySelector('small').textContent = errMsg(e);
      $('article').querySelector('.retry').onclick = function () { openEpisode(i, seqCat, false, p); };
      if (isPaged()) { paginate(); goPage(0); }
    });
  }

  /** 본문 읽기: IndexedDB 저장본이 드라이브 수정 시각과 같으면 그대로, 아니면 새로 받는다. */
  function loadContent(ep, background) {
    return idb.get('c:' + ep.id).then(function (hit) {
      if (hit && hit.modified === ep.modified) return hit.md;
      if (hit && (!navigator.onLine || !Drive.hasValidToken())) return hit.md;   // 오프라인·연결 만료: 저장본 먼저
      if (background && !Drive.hasValidToken()) throw new Error('skip');
      return Core.getEpisodeContent(ep.id).then(function (md) {
        idb.put('c:' + ep.id, { md: md, modified: ep.modified });
        return md;
      }, function (e) { if (hit) return hit.md; throw e; });
    });
  }
  function prefetch(ep) {
    loadContent(ep, true).then(function (md) {
      cache[ep.id] = md;
      if (Core.noteEpisodeText) Core.noteEpisodeText(ep.id, md, ep.modified);
    }, function () {});
  }
  Core.onFileWritten = function (id, text, modified) {
    // 피드백을 쓰며 바뀐 원본: 저장본도 맞춰 두면 다음에 다시 받지 않는다.
    var i = indexOfId(id);
    if (i < 0) return;
    if (modified) episodes[i].modified = modified;
    cache[id] = text;
    idb.put('c:' + id, { md: text, modified: episodes[i].modified });
  };

  // ---------- 마지막으로 읽은 화 ----------
  function remember(ep, scroll, frac) {
    lastRead = { id: ep.id, num: ep.num, cat: seqCat, scroll: scroll, frac: Math.round((frac || 0) * 10000) / 10000,
      mode: Settings.get().mode, at: Date.now() };
    if (ep.src) lastRead.key = ep.key;
    safeSet('lastRead', JSON.stringify(lastRead));
    scheduleStateSync();
  }
  function saveScroll() {
    if (pos < 0 || !lastRead || !episodes[seq[pos]] || lastRead.id !== episodes[seq[pos]].id) return;
    if (isPaged()) {
      lastRead.frac = textLen ? Math.round(curAnchor / textLen * 10000) / 10000 : 0;
      lastRead.mode = 'page';
    } else {
      lastRead.scroll = window.scrollY;
      var a = probeAnchorScroll();
      if (a != null && textLen) lastRead.frac = Math.round(a / textLen * 10000) / 10000;
      lastRead.mode = 'scroll';
    }
    lastRead.at = Date.now();
    safeSet('lastRead', JSON.stringify(lastRead));
  }
  var scrollTimer = null;
  window.addEventListener('scroll', function () {
    if (pos < 0 || isPaged()) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () {
      saveScroll();
      if (lastRead) scheduleStateSync();
    }, 1500);
  }, { passive: true });

  // 드라이브 reader_state.json: 스크롤마다 쓰지 않고 최대 15초에 한 번 + 화면을 떠날 때
  var STATE_MIN_GAP = 15000;
  var stateDirty = false, stateTimer = null, lastStateWrite = 0;
  function scheduleStateSync() {
    if (arcOpen || arcListing) return;   // 보관 폴더에서는 읽기 기록을 남기지 않는다
    stateDirty = true;
    if (stateTimer) return;
    var wait = Math.max(3000, STATE_MIN_GAP - (Date.now() - lastStateWrite));
    stateTimer = setTimeout(function () { stateTimer = null; flushState(false); }, wait);
  }
  function flushState(keepalive) {
    clearTimeout(stateTimer); stateTimer = null;
    if (arcOpen || arcListing) return;
    if (!stateDirty || !lastRead) return;
    if (!Drive.hasValidToken()) return;   // 연결이 갱신되면 다시 시도
    if (keepalive && !Core.hasStateFile()) keepalive = false;
    stateDirty = false; lastStateWrite = Date.now();
    var snap = JSON.parse(JSON.stringify(lastRead));
    Core.saveLastRead(snap, { keepalive: keepalive }).catch(function () { stateDirty = true; });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      flushFeedback();
      if (readerOpen && !arcOpen) { saveScroll(); stateDirty = stateDirty || !!lastRead; }
      flushState(true);
    } else if (document.visibilityState === 'visible') {
      if (booted && Date.now() - lastRefresh > 10 * 60 * 1000 && Drive.hasValidToken()) refresh();
    }
  });

  // ---------- 본문과 메모 나누기 ----------
  function splitMd(md) {
    var a = md.indexOf(BS), b = md.indexOf(BE);
    if (a !== -1 && b > a) md = md.slice(0, a) + md.slice(b + BE.length);   // 재독 피드백은 아래 입력란에 보여 줌
    var m = /^(?:-{3,}[ \t]*\n+)?##[ \t]*(정리 메모|독자 반응)[ \t]*$/m.exec(md);
    if (!m) return { body: md, meta: '' };
    return { body: md.slice(0, m.index), meta: md.slice(m.index).replace(/^-{3,}[ \t]*\n+/, '') };
  }

  // ---------- 재독 피드백 ----------
  var fbEp = null, fbIdx = -1, fbKind = '', fbRating = '', fbDirty = false, fbTimer = null, fbSaving = false, fbQueued = false;
  function sameEp(a, b) { return !!(a && b && keyOf(a) === keyOf(b)); }
  function fillFeedback(ep) {
    fbEp = ep; fbIdx = indexOfId(ep.id); fbDirty = false;
    var f = feedback[keyOf(ep)] || {};
    fbRating = f.rating || '';
    fbKind = f.kind || '';
    paintKind();
    $('fbGood').value = f.good || '';
    $('fbBad').value = f.bad || '';
    paintRates();
    $('fbStatus').textContent = f.updated ? '마지막 저장 ' + f.updated : '';
    $('fbMain').style.display = (ep.num <= FEEDBACK_MAX || f.rating || f.good || f.bad) ? '' : 'none';
  }
  function paintKind() {
    if (fbIdx < 0) return;
    var nn = isNotNovelWith(fbIdx, fbKind), cand = candOf(episodes[fbIdx]), why = '';
    if (nn) {
      why = fbKind === 'notnovel' ? '소설 아님으로 표시한 글이에요.' : '설정과 대화 폴더라 기본으로 소설 목록에서 빠져 있어요.';
      $('kindBtn').textContent = '소설 목록에 넣기';
    } else {
      if (!fbKind && cand) why = '소설 아님 후보예요. 자동 판단: ' + cand;
      else if (fbKind === 'novel') why = '소설 맞음으로 표시한 글이에요.';
      else why = '설정·잡담이라면 소설 목록에서 뺄 수 있어요.';
      $('kindBtn').textContent = '📄 소설 아님';
    }
    $('kindDesc').textContent = why;
    if (!nn && !fbKind && cand) {
      $('kindBtn').textContent = '📄 소설 아님';
      $('kindDesc').innerHTML = '';
      $('kindDesc').appendChild(document.createTextNode(why + ' '));
      var keep = document.createElement('button'); keep.textContent = '소설 맞음';
      keep.style.cssText = 'padding:4px 10px;font-size:13px;margin-top:6px';
      keep.onclick = function () { fbKind = 'novel'; paintKind(); scheduleFeedback(500); };
      $('kindDesc').appendChild(keep);
    }
  }
  function isNotNovelWith(i, k) {
    if (k === 'notnovel') return true;
    if (k === 'novel') return false;
    return defaultNotNovel(i);
  }
  $('kindBtn').onclick = function () {
    if (fbIdx < 0) return;
    if (isNotNovelWith(fbIdx, fbKind)) fbKind = defaultNotNovel(fbIdx) ? 'novel' : '';
    else fbKind = 'notnovel';
    paintKind(); scheduleFeedback(500);
  };
  function paintRates() {
    Array.prototype.forEach.call(document.querySelectorAll('.rates button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-r') === fbRating);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.rates button'), function (b) {
    b.onclick = function () {
      var r = b.getAttribute('data-r');
      fbRating = fbRating === r ? '' : r;   // 다시 누르면 해제
      paintRates(); scheduleFeedback(500);
    };
  });
  ['fbGood', 'fbBad'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      fbDirty = true; $('fbStatus').textContent = '입력 중…';
      clearTimeout(fbTimer); fbTimer = setTimeout(saveFeedbackNow, 2500);
    });
  });
  function scheduleFeedback(ms) {
    fbDirty = true;
    clearTimeout(fbTimer);
    if (!fbSaving) $('fbStatus').textContent = '곧 저장';
    fbTimer = setTimeout(saveFeedbackNow, ms);
  }
  function syncSaveBtn() {
    var b = $('fbSave');
    b.disabled = !!fbSaving;
    b.textContent = fbSaving ? '저장 중…' : '저장';
  }
  function feedbackSnapshot(ep) {
    var f = feedback[keyOf(ep)] || {};
    return { rating: f.rating || '', good: f.good || '', bad: f.bad || '', kind: f.kind || '' };
  }
  function sameFeedback(a, b) {
    return (a.rating || '') === (b.rating || '') && String(a.good || '').trim() === String(b.good || '').trim()
      && String(a.bad || '').trim() === String(b.bad || '').trim() && (a.kind || '') === (b.kind || '');
  }
  $('fbSave').onclick = function () { fbDirty = true; saveFeedbackNow(); };
  function flushFeedback() { if (fbDirty) saveFeedbackNow(); }
  function saveFeedbackNow() {
    clearTimeout(fbTimer);
    if (!fbEp || !fbDirty) { syncSaveBtn(); return; }
    if (fbSaving) { fbQueued = true; syncSaveBtn(); return; }
    var ep = fbEp, payload = { rating: fbRating, good: $('fbGood').value, bad: $('fbBad').value, kind: fbKind };
    if (sameFeedback(feedbackSnapshot(ep), payload)) {
      fbDirty = false; fbQueued = false;
      var prev = feedback[keyOf(ep)];
      if (sameEp(fbEp, ep)) $('fbStatus').textContent = prev && prev.updated ? '마지막 저장 ' + prev.updated : '';
      syncSaveBtn();
      return;
    }
    fbDirty = false; fbSaving = true;
    syncSaveBtn();
    $('fbStatus').textContent = '저장 중…';
    var meta = metaOf(ep), k = keyOf(ep);
    (ep.ids || [ep.id]).forEach(function (id) {
      if (cache[id] != null && Core.noteEpisodeText) Core.noteEpisodeText(id, cache[id], id === ep.id ? ep.modified : '');
    });
    localTouch[k] = Date.now();
    Core.saveFeedback(meta, payload).then(function (res) {
      fbSaving = false;
      localTouch[k] = Date.now();
      if (res.item) feedback[k] = res.item; else delete feedback[k];
      if (legacyFb[k]) { delete feedback[legacyFb[k]]; delete legacyFb[k]; }
      saveListCache();
      if (sameEp(fbEp, ep)) { $('fbStatus').textContent = '저장됨 ' + res.updated + ' · 원본 파일과 모음 파일에 반영'; paintKind(); }
      if (fbQueued) { fbQueued = false; fbDirty = true; saveFeedbackNow(); return; }
      syncSaveBtn();
    }, function (e) {
      fbSaving = false; fbDirty = true; fbQueued = false;
      syncSaveBtn();
      if (sameEp(fbEp, ep)) $('fbStatus').textContent = '저장 실패: ' + errMsg(e) + ' (저장 버튼을 다시 눌러 주세요)';
    });
  }
  window.addEventListener('beforeunload', function (e) {
    if (editDirty() || fbDirty || fbSaving) { saveFeedbackNow(); e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- 본문 교정 (독자 반응·재독 피드백 꼬리는 유지) ----------
  var editing = false, editBody = '', editEp = null, editSeen = false, editPreviewOn = false, editUndo = null;
  function editDirty() { return editing && $('editBox').value !== editBody; }
  function confirmLeaveEdit() {
    if (!editDirty()) return true;
    return window.confirm('고친 본문을 저장하지 않고 나갈까요?');
  }
  function resetEditChrome() {
    editPreviewOn = false; editSeen = false;
    $('editPreview').hidden = true; $('editPreview').innerHTML = '';
    $('editBox').hidden = false;
    $('editPreviewBtn').textContent = '미리보기';
    $('editSave').textContent = '드라이브에 저장';
    $('editSave').disabled = false;
    $('editUndo').hidden = true;
    editUndo = null;
  }
  function closeEdit() {
    if (!editing) return;
    editing = false;
    editEp = null;
    document.body.classList.remove('editing');
    $('editor').hidden = true;
    resetEditChrome();
    applyLayout();
  }
  function showEditPreview(on) {
    editPreviewOn = !!on;
    if (editPreviewOn) {
      var raw = $('editBox').value || '';
      $('editPreview').innerHTML = raw.trim() ? DOMPurify.sanitize(marked.parse(raw)) : '<p class="editnote">(빈 본문)</p>';
      $('editPreview').hidden = false;
      $('editBox').hidden = true;
      $('editPreviewBtn').textContent = '다시 고치기';
      editSeen = true;
      $('editSave').textContent = '이대로 저장';
      window.scrollTo(0, 0);
    } else {
      $('editPreview').hidden = true; $('editPreview').innerHTML = '';
      $('editBox').hidden = false;
      $('editPreviewBtn').textContent = '미리보기';
      $('editBox').focus();
    }
  }
  function loadEditUndo(ep) {
    editUndo = null; $('editUndo').hidden = true;
    idb.get('undo:' + ep.id).then(function (u) {
      if (!editing || !editEp || editEp.id !== ep.id) return;
      if (!u || typeof u.body !== 'string' || u.body === $('editBox').value) return;
      editUndo = u;
      $('editUndo').hidden = false;
    });
  }
  function startEdit() {
    if (editing || arcOpen || arcListing || pos < 0) return;
    var ep = episodes[seq[pos]];
    if (!ep) return;
    flushFeedback();
    hideQuoteBar();
    var openBox = function (text) {
      if (pos < 0 || !episodes[seq[pos]] || episodes[seq[pos]].id !== ep.id) return;
      var parts = Core.splitEditable(text);
      editEp = ep;
      editBody = parts.body;
      resetEditChrome();
      $('editBox').value = parts.body;
      $('editStatus').textContent = (ep.ids && ep.ids.length > 1) ? '같은 글의 사본도 함께 고칩니다.' : '';
      editing = true;
      $('editor').hidden = false;
      document.body.classList.add('editing');
      applyLayout();
      window.scrollTo(0, 0);
      $('editBox').focus();
      loadEditUndo(ep);
    };
    var md = cache[ep.id];
    if (md != null) openBox(md);
    else loadContent(ep).then(openBox, function (e) { toast('본문을 불러오지 못했어요. ' + errMsg(e)); });
  }
  function saveEdit() {
    if (!editing || !editEp || $('editSave').disabled) return;
    var ep = editEp, body = $('editBox').value, previous = editBody;
    if (body === previous) { closeEdit(); return; }
    if (!editSeen) {
      showEditPreview(true);
      $('editStatus').textContent = '이렇게 보입니다. 맞으면 이대로 저장을 누르세요.';
      return;
    }
    $('editSave').disabled = true;
    $('editStatus').textContent = '저장 중…';
    Core.saveEpisodeBody({ id: ep.id, ids: ep.ids || [ep.id] }, body).then(function (res) {
      if (res.changed) idb.put('undo:' + ep.id, { body: previous, at: Date.now() });
      var i = indexOfId(ep.id);
      closeEdit();
      toast(res.changed ? '본문을 저장했어요' : '바꿀 내용이 없어요');
      if (i >= 0) openEpisode(i, seqCat, false);
    }, function (e) {
      $('editSave').disabled = false;
      $('editStatus').textContent = '저장 실패: ' + errMsg(e);
    });
  }
  $('editBox').addEventListener('input', function () {
    if (!editing) return;
    editSeen = false;
    $('editSave').textContent = '드라이브에 저장';
  });
  $('editPreviewBtn').onclick = function () { if (editing) showEditPreview(!editPreviewOn); };
  $('editUndo').onclick = function () {
    if (!editing || !editUndo) return;
    if (!window.confirm('편집 칸을 직전 본문으로 바꿀까요? 드라이브에는 저장을 눌러야 반영됩니다.')) return;
    $('editBox').value = editUndo.body;
    editSeen = false;
    showEditPreview(false);
    $('editSave').textContent = '드라이브에 저장';
    $('editStatus').textContent = '직전 본문을 불러왔어요. 저장해야 드라이브에 반영됩니다.';
  };
  $('editBtn').onclick = $('editBtnEnd').onclick = $('pbEdit').onclick = startEdit;
  $('editCancel').onclick = function () {
    if (!confirmLeaveEdit()) return;
    closeEdit();
    applyLayout();
  };
  $('editSave').onclick = saveEdit;

  // ---------- 쪽 넘기기 ----------
  // page = 지금 보이는 화면(양쪽 보기면 두 쪽 묶음)의 번호, pageCount = 화면 수, cols = 전체 쪽 수
  var page = 0, pageCount = 1, pageStep = 0, curAnchor = 0, textLen = 0, atEnd = false;
  var cols = 1, perView = 1, colW = 0, padL = 0;
  function isPaged() { return readerOpen && !editing && Settings.get().mode === 'page' && !arcForceScroll; }
  /** 양쪽 보기: 자동이면 두 쪽이 넉넉히 들어가는 넓은 화면(폴드 안쪽 화면 등)에서만. 바깥 화면·일반 폰은 한 쪽. */
  function spreadWanted() {
    var m = Settings.get().spread;
    if (m === 'off') return false;
    if (m === 'on') return true;
    return Settings.isWide();
  }
  /** 접히는 부분(힌지): Viewport Segments API 또는 CSS env(viewport-segment-*)에서 좌우 두 구역일 때만 */
  function hingeInfo() {
    var segs = null;
    try {
      if (window.viewport && window.viewport.segments) segs = window.viewport.segments;
      else if (window.visualViewport && window.visualViewport.segments) segs = window.visualViewport.segments;
      else if (typeof window.getWindowSegments === 'function') segs = window.getWindowSegments();
    } catch (e) { segs = null; }
    if (!segs || segs.length !== 2) segs = cssSegments();
    if (!segs || segs.length !== 2) return null;
    var a = segs[0], b = segs[1];
    var aRight = a.left + a.width;
    if (Math.abs((a.top || 0) - (b.top || 0)) > 2 || b.left < aRight) return null;   // 위아래로 접힌 경우는 무시
    return { center: (aRight + b.left) / 2, width: Math.max(0, b.left - aRight) };
  }
  var segProbe = null;
  function cssSegments() {
    if (!segProbe) {
      segProbe = document.createElement('div');
      segProbe.style.cssText = 'position:fixed;top:0;height:0;visibility:hidden;pointer-events:none;' +
        'left:env(viewport-segment-right 0 0, -9999px);width:calc(env(viewport-segment-left 1 0, -9999px) - env(viewport-segment-right 0 0, -9999px));';
      document.body.appendChild(segProbe);
    }
    var r = segProbe.getBoundingClientRect();
    if (r.left <= -9000 || r.width <= -9000 || r.width < 0) return null;
    var vw = document.documentElement.clientWidth;
    return [{ left: 0, top: 0, width: r.left }, { left: r.left + r.width, top: 0, width: vw - r.left - r.width }];
  }
  function resetPagerBox() {
    var pg = $('pager');
    pg.style.left = pg.style.right = pg.style.width = pg.style.maxWidth = pg.style.margin = pg.style.paddingLeft = pg.style.paddingRight = '';
    pg.style.removeProperty('--gutter-x');
  }
  function applyLayout() {
    var paged = isPaged();
    document.body.classList.toggle('paged', paged);
    document.documentElement.classList.toggle('paged-root', paged);
    document.body.classList.toggle('spread', paged && spreadWanted());
    if (!paged) {
      document.body.classList.remove('chrome', 'atEnd'); atEnd = false;
      var f = $('flow'); f.style.width = f.style.columnWidth = f.style.columnGap = f.style.columnCount = f.style.transform = '';
      resetPagerBox();
    }
  }
  function paginate() {
    var pager = $('pager'), flow = $('flow');
    var spread = document.body.classList.contains('spread');
    resetPagerBox();
    var hinge = spread ? hingeInfo() : null;
    if (hinge) {
      // 두 쪽 사이 홈을 힌지 한가운데에 맞춘다: 힌지 중심을 기준으로 좌우 대칭인 상자, 홈 너비 = 여백×2 + 힌지 폭
      var vw = document.documentElement.clientWidth, half = Math.floor(Math.min(hinge.center, vw - hinge.center));
      var mxs = Settings.get().mx;
      pager.style.left = (hinge.center - half) + 'px'; pager.style.right = 'auto';
      pager.style.width = (2 * half) + 'px'; pager.style.maxWidth = 'none'; pager.style.margin = '0';
      pager.style.paddingLeft = pager.style.paddingRight = (mxs + Math.ceil(hinge.width / 2)) + 'px';
    }
    var cs = getComputedStyle(pager);
    var pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
    var step = pager.clientWidth;
    if (spread && !hinge && step % 2) { pager.style.width = (step - 1) + 'px'; step = pager.clientWidth; }
    var H = pager.clientHeight;
    var W = Math.max(80, step - pl - pr), gap = pl + pr;   // 화면 이동 폭 = 쪽 수 × (쪽 폭 + 간격)이 되도록 간격 = 좌우 여백 합
    perView = spread ? 2 : 1;
    colW = spread ? Math.max(40, (W - gap) / 2) : W;
    padL = pl;
    flow.style.width = W + 'px';
    flow.style.columnWidth = colW + 'px';
    flow.style.columnCount = spread ? '2' : 'auto';
    flow.style.columnGap = gap + 'px';
    document.documentElement.style.setProperty('--pageH', Math.max(100, Math.floor(H * 0.92)) + 'px');
    flow.style.transform = 'none';
    pageStep = step || 1;
    var fr = flow.getBoundingClientRect(), er = $('flowEnd').getBoundingClientRect();
    var colStep = pageStep / perView;
    cols = Math.max(1, Math.floor((er.left - fr.left + 1) / colStep) + 1);
    pageCount = Math.max(1, Math.ceil(cols / perView));
    if (page > pageCount - 1) page = pageCount - 1;
    flow.style.transform = 'translate3d(' + (-page * pageStep) + 'px,0,0)';
    return pageCount;
  }
  function goPage(n, user) {
    page = Math.max(0, Math.min(pageCount - 1, n));
    $('flow').style.transform = 'translate3d(' + (-page * pageStep) + 'px,0,0)';
    var a = page * perView + 1, b = Math.min(cols, a + perView - 1);
    $('pageNum').textContent = '쪽 ' + (a === b ? a : a + '–' + b) + ' / ' + cols;
    $('pageProg').style.width = ((page + 1) / pageCount * 100) + '%';
    if (user) {
      curAnchor = probeAnchor();
      if (!arcOpen) { saveScroll(); scheduleStateSync(); }
    }
  }
  function hasEndPage() { return !arcOpen && (!!$('meta').childNodes.length || $('fbMain').style.display !== 'none'); }
  function showEnd() {
    if (!isPaged()) { $('meta').scrollIntoView({ block: 'start' }); return; }
    atEnd = true; document.body.classList.add('atEnd'); document.body.classList.remove('chrome');
    $('after').scrollTop = 0;
  }
  function hideEnd(silent) {
    if (!atEnd && !document.body.classList.contains('atEnd')) return;
    atEnd = false; document.body.classList.remove('atEnd');
    if (!silent) goPage(pageCount - 1, true);
  }
  function nextPage() {
    document.body.classList.remove('chrome');
    if (atEnd) { if (pos < seq.length - 1) next(); else toast('마지막 화예요.'); return; }
    if (page < pageCount - 1) { goPage(page + 1, true); return; }
    if (arcOpen) { if (arc.i < arc.list.length - 1) openArcFile(arc.i + 1, true); else toast('이 폴더의 마지막 파일이에요.'); return; }
    if (hasEndPage()) { showEnd(); return; }
    if (pos < seq.length - 1) next(); else toast('마지막 화예요.');
  }
  function prevPage() {
    document.body.classList.remove('chrome');
    if (atEnd) { hideEnd(); return; }
    if (page > 0) { goPage(page - 1, true); return; }
    if (arcOpen) { if (arc.i > 0) openArcFile(arc.i - 1, true, { end: true }); else toast('이 폴더의 첫 파일이에요.'); return; }
    if (pos > 0) openEpisode(seq[pos - 1], seqCat, true, { end: true });
    else toast('첫 화예요.');
  }
  function relayout() {
    if (!isPaged()) return;
    applyLayout();   // 접고 펴면 양쪽 보기 여부도 다시 정한다
    paginate();
    goPage(pageOfChar(curAnchor));
  }
  var relayoutRaf = 0;
  function scheduleRelayout() {
    if (!isPaged()) return;
    cancelAnimationFrame(relayoutRaf);
    relayoutRaf = requestAnimationFrame(relayout);
  }
  if (window.ResizeObserver) new ResizeObserver(scheduleRelayout).observe($('pager'));
  window.addEventListener('resize', scheduleRelayout);
  document.addEventListener('fullscreenchange', scheduleRelayout);   // 상태표시줄이 숨거나 보이면 높이가 바뀐다
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', scheduleRelayout);
  Settings.onFontLoaded(scheduleRelayout);
  function watchImages() {
    Array.prototype.forEach.call($('article').querySelectorAll('img'), function (img) {
      if (!img.complete) img.addEventListener('load', scheduleRelayout, { once: true });
    });
  }

  // 글자 위치 <-> 화면 위치 (설정을 바꾸거나 화면이 돌아가도 읽던 곳을 유지)
  var OVERLAYS = ['sheet', 'sheetBack', 'pageBar', 'pageInfo', 'authBar', 'toast'];
  function caretAt(x, y) {
    // 설정 시트 등 위에 떠 있는 것은 잠깐 숨겨야 본문 글자를 짚을 수 있다 (같은 순간에 되돌려 화면엔 안 보임)
    var hidden = [];
    OVERLAYS.forEach(function (id) { var el = $(id); if (el && !el.hidden) { hidden.push([el, el.style.visibility]); el.style.visibility = 'hidden'; } });
    try { return caretAtRaw(x, y); }
    finally { hidden.forEach(function (h) { h[0].style.visibility = h[1]; }); }
  }
  function caretAtRaw(x, y) {
    if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    return null;
  }
  function offsetOf(node, off) {
    var art = $('article');
    if (!art.contains(node)) return null;
    var r = document.createRange();
    r.setStart(art, 0);
    try { r.setEnd(node, off); } catch (e) { return null; }
    return r.toString().length;
  }
  function rectOfChar(off) {
    var art = $('article');
    var w = document.createTreeWalker(art, NodeFilter.SHOW_TEXT), n, acc = 0;
    while ((n = w.nextNode())) {
      var len = n.data.length;
      if (acc + len > off && /\S/.test(n.data.slice(Math.max(0, off - acc)))) {
        var lo = Math.max(0, off - acc);
        while (lo < len - 1 && /\s/.test(n.data.charAt(lo))) lo++;
        var r = document.createRange();
        r.setStart(n, lo); r.setEnd(n, Math.min(len, lo + 1));
        var rs = r.getClientRects();
        if (rs.length) return rs[0];
        return n.parentElement ? n.parentElement.getBoundingClientRect() : null;
      }
      acc += len;
    }
    return null;
  }
  function pageOfChar(off) {
    if (!off) return 0;
    var r = rectOfChar(off);
    if (!r) return off >= textLen ? pageCount - 1 : 0;
    var fr = $('flow').getBoundingClientRect();
    return Math.max(0, Math.min(pageCount - 1, Math.floor((r.left + r.width / 2 - fr.left) / pageStep)));
  }
  function probeAnchor() {
    if (!isPaged()) return probeAnchorScroll();
    if (page === 0) return 0;
    var pr = $('pager').getBoundingClientRect();
    var x0 = pr.left + padL, W = colW;   // 이 화면의 첫 쪽 왼쪽 위부터 짚어 본다
    for (var dy = 2; dy < pr.height * 0.7; dy += 6) {
      var xs = [2, W * 0.25, W * 0.5, W * 0.75];
      for (var k = 0; k < xs.length; k++) {
        var c = caretAt(x0 + xs[k], pr.top + dy);
        if (!c) continue;
        var off = offsetOf(c.node, c.offset);
        if (off != null && pageOfChar(off) === page) return off;
      }
    }
    return Math.round(page / pageCount * textLen);
  }
  function headerBottom() { var h = document.querySelector('header').getBoundingClientRect(); return Math.max(0, h.bottom); }
  function probeAnchorScroll() {
    var art = $('article'), ar = art.getBoundingClientRect(), hb = headerBottom();
    if (window.scrollY < 8 || ar.top >= hb) return 0;
    if (ar.bottom <= hb) return textLen;
    for (var dy = 4; dy < 220; dy += 6) {
      var xs = [2, ar.width * 0.3, ar.width * 0.6];
      for (var k = 0; k < xs.length; k++) {
        var c = caretAt(ar.left + xs[k], hb + dy);
        if (!c) continue;
        var off = offsetOf(c.node, c.offset);
        if (off != null) return off;
      }
    }
    return null;
  }
  function scrollToChar(off) {
    if (!off) { window.scrollTo(0, 0); return; }
    var r = rectOfChar(off);
    if (!r) return;
    window.scrollTo(0, Math.max(0, window.scrollY + r.top - headerBottom() - 10));
  }

  // 탭 영역: 오른쪽 40% 다음 쪽, 왼쪽 30% 이전 쪽, 가운데 메뉴. 옆으로 밀기도 된다.
  var pd = null, swallowClickUntil = 0, wheelAt = 0;
  function interactive(t) { return !!(t && t.closest && t.closest('button, a, input, textarea, select, summary, details, label')); }
  $('reader').addEventListener('pointerdown', function (e) {
    if (!isPaged() || !e.isPrimary) return;
    if (e.target.closest('textarea, input')) { pd = null; return; }
    pd = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  $('reader').addEventListener('pointercancel', function () { pd = null; });
  $('reader').addEventListener('pointerup', function (e) {
    if (!isPaged() || !pd) return;
    var dx = e.clientX - pd.x, dy = e.clientY - pd.y; pd = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      swallowClickUntil = Date.now() + 500;
      if (dx < 0) nextPage(); else prevPage();
    }
  });
  $('reader').addEventListener('click', function (e) {
    if (!isPaged() || atEnd) return;
    if (Date.now() < swallowClickUntil) return;
    if (interactive(e.target)) return;
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;
    var fx = e.clientX / window.innerWidth;
    if (fx >= 0.6) nextPage();
    else if (fx < 0.3) prevPage();
    else document.body.classList.toggle('chrome');
  });
  $('reader').addEventListener('wheel', function (e) {
    if (!isPaged() || atEnd || Math.abs(e.deltaY) < 4) return;
    var now = Date.now();
    if (now - wheelAt < 280) return;
    wheelAt = now;
    if (e.deltaY > 0) nextPage(); else prevPage();
  }, { passive: true });
  $('backToText').onclick = function () { hideEnd(); };
  $('pbEnd').onclick = showEnd;

  // ---------- 문장을 눌러 피드백에 넣기 ----------
  var quotePicks = [], quoteTimer = null, quoteHold = null, quoteSeq = 0, quoteLong = false;
  var QUOTE_MAX = 12;
  function hideQuoteBar() {
    quotePicks = [];
    if (window.CSS && CSS.highlights) CSS.highlights.delete('picked');
    var bar = $('quoteBar');
    if (bar) bar.hidden = true;
    if ($('quoteText')) $('quoteText').textContent = '';
  }
  function qid(el) {
    if (!el.dataset.qid) el.dataset.qid = String(++quoteSeq);
    return el.dataset.qid;
  }
  function linesInBlock(block) {
    var lines = [], acc = 0, start = 0, buf = '';
    function flush() {
      var raw = buf;
      buf = '';
      if (!raw.trim()) return;
      var lead = (raw.match(/^\s*/) || [''])[0].length;
      var trail = (raw.match(/\s*$/) || [''])[0].length;
      var body = raw.slice(lead, raw.length - trail).replace(/\s+/g, ' ').trim();
      if (body.length < 2) return;
      lines.push({ text: body, start: start + lead, end: start + raw.length - trail });
    }
    function walk(node) {
      if (node.nodeType === 3) {
        var parts = node.data.split('\n');
        for (var i = 0; i < parts.length; i++) {
          if (!buf) start = acc;
          buf += parts[i];
          acc += parts[i].length;
          if (i < parts.length - 1) { acc += 1; flush(); }
        }
        return;
      }
      if (node.nodeName === 'BR') { flush(); return; }
      for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
    }
    walk(block);
    flush();
    return lines;
  }
  function lineAt(lines, off) {
    var best = null, dist = 1e9, i;
    for (i = 0; i < lines.length; i++) {
      if (off >= lines[i].start && off <= lines[i].end) return lines[i];
      var d = off < lines[i].start ? lines[i].start - off : off - lines[i].end;
      if (d < dist) { dist = d; best = lines[i]; }
    }
    return best;
  }
  function blockOf(node) {
    var art = $('article'), el = node && node.nodeType === 1 ? node : node && node.parentNode;
    while (el && el !== art && !/^(P|LI|BLOCKQUOTE|H1|H2|H3|H4|H5|H6|TD|FIGCAPTION)$/.test(el.tagName || '')) el = el.parentNode;
    return el && el !== art ? el : (node && node.parentNode) || art;
  }
  function makePick(block, s) {
    if (!block || !s || !s.text) return null;
    return { key: qid(block) + ':' + s.start, text: s.text, block: block, start: s.start, end: s.end };
  }
  function charOff(block, node, offset) {
    if (!block.contains(node)) return null;
    var r = document.createRange();
    try { r.setStart(block, 0); r.setEnd(node, offset); }
    catch (e) { return null; }
    return r.toString().length;
  }
  function sentenceFromPoint(x, y) {
    var c = caretAt(x, y);
    if (!c || !$('article').contains(c.node)) return null;
    var block = blockOf(c.node);
    if (block.querySelector && block.querySelector('p, li, blockquote')) {
      var inner = c.node.nodeType === 1 ? c.node : c.node.parentNode;
      var tighter = blockOf(inner);
      if (tighter && tighter !== block) block = tighter;
    }
    var off = charOff(block, c.node, c.offset);
    if (off == null) return null;
    return makePick(block, lineAt(linesInBlock(block), off));
  }
  function sentencesFromSelection() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
    var range = sel.getRangeAt(0);
    var art = $('article');
    if (!art.contains(range.startContainer) || !art.contains(range.endContainer)) return [];
    var nodes = art.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6, td, figcaption');
    var picks = [];
    Array.prototype.forEach.call(nodes, function (block) {
      if (block.querySelector('p, li, blockquote')) return;
      if (!range.intersectsNode(block)) return;
      var full = block.textContent || '';
      var a = block.contains(range.startContainer) ? charOff(block, range.startContainer, range.startOffset) : 0;
      var b = block.contains(range.endContainer) ? charOff(block, range.endContainer, range.endOffset) : full.length;
      if (a == null) a = 0;
      if (b == null) b = full.length;
      if (b < a) { var tmp = a; a = b; b = tmp; }
      linesInBlock(block).forEach(function (s) {
        if (s.end <= a || s.start >= b) return;
        var p = makePick(block, s);
        if (p) picks.push(p);
      });
    });
    return picks;
  }
  function pointAt(block, charOff) {
    var w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT), n, acc = 0;
    while ((n = w.nextNode())) {
      if (acc + n.data.length >= charOff) return { node: n, offset: Math.max(0, charOff - acc) };
      acc += n.data.length;
    }
    return n ? { node: n, offset: n.data.length } : null;
  }
  function paintQuotes() {
    if (window.CSS && CSS.highlights) CSS.highlights.delete('picked');
    if (!quotePicks.length) { $('quoteBar').hidden = true; $('quoteText').textContent = ''; return; }
    quotePicks.sort(function (a, b) {
      if (a.block === b.block) return a.start - b.start;
      var pos = a.block.compareDocumentPosition(b.block);
      return pos & 4 ? -1 : 1;
    });
    $('quoteText').textContent = (quotePicks.length > 1 ? quotePicks.length + '줄\n' : '') + quotePicks.map(function (p) { return p.text; }).join('\n');
    $('quoteBar').hidden = false;
    if (!(window.CSS && CSS.highlights && window.Highlight)) return;
    var ranges = [];
    quotePicks.forEach(function (p) {
      if (!p.block || !p.block.isConnected) return;
      var a = pointAt(p.block, p.start), b = pointAt(p.block, p.end);
      if (!a || !b) return;
      var r = document.createRange();
      try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); ranges.push(r); } catch (e) {}
    });
    if (ranges.length) {
      var hl = new Highlight();
      ranges.forEach(function (r) { hl.add(r); });
      CSS.highlights.set('picked', hl);
    }
  }
  function togglePick(p) {
    if (!p) return;
    var i = -1;
    for (var k = 0; k < quotePicks.length; k++) if (quotePicks[k].key === p.key) i = k;
    if (i >= 0) quotePicks.splice(i, 1);
    else if (quotePicks.length >= QUOTE_MAX) { toast('한 번에 ' + QUOTE_MAX + '줄까지예요'); return; }
    else quotePicks.push(p);
    paintQuotes();
  }
  function addPicks(list) {
    var added = 0;
    list.forEach(function (p) {
      if (!p) return;
      for (var k = 0; k < quotePicks.length; k++) if (quotePicks[k].key === p.key) return;
      if (quotePicks.length >= QUOTE_MAX) return;
      quotePicks.push(p); added++;
    });
    if (list.length && added === 0 && quotePicks.length >= QUOTE_MAX) toast('한 번에 ' + QUOTE_MAX + '줄까지예요');
    paintQuotes();
  }
  function clearSel() {
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
  }
  function addQuote(which) {
    if (!quotePicks.length || !fbEp) { hideQuoteBar(); return; }
    var box = $(which === 'good' ? 'fbGood' : 'fbBad');
    var cur = box.value.replace(/\s+$/, '');
    var fresh = [];
    quotePicks.forEach(function (p) {
      var line = '「' + p.text + '」';
      if (cur.indexOf(line) === -1 && fresh.indexOf(line) === -1) fresh.push(line);
    });
    if (!fresh.length) { toast('이미 들어가 있어요'); hideQuoteBar(); return; }
    box.value = cur ? cur + '\n' + fresh.join('\n') : fresh.join('\n');
    var n = fresh.length;
    hideQuoteBar();
    scheduleFeedback(400);
    toast(n > 1 ? n + '줄을 ' + (which === 'good' ? '좋았던 점' : '아쉬웠던 점') + '에 넣었어요' : (which === 'good' ? '좋았던 점에 넣었어요' : '아쉬웠던 점에 넣었어요'));
  }
  $('quoteGood').onclick = function () { addQuote('good'); };
  $('quoteBad').onclick = function () { addQuote('bad'); };
  $('quoteClose').onclick = hideQuoteBar;
  $('article').addEventListener('click', function (e) {
    if (arcOpen || editing || isPaged() || interactive(e.target)) return;
    var many = sentencesFromSelection();
    if (many.length) { addPicks(many); clearSel(); return; }
    togglePick(sentenceFromPoint(e.clientX, e.clientY));
  });
  $('article').addEventListener('pointerdown', function (e) {
    if (!isPaged() || arcOpen || editing || !e.isPrimary || interactive(e.target)) return;
    quoteLong = false;
    quoteHold = { x: e.clientX, y: e.clientY };
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(function () {
      quoteTimer = null;
      var hold = quoteHold; quoteHold = null;
      if (!hold) return;
      quoteLong = true;
      swallowClickUntil = Date.now() + 700;
      togglePick(sentenceFromPoint(hold.x, hold.y));
    }, 480);
  });
  $('article').addEventListener('pointermove', function (e) {
    if (!quoteHold) return;
    if (Math.abs(e.clientX - quoteHold.x) > 12 || Math.abs(e.clientY - quoteHold.y) > 12) {
      clearTimeout(quoteTimer); quoteTimer = null; quoteHold = null;
    }
  });
  function clearQuoteHold() { clearTimeout(quoteTimer); quoteTimer = null; quoteHold = null; }
  $('article').addEventListener('pointerup', function () {
    clearQuoteHold();
    setTimeout(function () {
      if (!isPaged() || editing || arcOpen || quoteLong) { quoteLong = false; return; }
      var many = sentencesFromSelection();
      if (many.length) { swallowClickUntil = Date.now() + 600; addPicks(many); clearSel(); }
    }, 40);
  });
  $('article').addEventListener('pointercancel', clearQuoteHold);

  // 보기 설정이 바뀌면: 읽던 글자 위치를 기억했다가 다시 맞춘다.
  var LAYOUT_KEYS = ['font', 'fs', 'lh', 'ps', 'mx', 'align', 'indent', 'spread'];
  var pendingAnchor = null;
  Settings.onBeforeChange(function (ch) {
    pendingAnchor = null;
    if (!readerOpen) return;
    if (ch.mode || LAYOUT_KEYS.some(function (k) { return ch[k]; })) {
      pendingAnchor = isPaged() ? curAnchor : probeAnchorScroll();
    }
  });
  Settings.onChange(function (ch) {
    if (!readerOpen) return;
    var a = pendingAnchor; pendingAnchor = null;
    if (ch.mode) {
      applyLayout();
      if (isPaged()) {
        curAnchor = a || 0; paginate(); goPage(pageOfChar(curAnchor));
      } else {
        window.scrollTo(0, 0);
        if (a) scrollToChar(a);
      }
      saveScroll(); scheduleStateSync();
      return;
    }
    if (a == null) return;
    if (isPaged()) { curAnchor = a; applyLayout(); paginate(); goPage(pageOfChar(curAnchor)); }
    else if (a) scrollToChar(a);
  });

  // ---------- 버튼 ----------
  function prev() {
    if (arcOpen) { if (arc.i > 0) openArcFile(arc.i - 1, true); return; }
    if (pos > 0) openEpisode(seq[pos - 1], seqCat, true);
  }
  function next() {
    if (arcOpen) { if (arc.i < arc.list.length - 1) openArcFile(arc.i + 1, true); return; }
    if (pos >= 0 && pos < seq.length - 1) openEpisode(seq[pos + 1], seqCat, true);
  }
  $('prevTop').onclick = $('prevBottom').onclick = $('pbPrev').onclick = prev;
  $('nextTop').onclick = $('nextBottom').onclick = $('pbNext').onclick = next;
  $('listTop').onclick = $('listBottom').onclick = $('pbList').onclick = function () {
    if (arcOpen) { showArchive(arc.stack, true); return; }
    showHome(true);
  };
  $('backBtn').onclick = function () {
    if (arcOpen) { showArchive(arc.stack, true); return; }
    if (arcListing) { if (arc.stack.length > 1) showArchive(arc.stack.slice(0, -1), true); else showHome(true, true); return; }
    showHome(true);
  };
  document.addEventListener('keydown', function (e) {
    if ((pos < 0 && !arcOpen) || Settings.isOpen() || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (isPaged()) {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) { e.preventDefault(); nextPage(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); prevPage(); }
      return;
    }
    if (e.key === 'ArrowLeft') prev();
    if (e.key === 'ArrowRight') next();
  });

  window.addEventListener('popstate', function (e) {
    if (editing && !confirmLeaveEdit()) {
      var stay = editEp;
      if (stay) history.pushState({ view: 'ep', id: stay.id, cat: seqCat }, '', epUrl(stay));
      return;
    }
    closeEdit();
    var s = e.state || {};
    if (s.view === 'arc' && s.stack && s.stack.length) { showArchive(s.stack, false); return; }
    if (s.view === 'arcfile' && s.stack && s.stack.length) { reopenArcFile(s.stack, s.fid); return; }
    if (s.view === 'ep') { var i = indexOfId(s.id); if (i >= 0) { openEpisode(i, s.cat || '', false); return; } }
    showHome(false);
  });


  // ---------- 보관 폴더 (목록에서 빠진 폴더를 읽기 전용으로 둘러보기) ----------
  // 드라이브에는 목록 조회·내려받기(GET)만 한다. 피드백·소설 아님·읽은 위치 기록 없음.
  var arc = { stack: [], files: [], list: [], i: -1 };
  var arcOpen = false;        // 보관 폴더의 파일을 읽는 중
  var arcListing = false;     // 보관 폴더 목록을 보는 중
  var arcForceScroll = false; // 아주 큰 파일은 쪽 넘기기 대신 스크롤
  var arcMem = {};            // 폴더 ID -> {at, files} (이번 실행 동안)
  var arcScroll = {};         // 폴더 ID -> 목록 스크롤 위치
  var ARC_BIG = 3 * 1024 * 1024;
  var ARC_PAGED_MAX = 600000; // 이보다 긴 글은 쪽 나누기가 느려져서 스크롤로 보여 준다
  var NAV_TEXT = { prevTop: '← 이전 화', prevBottom: '← 이전 화', pbPrev: '← 이전 화', nextTop: '다음 화 →', nextBottom: '다음 화 →', pbNext: '다음 화 →' };
  var NAV_ARC = { prevTop: '← 이전 파일', prevBottom: '← 이전 파일', pbPrev: '← 이전 파일', nextTop: '다음 파일 →', nextBottom: '다음 파일 →', pbNext: '다음 파일 →' };
  function setNavText(m) { Object.keys(m).forEach(function (id) { $(id).textContent = m[id]; }); }
  function arcState() { return { open: arcOpen, listing: arcListing, folder: arc.stack.length ? arc.stack[arc.stack.length - 1].id : null, i: arc.i, n: arc.list.length, forceScroll: arcForceScroll }; }
  function leaveArc() {
    if (arcListing && arc.stack.length) arcScroll[arc.stack[arc.stack.length - 1].id] = window.scrollY;
    if (arcOpen) { setNavText(NAV_TEXT); $('pbEnd').hidden = false; document.body.classList.remove('arcfile'); }
    arcOpen = false; arcListing = false;
    if (arcForceScroll) { arcForceScroll = false; }
  }
  /** 폴더 목록: 이번 실행 기억 → IndexedDB 저장본 → 드라이브. 목록을 새로 고친 뒤(lastRefresh)라면 뒤에서 다시 받아 맞춘다. */
  function arcLoad(id, force, onFresh) {
    var mem = arcMem[id];
    if (mem && !force && mem.at >= lastRefresh) return Promise.resolve(mem.files);
    var net = function () {
      return Core.listArchiveFolder(id).then(function (files) {
        var rec = { at: Date.now(), files: files };
        arcMem[id] = rec; idb.put('arc:' + id, rec);
        return files;
      });
    };
    if (force) return net();
    if (mem) { net().then(function (f) { if (onFresh) onFresh(f); }, function () {}); return Promise.resolve(mem.files); }
    return idb.get('arc:' + id).then(function (hit) {
      if (hit && hit.files) {
        arcMem[id] = hit;
        if (hit.at < lastRefresh || !lastRefresh) net().then(function (f) { if (onFresh) onFresh(f); }, function () {});
        return hit.files;
      }
      return net();
    });
  }
  function isFolder(f) { return f.mimeType === Drive.FOLDER_MIME; }
  function fmtSize(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
    return (Math.round(n / 1024 / 1024 * 10) / 10) + 'MB';
  }
  function fmtDate(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var t = new Date(d.getTime() + 9 * 3600e3), p = function (x) { return (x < 10 ? '0' : '') + x; };
    return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) + ' ' + p(t.getUTCHours()) + ':' + p(t.getUTCMinutes());
  }
  function countText(files) {
    var nf = files.filter(function (f) { return !isFolder(f); }).length, nd = files.length - nf;
    return '파일 ' + nf + (nd ? ' · 폴더 ' + nd : '');
  }
  /** 파일 종류: 확장자 먼저, 없으면 mimeType */
  function arcKind(f) {
    var n = f.name.toLowerCase(), mt = f.mimeType || '';
    if (mt === 'application/vnd.google-apps.document') return 'gdoc';
    if (/\.(md|markdown)$/.test(n)) return 'md';
    if (/\.txt$/.test(n)) return 'txt';
    if (/\.json$/.test(n)) return 'json';
    if (/\.html?$/.test(n)) return 'html';
    if (mt.indexOf('application/vnd.google-apps.') === 0) return 'info';
    if (mt === 'text/markdown') return 'md';
    if (mt === 'application/json') return 'json';
    if (mt === 'text/html') return 'html';
    if (mt === 'text/plain') return 'txt';
    return 'info';
  }
  var KIND_ICON = { md: '📄', txt: '📄', gdoc: '📝', json: '🧾', html: '🌐', info: '📎' };

  // 홈 맨 아래 '보관 폴더' (접힌 상태, 처음 펼칠 때만 불러온다)
  var arcRootsDrawn = false;
  function drawArcRoots() {
    var ul = $('arcRoots'); ul.innerHTML = '';
    archiveRoots.forEach(function (r) {
      var li = document.createElement('li');
      li.setAttribute('data-id', r.id);
      li.innerHTML = '<span class="ai">🗂</span><span class="t"><span class="an"></span><span class="ao"></span></span><span class="ac">…</span>';
      li.querySelector('.an').textContent = r.label;
      li.querySelector('.ao').textContent = r.path;
      li.onclick = function () { showArchive([{ id: r.id, label: r.label, name: r.name }], true); };
      ul.appendChild(li);
      arcLoad(r.id, false, function (f) { li.querySelector('.ac').textContent = countText(f); }).then(function (files) {
        li.querySelector('.ac').textContent = countText(files);
      }, function () { li.querySelector('.ac').textContent = '불러오지 못함'; });
    });
    arcRootsDrawn = true;
  }
  $('arcEntry').addEventListener('toggle', function () { if ($('arcEntry').open && !arcRootsDrawn) drawArcRoots(); });

  function arcHeader(stack) { return '보관 폴더 · ' + stack[stack.length - 1].label; }
  function crumbs(stack) {
    var nav = $('arcCrumbs'); nav.innerHTML = '';
    var top = document.createElement('button'); top.textContent = '보관 폴더'; top.className = 'crumb';
    top.onclick = function () { showHome(true, true); };
    nav.appendChild(top);
    stack.forEach(function (f, k) {
      var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›'; nav.appendChild(sep);
      var b = document.createElement('button'); b.className = 'crumb'; b.textContent = f.label;
      if (k === stack.length - 1) { b.disabled = true; b.setAttribute('aria-current', 'page'); }
      else b.onclick = function () { showArchive(stack.slice(0, k + 1), true); };
      nav.appendChild(b);
    });
  }
  function showArchive(stack, push) {
    flushFeedback();
    flushState(false);   // 앞서 읽던 화의 기록은 들어가기 전에 마무리
    if (arcListing && arc.stack.length) arcScroll[arc.stack[arc.stack.length - 1].id] = window.scrollY;
    if (pos < 0 && !arcOpen && !arcListing) homeScroll = window.scrollY;
    if (pos >= 0) { saveScroll(); }
    if (arcOpen) { setNavText(NAV_TEXT); $('pbEnd').hidden = false; document.body.classList.remove('arcfile'); }
    arcOpen = false; arcForceScroll = false;
    pos = -1; openSeqNo++;
    readerOpen = false; applyLayout(); hideEnd(true);
    Settings.setReading(false);
    safeSet('inReader', '');
    arcListing = true;
    arc.stack = stack.map(function (f) { return { id: f.id, label: f.label, name: f.name }; });
    var cur = arc.stack[arc.stack.length - 1];
    $('home').style.display = 'none'; $('reader').style.display = 'none';
    $('archive').style.display = 'block';
    $('backBtn').style.display = 'inline-block';
    $('headTitle').textContent = arcHeader(arc.stack);
    crumbs(arc.stack);
    if (push) history.pushState({ view: 'arc', stack: arc.stack }, '', homeUrl() + '?arc=' + encodeURIComponent(cur.id));
    $('arcList').innerHTML = ''; $('arcCount').textContent = '';
    $('arcStatus').style.display = 'block'; $('arcStatus').textContent = '폴더를 불러오는 중이에요…';
    var my = ++arcSeqNo;
    var draw = function (files) {
      if (my !== arcSeqNo || !arcListing) return;
      arc.files = files;
      var y = arcScroll[cur.id] || 0;
      drawArcList(files);
      window.scrollTo(0, y);
    };
    arcLoad(cur.id, false, draw).then(draw, function (e) {
      if (my !== arcSeqNo) return;
      $('arcStatus').textContent = '폴더를 불러오지 못했어요: ' + errMsg(e);
    });
  }
  var arcSeqNo = 0;
  function drawArcList(files) {
    var ul = $('arcList'); ul.innerHTML = '';
    $('arcStatus').style.display = files.length ? 'none' : 'block';
    $('arcStatus').textContent = files.length ? '' : '비어 있는 폴더예요.';
    $('arcCount').textContent = countText(files);
    var plain = files.filter(function (f) { return !isFolder(f); });
    files.forEach(function (f) {
      var li = document.createElement('li');
      li.setAttribute('data-id', f.id);
      var k = isFolder(f) ? 'dir' : arcKind(f);
      li.className = 'arc-' + k;
      li.innerHTML = '<span class="ai"></span><span class="t"><span class="an"></span><span class="ao"></span></span>';
      li.querySelector('.ai').textContent = k === 'dir' ? '📁' : KIND_ICON[k];
      li.querySelector('.an').textContent = f.name;
      li.querySelector('.ao').textContent = k === 'dir' ? '폴더' : [fmtSize(f.size), fmtDate(f.modifiedTime)].filter(Boolean).join(' · ');
      li.onclick = function () {
        if (k === 'dir') { showArchive(arc.stack.concat([{ id: f.id, label: f.name, name: f.name }]), true); return; }
        arcScroll[arc.stack[arc.stack.length - 1].id] = window.scrollY;
        arc.list = plain;
        openArcFile(plain.indexOf(f), true);
      };
      ul.appendChild(li);
    });
  }
  $('arcRefresh').onclick = function () {
    if (!arc.stack.length) return;
    var cur = arc.stack[arc.stack.length - 1];
    $('arcStatus').style.display = 'block'; $('arcStatus').textContent = '새로 불러오는 중이에요…';
    arcLoad(cur.id, true).then(function (files) { if (arcListing) { arc.files = files; drawArcList(files); } }, function (e) {
      $('arcStatus').textContent = '새로 불러오지 못했어요: ' + errMsg(e);
    });
  };
  function reopenArcFile(stack, fid) {
    arc.stack = stack;
    var cur = stack[stack.length - 1];
    arcLoad(cur.id).then(function (files) {
      arc.files = files; arc.list = files.filter(function (f) { return !isFolder(f); });
      var i = -1; arc.list.forEach(function (f, k) { if (f.id === fid) i = k; });
      if (i < 0) showArchive(stack, false); else openArcFile(i, false);
    }, function () { showArchive(stack, false); });
  }
  function arcInfo(f, note) {
    var box = document.createElement('div'); box.className = 'arcinfo';
    var h = document.createElement('h2'); h.textContent = f.name; box.appendChild(h);
    var dl = document.createElement('dl');
    [['종류', f.mimeType || '-'], ['크기', fmtSize(f.size) || '-'], ['수정', fmtDate(f.modifiedTime) || '-']].forEach(function (r) {
      var dt = document.createElement('dt'); dt.textContent = r[0]; var dd = document.createElement('dd'); dd.textContent = r[1];
      dl.appendChild(dt); dl.appendChild(dd);
    });
    box.appendChild(dl);
    if (note) { var p = document.createElement('p'); p.className = 'note'; p.textContent = note; box.appendChild(p); }
    var a = document.createElement('a'); a.className = 'drivelink';
    a.href = 'https://drive.google.com/file/d/' + encodeURIComponent(f.id) + '/view';
    a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '구글 드라이브에서 열기';
    box.appendChild(a);
    return box;
  }
  function openArcFile(i, push, p) {
    if (i < 0 || i >= arc.list.length) return;
    p = p || {};
    var f = arc.list[i], cur = arc.stack[arc.stack.length - 1];
    if (arcListing) arcScroll[cur.id] = window.scrollY;
    arcListing = false; arcOpen = true; arc.i = i;
    pos = -1;
    arcForceScroll = false;
    $('home').style.display = 'none'; $('archive').style.display = 'none';
    $('reader').style.display = 'block';
    $('backBtn').style.display = 'inline-block';
    $('fb').style.display = 'none';
    $('editBtn').hidden = true;
    $('pbEdit').hidden = true;
    $('pbEnd').hidden = true;
    document.body.classList.add('arcfile');
    setNavText(NAV_ARC);
    $('headTitle').textContent = arcHeader(arc.stack);
    $('endTitle').textContent = f.name;
    $('meta').innerHTML = '';
    var setWhere = function () { $('where').textContent = f.name + ' · ' + (i + 1) + ' / ' + arc.list.length; };
    setWhere();
    ['prevTop', 'prevBottom', 'pbPrev'].forEach(function (b) { $(b).disabled = i === 0; });
    ['nextTop', 'nextBottom', 'pbNext'].forEach(function (b) { $(b).disabled = i === arc.list.length - 1; });
    if (push) history.pushState({ view: 'arcfile', stack: arc.stack, fid: f.id }, '', homeUrl() + '?arc=' + encodeURIComponent(cur.id) + '&f=' + encodeURIComponent(f.id));
    readerOpen = true; applyLayout(); hideEnd(true);
    document.body.classList.remove('chrome');
    Settings.setReading(true);
    window.scrollTo(0, 0);
    var my = ++openSeqNo;
    var layout = function () {
      textLen = $('article').textContent.length;
      watchImages();
      if (isPaged()) {
        paginate();
        if (p.end) { goPage(pageCount - 1); curAnchor = probeAnchor(); } else { curAnchor = 0; goPage(0); }
      } else window.scrollTo(0, 0);
    };
    var kind = arcKind(f);
    if (kind === 'info') {
      $('article').innerHTML = ''; $('article').appendChild(arcInfo(f, '이 앱에서는 미리 볼 수 없는 형식이에요.'));
      layout(); return;
    }
    if (Number(f.size) > ARC_BIG && !p.force) {
      $('article').innerHTML = '';
      var box = arcInfo(f, '큰 파일이에요 (' + fmtSize(f.size) + '). 여는 데 시간이 걸리고 휴대폰이 느려질 수 있어요.');
      var go = document.createElement('button'); go.className = 'primary bigopen'; go.textContent = '그래도 열기';
      go.onclick = function () { openArcFile(i, false, { force: true, end: p.end }); };
      box.insertBefore(go, box.querySelector('.drivelink'));
      $('article').appendChild(box);
      layout(); return;
    }
    $('article').innerHTML = '<div class="status">파일을 불러오는 중이에요…</div>';
    if (isPaged()) { paginate(); goPage(0); }
    Core.getArchiveContent(f).then(function (text) {
      if (my !== openSeqNo || !arcOpen) return;
      var art = $('article');
      art.innerHTML = '';
      if (text.length > ARC_PAGED_MAX && Settings.get().mode === 'page') {
        arcForceScroll = true; applyLayout();
        var n = document.createElement('p'); n.className = 'arcnote'; n.textContent = '아주 긴 파일이라 이 파일은 쪽 넘기기 대신 스크롤로 보여 줘요.';
        art.appendChild(n);
      }
      if (kind === 'md') {
        var div = document.createElement('div');
        div.innerHTML = DOMPurify.sanitize(marked.parse(text));
        art.appendChild(div);
      } else {
        var pre = document.createElement('pre');
        pre.className = kind === 'json' || kind === 'html' ? 'mono' : 'plain';
        if (kind === 'json') { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {} }
        pre.textContent = text;   // HTML도 글자로만 (실행하지 않음)
        art.appendChild(pre);
      }
      layout();
    }, function (e) {
      if (my !== openSeqNo) return;
      $('article').innerHTML = '<div class="status">파일을 불러오지 못했어요. <button class="retry">다시 시도</button><br><small></small></div>';
      $('article').querySelector('small').textContent = errMsg(e);
      $('article').querySelector('.retry').onclick = function () { openArcFile(i, false, p); };
      layout();
    });
  }

  // ---------- 드라이브 연결 화면 ----------
  var toastTimer = null;
  function toast(msg) {
    $('toast').textContent = msg; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { $('toast').hidden = true; }, 1800);
  }
  function showConnect(msg) {
    $('connect').hidden = false;
    $('connectMsg').textContent = msg || (Drive.configured() ? '' : 'config.js에 OAuth 클라이언트 ID를 넣어야 연결할 수 있어요.');
    if (!episodes.length) $('homeStatus').style.display = 'none';
  }
  function showAuthBar(msg) { $('authBar').hidden = false; $('authMsg').textContent = msg || ''; }
  Drive.on('need', function (kind) {
    if (kind === 'connect') showConnect(); else showAuthBar();
  });
  Drive.on('ok', function () {
    $('authBar').hidden = true; $('authMsg').textContent = '';
    $('connect').hidden = true;
    if (!refreshing && (!booted || Date.now() - lastRefresh > 60000)) refresh();
    if (stateDirty) scheduleStateSync();
  });
  Drive.on('error', function (msg) {
    if (!$('connect').hidden) $('connectMsg').textContent = msg;
    else showAuthBar(msg);
  });
  $('authBtn').onclick = function () { Drive.requestToken(false); };
  $('connectBtn').onclick = function () { Drive.requestToken(true); };
  // 만료 5분 전부터는 아무 탭에서나 조용히 갱신 (팝업은 사용자 탭 안에서만 열 수 있다)
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('#authBtn, #connectBtn')) return;
    Drive.gestureRefresh();
  }, true);

  // ---------- 목록 저장본 ----------
  var listTimer = null;
  function saveListCache() {
    clearTimeout(listTimer);
    listTimer = setTimeout(function () {
      var data = { v: 1, at: Date.now(), episodes: episodes, categories: categories, feedback: feedback,
        candidates: candidates, keepNovel: keepNovel, hiddenFolders: hiddenFolders, legacyFb: legacyFb, archive: archiveRoots, sources: sourceList };
      var s = JSON.stringify(data);
      try { LS.setItem('listCache', s); } catch (e) { try { LS.removeItem('listCache'); } catch (e2) {} }
      idb.put('listCache', data);
    }, 300);
  }
  function loadListCache() {
    try { var d = JSON.parse(safeGet('listCache') || 'null'); if (d && d.episodes) return d; } catch (e) {}
    return null;
  }
  function setData(data) {
    data = data || {};
    function hiddenSrc(x) {
      if (!x || !Core.retiredSource) return false;
      return Core.retiredSource(x.src) || Core.retiredSource(x.key) || Core.retiredSource(x.label)
        || Core.retiredSource(x.badge) || Core.retiredSource(x.folder) || Core.retiredSource(x.name)
        || Core.retiredSource(x.path) || Core.retiredSource(x.title);
    }
    episodes = (data.episodes || []).filter(function (e) { return !hiddenSrc(e); });
    categories = (data.categories || []).filter(function (c) { return !hiddenSrc(c); });
    catName = {};
    categories.forEach(function (c) { catName[c.key] = c.name; });
    VIRTUAL.forEach(function (v) { catName[v[0]] = v[1]; });
    feedback = (data && data.feedback) || {};
    candidates = (data && data.candidates) || {};
    keepNovel = (data && data.keepNovel) || {};
    hiddenFolders = (data && data.hiddenFolders) || [];
    legacyFb = (data && data.legacyFb) || {};
    [feedback, candidates, keepNovel, legacyFb].forEach(function (map) {
      Object.keys(map).forEach(function (k) {
        if (Core.retiredSource(k) || hiddenSrc(map[k])) delete map[k];
      });
    });
    archiveRoots = ((data && data.archive) || []).filter(function (r) { return !hiddenSrc(r); });
    numCount = {};
    episodes.forEach(function (e) { numCount[e.num] = (numCount[e.num] || 0) + 1; });
    arcRootsDrawn = false;
    sourceList = ((data && data.sources) || deriveSources({ episodes: episodes, categories: categories }))
      .filter(function (a) { return !hiddenSrc(a); });
    srcMap = {}; sourceList.forEach(function (a) { srcMap[a.id] = a; });
    sourcesPresent = sourceList.length > 0 || episodes.some(function (e) { return !!e.src; });
    $('homeStatus').style.display = episodes.length ? 'none' : 'block';
    if (!episodes.length) $('homeStatus').textContent = '에피소드 파일을 찾지 못했어요.';
  }
  function signature() {
    return JSON.stringify([episodes.map(function (e) { return [e.id, e.num, e.title, e.cats, e.src]; }), categories, feedback, candidates, keepNovel, hiddenFolders, archiveRoots, sourceList]);
  }
  /** 백그라운드로 받은 새 목록 반영: 읽던 화·선택·입력 중인 피드백은 그대로 둔다. */
  function applyFresh(data, scanStart) {
    var before = signature();
    var curEp = pos >= 0 ? episodes[seq[pos]] : null;
    var selIds = Object.keys(selected).map(function (i) { return episodes[i] && episodes[i].id; });
    var oldMod = {};
    episodes.forEach(function (e) { oldMod[e.id] = e.modified; });
    var fresh = data.feedback || {};
    Object.keys(localTouch).forEach(function (k) {
      if (localTouch[k] >= scanStart) { if (feedback[k]) fresh[k] = feedback[k]; else delete fresh[k]; }
    });
    data.feedback = fresh;
    setData(data);
    episodes.forEach(function (e) {
      if (oldMod[e.id] && oldMod[e.id] !== e.modified) {
        delete cache[e.id];
        if (Core.dropEpisodeText) Core.dropEpisodeText(e.id);
      }
    });
    selected = {};
    selIds.forEach(function (id) { var k = indexOfId(id); if (k >= 0) selected[k] = true; });
    if (selecting) updSel();
    if (curEp) {
      var ni = indexOfId(curEp.id);
      if (ni < 0) ni = indexOfKey(keyOf(curEp));
      if (ni < 0) { showHome(false); }
      else {
        setSeq(seqCat); pos = seq.indexOf(ni);
        if (pos < 0) { setSeq(''); pos = seq.indexOf(ni); }
        if (pos < 0) { seqCat = ''; seq = allIdxAnySrc(); pos = seq.indexOf(ni); }
        if (pos < 0) { seq = everyIdx(); pos = ni; }
        updateNav();
        var editing = document.activeElement && (document.activeElement.id === 'fbGood' || document.activeElement.id === 'fbBad');
        if (!fbDirty && !fbSaving && !editing) fillFeedback(episodes[ni]);
        else { fbEp = episodes[ni]; fbIdx = ni; paintKind(); }
      }
    }
    saveListCache();
    if (pos < 0 && before !== signature()) { renderHome(); showResume(); }
  }
  function adoptServerState(st) {
    var server = st && st.lastRead;
    // 휴대폰과 PC 중 더 최근에 읽은 기록을 쓴다. (읽는 중이면 지금 읽는 화가 곧 기록된다)
    if (server && server.id && (!lastRead || server.at > lastRead.at) && pos < 0) {
      lastRead = server;
      safeSet('lastRead', JSON.stringify(lastRead));
      renderHome(); showResume();
    }
  }

  var refreshing = null, lastRefresh = 0;
  function syncNote(text, retry) {
    var el = $('syncNote'); el.textContent = text || '';
    if (retry) {
      var b = document.createElement('button'); b.textContent = '↻ 다시 불러오기';
      b.onclick = function () { refresh(); };
      el.appendChild(b);
    }
  }
  function refresh() {
    if (refreshing) return refreshing;
    var t0 = Date.now();
    if (booted) syncNote('드라이브에서 새 글을 확인하는 중…');
    refreshing = Core.getEpisodes().then(function (data) {
      lastRefresh = Date.now();
      if (!booted) {
        setData(data); saveListCache();
        adoptServerStateBeforeStart(data.state);
        booted = true; start();
      } else {
        applyFresh(data, t0);
        adoptServerState(data.state);
      }
      syncNote('');
    }, function (e) {
      if (!booted) {
        $('homeStatus').style.display = 'block';
        $('homeStatus').textContent = '목록을 불러오지 못했어요: ' + errMsg(e);
        var b = document.createElement('button'); b.textContent = '다시 시도'; b.style.marginLeft = '8px';
        b.onclick = function () { $('homeStatus').textContent = '드라이브에서 목록을 불러오는 중이에요…'; refresh(); };
        $('homeStatus').appendChild(b);
      } else {
        syncNote('드라이브에서 새로 불러오지 못했어요 (저장된 목록 표시 중). ', true);
      }
    }).then(function () { refreshing = null; });
    return refreshing;
  }
  function adoptServerStateBeforeStart(st) {
    var server = st && st.lastRead;
    if (server && server.id && (!lastRead || server.at > lastRead.at)) lastRead = server;
  }

  // ---------- 시작 ----------
  try { lastRead = JSON.parse(safeGet('lastRead') || 'null'); } catch (e) {}
  var resumeLocal = null;
  var cachedList = loadListCache();
  (function () {
    if (safeGet('inReader') !== '1' || !lastRead) return;
    var c = null; try { c = JSON.parse(safeGet('lastMd') || 'null'); } catch (e) {}
    resumeLocal = { id: lastRead.id, num: lastRead.num, key: lastRead.key, cat: lastRead.cat, scroll: lastRead.scroll || 0, frac: lastRead.frac, mode: lastRead.mode };
    if (!c || c.id !== lastRead.id || !c.md) return;
    cache[c.id] = c.md;
    if (cachedList) return;   // 목록 저장본이 있으면 아래 start()가 바로 연다
    // 읽던 중에 새로고침된 경우: 목록을 기다리지 않고 저장해 둔 본문을 바로 보여 준다.
    $('home').style.display = 'none';
    $('reader').style.display = 'block';
    $('backBtn').style.display = 'inline-block';
    $('headTitle').textContent = c.num + '. ' + c.title;
    $('where').textContent = '이어 읽는 중…';
    ['prevTop', 'prevBottom', 'nextTop', 'nextBottom'].forEach(function (b) { $(b).disabled = true; });
    $('fb').style.display = 'none';
    $('article').innerHTML = DOMPurify.sanitize(marked.parse(splitMd(c.md).body));
    setTimeout(function () { window.scrollTo(0, resumeLocal.scroll); }, 30);
  })();

  function start() {
    $('fb').style.display = '';
    if (resumeLocal) {
      var ri = findLast(resumeLocal);
      if (ri >= 0) {
        var y = window.scrollY || resumeLocal.scroll;
        var cat = resumeLocal.cat && episodes[ri].cats.indexOf(resumeLocal.cat) !== -1 ? resumeLocal.cat : resumeLocal.cat && resumeLocal.cat.charAt(0) === '@' ? resumeLocal.cat : '';
        resumeLocal = { scroll: y, frac: resumeLocal.frac, mode: resumeLocal.mode, cat: cat, i: ri };
        enterInitial(ri, cat, resumeLocal);
        resumeLocal = null;
        return;
      }
      resumeLocal = null;
    }
    var want = new URLSearchParams(location.search).get('ep');
    if (want) {
      for (var i = 0; i < episodes.length; i++) if (keyOf(episodes[i]) === want) { enterInitial(i, '', null); return; }
    }
    history.replaceState({ view: 'home' }, '', homeUrl());
    showHome(false);
  }
  /** 앱을 열자마자 화를 여는 경우: 뒤로 가기가 목록으로 오도록 목록 기록을 먼저 깔아 둔다. */
  function enterInitial(i, cat, p) {
    if (history.state && history.state.view === 'ep') {
      openEpisode(i, cat, false, p);
      history.replaceState({ view: 'ep', id: episodes[i].id, cat: seqCat }, '', epUrl(episodes[i]));
    } else {
      history.replaceState({ view: 'home' }, '', homeUrl());
      openEpisode(i, cat, true, p);
    }
  }

  if (cachedList) {
    setData(cachedList);
    booted = true;
    start();
  }
  if (!Drive.configured()) {
    showConnect();
    if (!booted) $('homeStatus').style.display = 'none';
  } else if (!Drive.everConnected() && !Drive.hasValidToken()) {
    showConnect();
    if (!booted) $('homeStatus').style.display = 'none';
  } else {
    refresh();   // 토큰이 만료됐으면 '연결 갱신' 막대가 뜨고, 누르면 이어서 불러온다
  }

  // ---------- 서비스 워커 (앱 껍데기 캐시) ----------
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    // 새 버전: sw.js는 HTTP 캐시를 거치지 않고 확인하고(updateViaCache 'none'), 앱을 다시 볼 때마다 업데이트를 확인한다.
    // 새 서비스 워커가 페이지를 넘겨받으면(skipWaiting + clients.claim) 입력·저장 중이 아닐 때 바로 새로고침하고,
    // 그렇지 않으면 '새 버전' 막대를 띄워 직접 누르게 한다. 지금 떠 있는 예전 코드가 계속 저장하지 않게 하려는 것.
    var swReg = null, hadController = !!navigator.serviceWorker.controller, swReloading = false;
    function swBusy() {
      var a = document.activeElement;
      return fbDirty || fbSaving || fbQueued || !!(a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT'));
    }
    function swReloadNow() { if (swReloading) return; swReloading = true; try { flushFeedback(); } catch (e) {} location.reload(); }
    function swShowUpdate() {
      var bar = $('updBar');
      if (!bar) {
        bar = document.createElement('div'); bar.id = 'updBar'; bar.className = 'updbar';
        bar.innerHTML = '<span>새 버전이 있어요.</span> <button id="updBtn">새로고침</button>';
        document.body.appendChild(bar);
        $('updBtn').onclick = function () { if (fbDirty || fbSaving || fbQueued) { flushFeedback(); setTimeout(swReloadNow, 1500); } else swReloadNow(); };
      }
      bar.hidden = false;
    }
    function swCheck() { if (swReg) swReg.update().catch(function () {}); }
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) { hadController = true; return; }   // 처음 설치: 이미 최신 코드
      window.__reader.updateReady = true;
      if (document.visibilityState === 'hidden' || !swBusy()) swReloadNow(); else swShowUpdate();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (window.__reader.updateReady && !swBusy()) swReloadNow(); else swCheck();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).then(function (r) {
        swReg = r; window.__reader.swReg = r; swCheck();
      }).catch(function () {});
    });
    setInterval(function () { if (document.visibilityState === 'visible') swCheck(); }, 30 * 60 * 1000);
  }

  // 테스트·디버그용 읽기 전용 상태 (드라이브 호출 없음)
  window.__reader = {
    keys: function () { return episodes.map(keyOf); },
    state: function () {
      return { arc: arcState(), source: curSrc(), key: pos >= 0 && episodes[seq[pos]] ? keyOf(episodes[seq[pos]]) : null, pos: pos, seqCat: seqCat, page: page, pageCount: pageCount, cols: cols, spread: document.body.classList.contains('spread'), atEnd: atEnd, curAnchor: curAnchor, textLen: textLen,
        current: pos >= 0 ? episodes[seq[pos]] && episodes[seq[pos]].num : null, lastRead: lastRead, episodes: episodes.length };
    }
  };
})();
