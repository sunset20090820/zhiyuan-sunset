/* ============================================================
   小说阅读（精简版阅读）：书架 / 搜索 / 目录 / 正文 / 书源
   规则引擎在 bookrule.js；书源数据在 booksrc.js（懒加载）
   ============================================================ */
(function () {
  'use strict';

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function trim(s) { return String(s == null ? '' : s).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, ''); }

  /* ---------------- 存储 ---------------- */
  var KEY = 'pl.books.v1';
  var ST = { shelf: [], on: null, mine: [], fs: 18, theme: 'paper', order: [] };
  function load() {
    try { var raw = localStorage.getItem(KEY); if (raw) ST = JSON.parse(raw) || ST; } catch (e) {}
    if (!ST.shelf) ST.shelf = [];
    if (!ST.mine) ST.mine = [];
    if (!ST.fs) ST.fs = 18;
    if (!ST.theme) ST.theme = 'paper';
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(ST)); } catch (e) {} }

  /* ---------------- 小提示 ---------------- */
  var tipEl = null, tipTimer = null;
  function toast(m) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'bk-toast'; document.body.appendChild(tipEl); }
    tipEl.textContent = m;
    tipEl.classList.add('on');
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function () { tipEl.classList.remove('on'); }, 1800);
  }

  /* ---------------- 网络 ---------------- */
  var httpWait = {}, httpSeq = 0, httpCount = 0;
  function httpGet(url, headers, cb, req) {
    req = req || {};
    var method = req.method || 'GET';
    var body = req.body || '';
    var charset = req.charset || '';
    var rid = 'bk' + (++httpSeq);
    httpWait[rid] = cb;
    var hj = '';
    if (headers) { try { hj = JSON.stringify(headers); } catch (e) {} }
    if (method === 'POST') {
      if (!headers) headers = {};
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (window.PaperNative && window.PaperNative.httpGet) {
      try { window.PaperNative.httpGet(rid, url, hj || (headers ? JSON.stringify(headers) : ''), method, body, charset); return; } catch (e) {}
    }
    try {
      var x = new XMLHttpRequest();
      x.open(method, url, true);
      x.timeout = 15000;
      if (charset) { try { x.overrideMimeType('text/html; charset=' + charset); } catch (e) {} }
      if (headers) for (var k in headers) { try { x.setRequestHeader(k, headers[k]); } catch (e) {} }
      x.onload = function () { var c = httpWait[rid]; delete httpWait[rid]; if (c) c(x.status, x.responseText, ''); };
      x.onerror = x.ontimeout = function () { var c = httpWait[rid]; delete httpWait[rid]; if (c) c(0, '', '网络错误'); };
      x.send(method === 'POST' ? body : null);
    } catch (e) { delete httpWait[rid]; cb(0, '', '不支持的网络请求'); }
  }
  window.__httpDone = function (rid, status, text, err) {
    var cb = httpWait[rid];
    if (!cb) return;
    delete httpWait[rid];
    httpCount++;
    try { cb(status, text || '', err || ''); } catch (e) {}
  };

  /* ---------------- 书源 ---------------- */
  var BT = null, BTLOADING = false, BTWAIT = [];
  function withBuiltin(cb) {
    if (window.ZY_BOOKSRC) { cb(window.ZY_BOOKSRC); return; }
    BTWAIT.push(cb);
    if (BTLOADING) return;
    BTLOADING = true;
    var sc = document.createElement('script');
    sc.src = 'booksrc.js';
    sc.onload = function () {
      BTLOADING = false;
      var list = window.ZY_BOOKSRC || [];
      for (var i = 0; i < BTWAIT.length; i++) { try { BTWAIT[i](list); } catch (e) {} }
      BTWAIT = [];
    };
    sc.onerror = function () {
      BTLOADING = false;
      for (var i = 0; i < BTWAIT.length; i++) { try { BTWAIT[i]([]); } catch (e) {} }
      BTWAIT = [];
      toast('内置书源加载失败');
    };
    document.head.appendChild(sc);
  }
  function norm(s) {
    return {
      id: s.id != null ? s.id : s.i,
      name: s.name || s.bookSourceName || s.n || '',
      base: trim(s.base || s.bookSourceUrl || s.u || ''),
      group: s.group || s.bookSourceGroup || s.g || '',
      header: s.header || '',
      searchUrl: s.searchUrl || s.s || '',
      rs: s.rs || s.ruleSearch || {},
      ri: s.ri || s.ruleBookInfo || {},
      rt: s.rt || s.ruleToc || {},
      rc: s.rc || s.ruleContent || {},
      mine: !!s.mine
    };
  }
  function allSources(cb) {
    withBuiltin(function (builtin) {
      var out = [], i;
      for (i = 0; i < builtin.length; i++) out.push(norm(builtin[i]));
      for (i = 0; i < ST.mine.length; i++) out.push(norm(ST.mine[i]));
      cb(out);
    });
  }
  function enabledMap() {
    if (!ST.on) {
      ST.on = {};
      var def = window.ZY_BOOKSRC_DEFAULT || [];
      for (var i = 0; i < def.length; i++) ST.on[def[i]] = 1;
      save();
    }
    return ST.on;
  }
  function srcById(id) {
    var m = ST.mine, i;
    for (i = 0; i < m.length; i++) if (String(m[i].id) === String(id)) return norm(m[i]);
    var b = window.ZY_BOOKSRC || [];
    for (i = 0; i < b.length; i++) if (String(b[i].i) === String(id)) return norm(b[i]);
    // 内置未加载时只能返回 null
    return null;
  }
  function hdr(src) {
    if (!src.header) return null;
    try {
      var h = typeof src.header === 'string' ? JSON.parse(src.header) : src.header;
      if (h && typeof h === 'object') return h;
    } catch (e) {}
    return null;
  }

  /* ---------------- 搜索 ---------------- */
  var findState = { key: '', total: 0, done: 0, stop: false, list: [], seen: {} };

  function searchOne(src, key, page, cb) {
    var rq = BR.parseSearchUrl(src.searchUrl, { key: key, page: page || 1, host: src.base, baseUrl: src.base });
    var url = rq.url;
    if (!url) return cb([]);
    if (!/^https?:/i.test(url)) url = BR.absUrl(url, src.base);
    httpGet(url, hdr(src), function (status, body, err) {
      if (status >= 400 || !body) return cb([]);
      var items = [], i;
      var isJson = /^\s*[\{\[]/.test(body) && /\$\./.test(src.rs.bookList || '');
      var json = null;
      if (isJson) { try { json = JSON.parse(body); } catch (e) { json = null; } }
      var doc = isJson ? null : BR.parseHtml(body);
      var nodes = BR.list(doc, src.rs.bookList, url, json);
      for (i = 0; i < nodes.length && i < 30; i++) {
        var el = nodes[i], jn = (typeof el === 'object' && !el.nodeType) ? el : null;
        var nm = BR.inEl(jn ? null : el, src.rs.name, url, jn) || (jn && jn.name) || '';
        var bu = BR.inEl(jn ? null : el, src.rs.bookUrl, url, jn) || (jn && (jn.bookUrl || jn.url)) || '';
        nm = trim(String(nm).replace(/\s+/g, ' '));
        bu = trim(String(bu));
        if (!nm || !bu) continue;
        if (nm.length > 40 || /章节目录|最新章节|查看全部|本书角色|书友/.test(nm)) continue;
        if (!/^https?:/i.test(BR.absUrl(bu, url))) continue;
        items.push({
          src: src.id, sName: src.name,
          name: trim(nm), author: trim(BR.inEl(jn ? null : el, src.rs.author, url, jn) || (jn && jn.author) || ''),
          url: BR.absUrl(bu, url),
          cover: BR.absUrl(BR.inEl(jn ? null : el, src.rs.coverUrl, url, jn) || (jn && jn.coverUrl) || '', url),
          kind: trim(BR.inEl(jn ? null : el, src.rs.kind, url, jn) || (jn && jn.kind) || ''),
          last: trim(BR.inEl(jn ? null : el, src.rs.lastChapter, url, jn) || (jn && jn.lastChapter) || '')
        });
      }
      cb(items);
    }, { method: rq.method, body: rq.body, charset: rq.charset });
  }

  function findStart(key) {
    key = trim(key);
    if (!key) { toast('先写书名或作者'); return; }
    allSources(function (all) {
      var on = enabledMap();
      var picked = all.filter(function (s) { return on[s.id] && s.searchUrl && s.rs && s.rs.bookList; });
      if (!picked.length) { toast('没有启用的书源，先去「书源」开几个'); showSrc(); return; }
      var rank = {};
      (window.ZY_BOOKSRC_DEFAULT || []).forEach(function (id, i) { rank[id] = i; });
      findState = { key: key, total: picked.length, done: 0, stop: false, list: [], seen: {}, rank: rank };
      $('#bkFindTitle').textContent = '搜「' + key + '」';
      $('#bkFindList').innerHTML = '';
      showPage('bkFind');
      renderFindProg();
      var idx = 0, active = 0, CONC = 4;
      function next() {
        if (findState.stop) return;
        if (idx >= picked.length && active === 0) { findState.done = findState.total; renderFindProg(); return; }
        while (active < CONC && idx < picked.length) {
          (function (src) {
            active++;
            var settled = false;
            var timer = setTimeout(function () { if (settled) return; settled = true; active--; findState.done++; renderFindProg(); next(); }, 14000);
            searchOne(src, key, 1, function (items) {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              active--;
              findState.done++;
              if (items && items.length) pushResults(items);
              renderFindProg();
              next();
            });
          })(picked[idx++]);
        }
      }
      next();
    });
  }

  function pushResults(items) {
    var box = $('#bkFindList');
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var k = (it.name + '|' + it.author).toLowerCase();
      var copy = { src: it.src, url: it.url, name: it.name, author: it.author, cover: it.cover, sName: it.sName };
      if (findState.seen[k]) {
        findState.seen[k].item.alt++;
        if (findState.seen[k].alts.length < 8) findState.seen[k].alts.push(copy);
        continue;
      }
      it.alt = 1;
      findState.seen[k] = { item: it, alts: [copy] };
      findState.list.push(it);
    }
    // 重新按"源优先级"排一遍（默认开的源里靠前的更可靠）
    var rk = findState.rank || {};
    findState.list.sort(function (a, b) {
      var ra = rk[a.src] == null ? 999 : rk[a.src];
      var rb = rk[b.src] == null ? 999 : rk[b.src];
      if (ra !== rb) return ra - rb;
      return String(a.name).localeCompare(String(b.name));
    });
    box.innerHTML = findState.list.map(function (x, i) { return findRowHtml(x, i); }).join('');
  }
  function findRowHtml(it, i) {
    return '<div class="bk-item" data-find="' + i + '">' +
      '<div class="bk-ava">' + (it.cover ? '<img src="' + esc(it.cover) + '" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">' : esc(it.name.slice(0, 1))) + '</div>' +
      '<div class="bk-item-main"><div class="bk-item-name">' + esc(it.name) +
      (it.alt > 1 ? ' <span class="bk-alt">' + it.alt + ' 个源</span>' : '') + '</div>' +
      '<div class="bk-item-sub">' + esc(it.author || '佚名') + (it.kind ? ' · ' + esc(it.kind) : '') + '</div>' +
      '<div class="bk-item-sub">' + esc(it.sName) + (it.last ? ' · ' + esc(it.last) : '') + '</div></div></div>';
  }
  function renderFindProg() {
    var p = $('#bkFindProg');
    if (!p) return;
    var s = '已搜 ' + findState.done + ' / ' + findState.total + ' 个源，' + findState.list.length + ' 本';
    if (findState.done >= findState.total) s += '（完成）';
    if (findState.stop) s += '（已停止）';
    p.textContent = s;
  }

  /* ---------------- 书籍详情 / 目录 ---------------- */
  var curBook = null;
  function openBook(srcId, bookUrl, preset) {
    var src = srcById(srcId);
    if (!src) { toast('书源加载中，稍等一下再试'); return; }
    showPage('bkBook');
    $('#bkBookTitle').textContent = '加载中…';
    $('#bkBookHead').innerHTML = '<div class="bk-loading">正在打开…</div>';
    $('#bkBookActs').innerHTML = '';
    $('#bkToc').innerHTML = '';
    httpGet(bookUrl, hdr(src), function (status, body, err) {
      if (status >= 400 || !body) { $('#bkBookHead').innerHTML = '<div class="bk-loading">打不开这本书：' + esc(err || ('HTTP ' + status)) + '</div>'; return; }
      var doc = BR.parseHtml(body);
      var rawName = trim(String(BR.one(doc, src.ri.name || src.rs.name, bookUrl) || '').replace(/\s+/g, ' '));
      if (rawName.length > 40) rawName = '';
      var info = {
        name: rawName || (preset && preset.name) || '',
        author: trim(BR.one(doc, src.ri.author, bookUrl)) || (preset && preset.author) || '',
        cover: BR.absUrl(BR.one(doc, src.ri.coverUrl, bookUrl) || (preset && preset.cover) || '', bookUrl),
        intro: String(BR.one(doc, src.ri.intro, bookUrl) || '').slice(0, 1200),
        kind: trim(BR.one(doc, src.ri.kind, bookUrl)),
        last: trim(BR.one(doc, src.ri.lastChapter, bookUrl))
      };
      var tocUrl = BR.absUrl(BR.one(doc, src.ri.tocUrl, bookUrl), bookUrl) || bookUrl;
      var finish = function (tocDoc, tocBase) {
        var chs = [];
        var nodes = BR.list(tocDoc, src.rt.chapterList, tocBase);
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          var nm = trim(BR.inEl(el, src.rt.chapterName, tocBase));
          var u = BR.absUrl(BR.inEl(el, src.rt.chapterUrl, tocBase), tocBase);
          if (!nm || !u) continue;
          chs.push({ name: nm, url: u });
        }
        var altList = chs.length ? [] : findAlts((preset && preset.name) || info.name || '', (preset && preset.author) || info.author || '');
        var book = curBook = {
          srcId: src.id, srcName: src.name, url: bookUrl,
          name: info.name || (preset && preset.name) || '未命名',
          author: info.author || (preset && preset.author) || '',
          cover: info.cover, intro: info.intro, kind: info.kind, last: info.last,
          chapters: chs, alts: altList, chIdx: 0, ratio: 0, ts: Date.now()
        };
        var old = shelfFind(book.url);
        if (old) { book.chIdx = old.chIdx || 0; book.ratio = old.ratio || 0; }
        $('#bkBookTitle').textContent = book.name;
        $('#bkBookHead').innerHTML = bookHeadHtml(book);
        $('#bkBookActs').innerHTML =
          '<button class="primary" id="bkReadNow" type="button">' + (chs.length ? '开始阅读' : '重试') + '</button>' +
          '<button class="flat" id="bkAddShelf" type="button">' + (old ? '已在书架' : '加入书架') + '</button>';
        renderToc(book);
        on('#bkReadNow', 'click', function (e) {
          e.preventDefault();
          if (!book.chapters.length) { openBook(src.id, bookUrl, preset); return; }
          openChapter(book, Math.min(book.chIdx || 0, book.chapters.length - 1));
        });
        on('#bkAddShelf', 'click', function (e) {
          e.preventDefault();
          addShelf(book);
          toast('已加入书架');
          $('#bkBookActs').innerHTML = '<button class="primary" id="bkReadNow" type="button">开始阅读</button><button class="flat" id="bkAddShelf" type="button">已在书架</button>';
          bindBookActs(book, src, bookUrl, preset);
        });
        bindBookActs(book, src, bookUrl, preset);
      };
      if (tocUrl && tocUrl !== bookUrl) {
        httpGet(tocUrl, hdr(src), function (st2, body2) {
          if (st2 >= 400 || !body2) finish(doc, bookUrl);
          else finish(BR.parseHtml(body2), tocUrl);
        });
      } else finish(doc, bookUrl);
    });
  }
  function findAlts(name, author) {
    var k = (name + '|' + author).toLowerCase();
    var rec = findState.seen[k];
    if (!rec) return [];
    return rec.alts.filter(function (a) { return a; });
  }
  function bindBookActs(book, src, bookUrl, preset) {
    on('#bkReadNow', 'click', function (e) {
      e.preventDefault();
      if (!book.chapters.length) { openBook(src.id, bookUrl, preset); return; }
      openChapter(book, Math.min(book.chIdx || 0, book.chapters.length - 1));
    });
    on('#bkAddShelf', 'click', function (e) { e.preventDefault(); addShelf(book); toast('已加入书架'); });
  }
  function bookHeadHtml(b) {
    return '<div class="bk-head">' +
      '<div class="bk-cover">' + (b.cover ? '<img src="' + esc(b.cover) + '" referrerpolicy="no-referrer" onerror="this.remove()">' : '') + '</div>' +
      '<div class="bk-head-main"><div class="bk-name">' + esc(b.name) + '</div>' +
      '<div class="bk-sub">' + esc(b.author || '佚名') + (b.kind ? ' · ' + esc(b.kind) : '') + '</div>' +
      '<div class="bk-sub">' + esc(b.srcName) + '</div>' +
      (b.last ? '<div class="bk-sub">' + esc(b.last) + '</div>' : '') +
      '</div></div>' +
      (b.intro ? '<details class="bk-intro"><summary>简介</summary><p>' + esc(b.intro) + '</p></details>' : '');
  }
  function renderToc(book) {
    var box = $('#bkToc'), i, html = '';
    if (!book.chapters.length) {
      html = '<div class="bk-loading">这个源没读到目录' + ((book.alts && book.alts.length > 1) ? '，换个源试试：' : '（目录规则可能带 JS）') + '</div>';
      if (book.alts && book.alts.length > 1) {
        html += '<div class="bk-altwrap">' + book.alts.slice(0, 8).map(function (a, k) {
          var nm = a.sName || (srcById(a.src) || {}).name || ('源' + (k + 1));
          return '<button class="flat bk-altbtn" type="button" data-alt="' + k + '">' + esc(nm) + '</button>';
        }).join('') + '</div>';
      }
      box.innerHTML = html;
      Array.prototype.forEach.call(box.querySelectorAll('[data-alt]'), function (btn) {
        btn.addEventListener('click', function () {
          var a = book.alts[Number(btn.getAttribute('data-alt'))];
          if (a) openBook(a.src, a.url, { name: a.name, author: a.author, cover: a.cover });
        });
      });
      return;
    }
    var limit = Math.min(book.chapters.length, 500);
    html += '<div class="bk-toc-head">目录 · ' + book.chapters.length + ' 章</div>';
    for (i = 0; i < limit; i++) {
      html += '<div class="bk-ch' + (i === book.chIdx ? ' on' : '') + '" data-ch="' + i + '">' + esc(book.chapters[i].name) + '</div>';
    }
    if (book.chapters.length > limit) html += '<div class="bk-toc-more">共 ' + book.chapters.length + ' 章，先在下面按「上一章/下一章」连续读</div>';
    box.innerHTML = html;
  }

  /* ---------------- 书架 ---------------- */
  function shelfFind(url) {
    for (var i = 0; i < ST.shelf.length; i++) if (ST.shelf[i].url === url) return ST.shelf[i];
    return null;
  }
  function addShelf(book) {
    var old = shelfFind(book.url);
    var row = {
      url: book.url, srcId: book.srcId, name: book.name, author: book.author, cover: book.cover,
      chIdx: old ? old.chIdx : 0, ratio: old ? old.ratio : 0, lastRead: old ? old.lastRead : '', ts: Date.now()
    };
    if (old) { for (var k in row) old[k] = row[k]; }
    else ST.shelf.unshift(row);
    save();
    renderShelf();
  }
  function renderShelf() {
    var box = $('#bkShelfList');
    if (!box) return;
    if (!ST.shelf.length) {
      box.innerHTML = '<div class="bk-empty">书架还空着<br><span>上面搜一本，或者去「书源」挑几个源</span></div>';
    } else {
      box.innerHTML = ST.shelf.map(function (b, i) {
        return '<div class="bk-cell" data-shelf="' + i + '"><div class="bk-cell-cover">' +
          (b.cover ? '<img src="' + esc(b.cover) + '" referrerpolicy="no-referrer" onerror="this.remove()">' : '<span>' + esc((b.name || '?').slice(0, 1)) + '</span>') +
          '</div><div class="bk-cell-name">' + esc(b.name) + '</div>' +
          '<div class="bk-cell-sub">' + (b.lastRead ? esc(b.lastRead) : '未开始') + '</div></div>';
      }).join('');
    }
    var n = 0;
    try { var on = enabledMap(); for (var k in on) if (on[k]) n++; } catch (e) {}
    var tip = $('#bkShelfTip');
    if (tip) tip.textContent = '已启用 ' + n + ' 个书源 · 结果来自各书站，点「书源」可增删';
  }

  /* ---------------- 正文 ---------------- */
  var cacheCh = {};
  function openChapter(book, idx) {
    if (!book || !book.chapters || !book.chapters.length) { toast('没有章节'); return; }
    idx = Math.max(0, Math.min(book.chapters.length - 1, idx));
    var ch = book.chapters[idx];
    curBook = book;
    book.chIdx = idx;
    showReadPage();
    $('#bkReadTitle').textContent = ch.name;
    var cached = cacheCh[ch.url];
    if (cached) { renderChapter(book, idx, cached); return; }
    $('#bkReadBody').innerHTML = '<div class="bk-loading">正在取正文…</div>';
    $('#bkReadFoot').innerHTML = '';
    var src = srcById(book.srcId);
    if (!src) { $('#bkReadBody').innerHTML = '<div class="bk-loading">书源不见了，可能被删了</div>'; return; }
    httpGet(ch.url, hdr(src), function (status, body, err) {
      if (status >= 400 || !body) {
        $('#bkReadBody').innerHTML = '<div class="bk-loading">取不到正文：' + esc(err || ('HTTP ' + status)) + '<br>换个源试试</div>';
        return;
      }
      var doc = BR.parseHtml(body);
      var txt = BR.one(doc, src.rc.content, ch.url);
      if (src.rc.replaceRegex) txt = BR.applyRegex(txt, String(src.rc.replaceRegex).replace(/^##/, '').split('##')[0], String(src.rc.replaceRegex).replace(/^##/, '').split('##')[1] || '');
      txt = trim(txt);
      if (!txt || txt.length < 200) {   // 规则没取到正文时，按常见容器兜一下
        var cands = ['#content', '#chaptercontent', '#chapterContent', '#booktext', '#TextContent',
                     '#nr1', '#article', '#htmlContent', '.read-content', '.content-body', '.content', 'article', '#txtContent'];
        for (var ci = 0; ci < cands.length; ci++) {
          var pick = '';
          try { pick = trim((doc.querySelector(cands[ci]) || {}).textContent || ''); } catch (e) {}
          if (pick.length > (txt || '').length) txt = pick;
          if (txt.length > 400) break;
        }
      }
      if (!txt) {
        $('#bkReadBody').innerHTML = '<div class="bk-loading">这个源取不到正文（规则可能带 JS）</div>';
        return;
      }
      cacheCh[ch.url] = txt;
      renderChapter(book, idx, txt);
    });
  }
  function plainText(t) {
    var x = String(t || '');
    if (x.indexOf('<') >= 0) {
      x = x.replace(/<\s*br\s*\/?\s*>/gi, '\n')
           .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, '\n')
           .replace(/<[^>]+>/g, '');
      x = x.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    }
    return x.replace(/\r/g, '');
  }
  function renderChapter(book, idx, txt) {
    var paras = plainText(txt).split(/\n+/);
    var html = '';
    for (var i = 0; i < paras.length; i++) {
      var p = trim(paras[i]);
      if (!p) continue;
      html += '<p>' + esc(p) + '</p>';
    }
    $('#bkReadTitle').textContent = book.chapters[idx].name;
    $('#bkReadBody').innerHTML = html;
    $('#bkReadFoot').innerHTML = '<div class="bk-foot-btns"><button class="flat" data-nav="-1" type="button">上一章</button>' +
      '<button class="flat" data-nav="0" type="button">目录</button>' +
      '<button class="flat" data-nav="1" type="button">下一章</button></div>' +
      '<div class="bk-foot-end">' + (idx + 1) + ' / ' + book.chapters.length + '</div>';
    $('#bkReadScroll').scrollTop = 0;
    applyReadStyle();
    // 记录进度
    book.lastRead = book.chapters[idx].name;
    book.ratio = 0;
    book.ts = Date.now();
    addShelf(book);
    save();
  }

  function showReadPage() {
    ['bkShelf', 'bkFind', 'bkBook', 'bkSrc'].forEach(function (id) { var e = $('#' + id); if (e) e.classList.add('hidden'); });
    var bar = $('#tabbar'); if (bar) bar.classList.add('hidden');
    var r = $('#bkRead'); if (r) r.classList.remove('hidden');
    document.body.classList.add('bk-reading');
  }
  function leaveRead() {
    var r = $('#bkRead'); if (r) r.classList.add('hidden');
    document.body.classList.remove('bk-reading');
    var bar = $('#tabbar'); if (bar) bar.classList.remove('hidden');
    showPage('bkShelf');
  }
  function applyReadStyle() {
    var r = $('#bkRead');
    if (!r) return;
    r.setAttribute('data-theme', ST.theme || 'paper');
    var body = $('#bkReadBody');
    if (body) body.style.fontSize = (ST.fs || 18) + 'px';
  }

  /* ---------------- 页面切换 ---------------- */
  function showPage(id) {
    ['bkShelf', 'bkFind', 'bkBook', 'bkSrc', 'bkRead'].forEach(function (x) {
      var e = $('#' + x); if (e) e.classList.add('hidden');
    });
    var el = $('#' + id);
    if (el) el.classList.remove('hidden');
    var bar = $('#tabbar'); if (bar) bar.classList.remove('hidden');
    ['#chats', '#contacts', '#roles', '#mePage', '#storagePage', '#blockPage', '#groupPanel', '#devUsers'].forEach(function (sel) {
      var e = $(sel); if (e) e.classList.add('hidden');
    });
    if (id === 'bkShelf') renderShelf();
  }
  function showSrc() {
    showPage('bkSrc');
    renderSrcList();
  }

  /* ---------------- 书源列表 ---------------- */
  var srcFilter = '';
  function renderSrcList() {
    allSources(function (all) {
      var on = enabledMap();
      var box = $('#bkSrcList');
      if (!box) return;
      var kw = trim(srcFilter);
      var list = all.filter(function (s) {
        if (s.mine && !s.searchUrl) return false;
        if (!s.searchUrl) return false;
        if (!kw) return true;
        return (s.name + ' ' + s.group).indexOf(kw) >= 0;
      });
      var nOn = 0;
      for (var k in on) if (on[k]) nOn++;
      var html = '<div class="bk-src-count">共 ' + all.length + ' 个源，启用 ' + nOn + ' 个（内置 ' + (window.ZY_BOOKSRC ? window.ZY_BOOKSRC.length : 0) + '）</div>';
      var limit = Math.min(list.length, 400);
      for (var i = 0; i < limit; i++) {
        var s = list[i];
        html += '<label class="bk-srcrow"><input type="checkbox" data-src="' + esc(s.id) + '"' + (on[s.id] ? ' checked' : '') + '>' +
          '<span class="bk-srcname">' + esc(s.name) + (s.mine ? ' <span class="bk-alt">自加</span>' : '') + '</span>' +
          '<span class="bk-srcgroup">' + esc((s.group || '').split(',')[0] || '未分组') + '</span>' +
          (s.mine ? '<button class="bk-srcdel" type="button" data-delsrc="' + esc(s.id) + '">删</button>' : '') +
          '</label>';
      }
      if (list.length > limit) html += '<div class="bk-toc-more">还有 ' + (list.length - limit) + ' 个，写关键字筛一下</div>';
      box.innerHTML = html;
      var tip = $('#bkSrcTip');
      if (tip) tip.textContent = '默认开了 50 个快的；搜不到的书写关键字筛选后手动开。点「全开」会变成全部启用（搜索会慢很多）。';
    });
  }

  /* ---------------- 文档 ---------------- */
  function on(sel, ev, fn) {
    var el = typeof sel === 'string' ? $(sel) : sel;
    if (!el) return;
    el.addEventListener(ev, fn);
  }

  /* ---------------- 初始化 ---------------- */
  var inited = false;
  function init() {
    if (inited) return;
    inited = true;
    load();
    on('#bkShelfBack', 'click', function (e) { e.preventDefault(); showTabBack(); });
    on('#bkSrcBtn', 'click', function (e) { e.preventDefault(); showSrc(); });
    on('#bkGo', 'click', function (e) { e.preventDefault(); findStart($('#bkKey').value); });
    on('#bkKey', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); findStart($('#bkKey').value); } });
    on('#bkFindStop', 'click', function (e) { e.preventDefault(); findState.stop = true; renderFindProg(); });
    on('#bkFindBack', 'click', function (e) { e.preventDefault(); findState.stop = true; showPage('bkShelf'); });
    on('#bkBookBack', 'click', function (e) { e.preventDefault(); showPage('bkFind'); });
    on('#bkSrcBack', 'click', function (e) { e.preventDefault(); showPage('bkShelf'); });
    on('#bkFindList', 'click', function (e) {
      var row = e.target.closest('[data-find]');
      if (!row) return;
      var it = findState.list[Number(row.getAttribute('data-find'))];
      if (!it) return;
      openBook(it.src, it.url, { name: it.name, author: it.author, cover: it.cover });
    });
    on('#bkShelfList', 'click', function (e) {
      var cell = e.target.closest('[data-shelf]');
      if (!cell) return;
      var b = ST.shelf[Number(cell.getAttribute('data-shelf'))];
      if (!b) return;
      openBook(b.srcId, b.url, { name: b.name, author: b.author, cover: b.cover });
    });
    on('#bkToc', 'click', function (e) {
      var ch = e.target.closest('[data-ch]');
      if (!ch || !curBook) return;
      openChapter(curBook, Number(ch.getAttribute('data-ch')));
    });
    on('#bkReadBody', 'click', function (e) {
      var nav = e.target.closest('[data-nav]');
      if (nav && curBook) {
        var d = Number(nav.getAttribute('data-nav'));
        if (d === 0) { leaveReadToToc(); return; }
        openChapter(curBook, curBook.chIdx + d);
        return;
      }
      var bar = $('#bkReadBar');
      if (bar) bar.classList.toggle('hidden');
    });
    on('#bkReadFoot', 'click', function (e) {
      var nav = e.target.closest('[data-nav]');
      if (!nav || !curBook) return;
      var d = Number(nav.getAttribute('data-nav'));
      if (d === 0) { leaveReadToToc(); return; }
      openChapter(curBook, curBook.chIdx + d);
    });
    on('#bkReadPrev', 'click', function (e) { e.preventDefault(); if (curBook) openChapter(curBook, curBook.chIdx - 1); });
    on('#bkReadNext', 'click', function (e) { e.preventDefault(); if (curBook) openChapter(curBook, curBook.chIdx + 1); });
    on('#bkReadToc', 'click', function (e) { e.preventDefault(); leaveReadToToc(); });
    on('#bkReadA', 'click', function (e) {
      e.preventDefault();
      ST.fs = (ST.fs || 18) + 2;
      if (ST.fs > 26) ST.fs = 16;
      applyReadStyle();
      save();
    });
    on('#bkReadTheme', 'click', function (e) {
      e.preventDefault();
      var order = ['paper', 'night', 'white'];
      var i = order.indexOf(ST.theme || 'paper');
      ST.theme = order[(i + 1) % order.length];
      applyReadStyle();
      save();
    });
    on('#bkSrcKey', 'input', function (e) { srcFilter = e.target.value; renderSrcList(); });
    on('#bkSrcAll', 'click', function (e) {
      e.preventDefault();
      allSources(function (all) {
        for (var i = 0; i < all.length; i++) if (all[i].searchUrl) ST.on[all[i].id] = 1;
        save(); renderSrcList(); renderShelf(); toast('已全部启用');
      });
    });
    on('#bkSrcNone', 'click', function (e) {
      e.preventDefault();
      ST.on = {}; save(); renderSrcList(); renderShelf(); toast('已全部关闭');
    });
    on('#bkSrcList', 'change', function (e) {
      var cb = e.target.closest('[data-src]');
      if (!cb) return;
      var id = cb.getAttribute('data-src');
      if (cb.checked) ST.on[id] = 1; else delete ST.on[id];
      save(); renderShelf();
    });
    on('#bkSrcList', 'click', function (e) {
      var del = e.target.closest('[data-delsrc]');
      if (!del) return;
      var id = del.getAttribute('data-delsrc');
      if (!bkConfirm('del' + id, '再点一次删除这个书源')) return;
      ST.mine = ST.mine.filter(function (s) { return String(s.id) !== String(id); });
      delete ST.on[id];
      save(); renderSrcList(); toast('已删除');
    });
    on('#bkSrcImport', 'click', function (e) { e.preventDefault(); importJson($('#bkSrcJson').value); });
    on('#bkSrcFile', 'change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { importJson(String(fr.result || '')); };
      fr.onerror = function () { toast('读不了这个文件'); };
      fr.readAsText(f);
      e.target.value = '';
    });
  }

  var cfm = {};
  function bkConfirm(k, msg) {
    var t = Date.now();
    if (cfm[k] && t - cfm[k] < 4000) { delete cfm[k]; return true; }
    cfm[k] = t;
    toast(msg + '（4 秒内再点一次）');
    return false;
  }

  function importJson(text) {
    text = trim(text);
    if (!text) { toast('空的'); return; }
    var arr = null;
    try { arr = JSON.parse(text); } catch (e) { toast('不是合法 JSON'); return; }
    if (!Array.isArray(arr)) arr = [arr];
    var ok = 0, bad = 0;
    arr.forEach(function (s, i) {
      if (!s || typeof s !== 'object') { bad++; return; }
      var one = norm(s);
      if (!one.base && !one.name) { bad++; return; }
      if (!one.searchUrl) { bad++; return; }
      one.id = 'u' + Date.now().toString(36) + i + Math.floor(Math.random() * 999);
      one.mine = true;
      ST.mine.push({ id: one.id, name: one.name, base: one.base, group: one.group, header: one.header,
        searchUrl: one.searchUrl, rs: one.rs, ri: one.ri, rt: one.rt, rc: one.rc });
      ST.on[one.id] = 1;
      ok++;
    });
    save();
    if ($('#bkSrcJson')) $('#bkSrcJson').value = '';
    toast('导入 ' + ok + ' 个' + (bad ? '，跳过 ' + bad + ' 个（没搜索规则/带 JS）' : ''));
    renderSrcList();
  }

  function leaveReadToToc() {
    var b = curBook;
    var r = $('#bkRead'); if (r) r.classList.add('hidden');
    document.body.classList.remove('bk-reading');
    var bar = $('#tabbar'); if (bar) bar.classList.remove('hidden');
    showPage('bkBook');
  }

  function showTabBack() {
    ['bkShelf', 'bkFind', 'bkBook', 'bkSrc', 'bkRead'].forEach(function (id) { var e = $('#' + id); if (e) e.classList.add('hidden'); });
    var bar = $('#tabbar'); if (bar) bar.classList.remove('hidden');
    if (window.__zyShowTab) { try { window.__zyShowTab('me'); return; } catch (e) {} }
    var me = $('#mePage'); if (me) me.classList.remove('hidden');
  }

  function open() {
    init();
    withBuiltin(function () { showPage('bkShelf'); });
  }

  // 在正文里上下滑动时保存进度
  window.addEventListener('scroll', function () {}, true);

  window.BOOKS = { open: open, find: findStart, srcList: showSrc, importJson: importJson };

  // 入口按钮：脚本在 body 末尾，DOM 已经就绪，直接绑
  try {
    var btn = document.getElementById('btnBooks');
    if (btn) btn.addEventListener('click', function (e) { e.preventDefault(); open(); });
  } catch (e) {}
})();
