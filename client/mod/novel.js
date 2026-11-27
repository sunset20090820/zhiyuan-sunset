/* 纸鸢 模块：小说阅读（精简版阅读）
   mount(ctx) 往 ctx.el 里画：书架 / 搜索 / 目录 / 正文 / 书源
   依赖：窗口里的 BR（规则引擎，构建时内联）与 ZY_BS（书源数据，构建时内联） */
'use strict';

var NM_CSS = [
'.nm-root{display:flex;flex-direction:column;height:100%;font-size:14px}',
'.nm-bar{display:flex;align-items:center;gap:8px;padding:6px 2px 10px}',
'.nm-bar input{flex:1;min-width:0;height:38px;border-radius:10px;border:1px solid var(--line,rgba(0,0,0,.12));background:var(--bg-soft,rgba(0,0,0,.04));padding:0 12px;font-size:14px;color:inherit}',
'.nm-btn{height:38px;border-radius:10px;border:0;background:var(--accent,#3390ec);color:#fff;font-size:14px;padding:0 16px}',
'.nm-btn.ghost{background:var(--bg-soft,rgba(0,0,0,.06));color:inherit}',
'.nm-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:24px}',
'.nm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px 10px;padding:4px 0}',
'.nm-cell{display:flex;flex-direction:column;gap:6px}',
'.nm-cover{aspect-ratio:3/4;border-radius:12px;overflow:hidden;background:var(--bg-soft,rgba(0,0,0,.06));display:flex;align-items:center;justify-content:center;font-size:26px;color:var(--tg-sub,#888)}',
'.nm-cover img{width:100%;height:100%;object-fit:cover}',
'.nm-cname{font-size:13px;line-height:1.3;max-height:2.6em;overflow:hidden}',
'.nm-csub{font-size:11.5px;color:var(--tg-sub,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.nm-empty{grid-column:1/-1;text-align:center;color:var(--tg-sub,#888);font-size:13px;line-height:1.9;padding:36px 0}',
'.nm-item{display:flex;gap:12px;padding:12px 2px;border-bottom:1px solid var(--line,rgba(0,0,0,.07))}',
'.nm-ava{width:46px;height:62px;border-radius:8px;overflow:hidden;background:var(--bg-soft,rgba(0,0,0,.06));display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--tg-sub,#888);flex:0 0 auto}',
'.nm-ava img{width:100%;height:100%;object-fit:cover}',
'.nm-imain{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
'.nm-iname{font-size:14.5px;font-weight:600}',
'.nm-isub{font-size:12px;color:var(--tg-sub,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.nm-alt{font-size:11px;color:var(--tg-sub,#888);background:var(--bg-soft,rgba(0,0,0,.06));border-radius:999px;padding:1px 7px;font-weight:400}',
'.nm-loading{padding:26px 0;text-align:center;color:var(--tg-sub,#888);font-size:13px;line-height:1.8}',
'.nm-head{display:flex;gap:14px;padding:2px 0 12px}',
'.nm-bcover{width:88px;height:118px;border-radius:10px;overflow:hidden;background:var(--bg-soft,rgba(0,0,0,.06));flex:0 0 auto}',
'.nm-bcover img{width:100%;height:100%;object-fit:cover}',
'.nm-hmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}',
'.nm-bname{font-size:17px;font-weight:600}',
'.nm-sub{font-size:12px;color:var(--tg-sub,#888)}',
'.nm-acts{display:flex;gap:10px;margin:6px 0 14px}',
'.nm-acts .nm-btn{flex:1}',
'.nm-toc .nm-ch{padding:11px 2px;font-size:14px;border-bottom:1px solid var(--line,rgba(0,0,0,.07));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tg-sub,#888)}',
'.nm-toc .nm-ch.on{color:var(--accent,#3390ec)}',
'.nm-tochead{font-size:12.5px;color:var(--tg-sub,#888);padding:6px 0 8px}',
'.nm-srcrow{display:flex;align-items:center;gap:8px;padding:9px 2px;border-bottom:1px solid var(--line,rgba(0,0,0,.07));font-size:13px}',
'.nm-srcname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.nm-srcgroup{font-size:11px;color:var(--tg-sub,#888);max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.nm-srcdel{font-size:11px;background:none;border:0;color:#d2444a;padding:2px 4px}',
'.nm-srclist{max-height:46vh;overflow-y:auto;margin-bottom:10px}',
'.nm-textarea{width:100%;border-radius:10px;border:1px solid var(--line,rgba(0,0,0,.12));background:var(--bg-soft,rgba(0,0,0,.04));padding:10px;font-size:13px;color:inherit;min-height:88px}',
'.nm-row2{display:flex;gap:8px;margin-top:8px}',
'.nm-row2 .nm-btn{flex:1}',
'.nm-hint{font-size:12px;color:var(--tg-sub,#888);line-height:1.7;margin:6px 0}',
'.nm-altwrap{display:flex;flex-wrap:wrap;gap:8px;padding:4px 0 14px}',
'.nm-altwrap .nm-btn{height:34px;font-size:12.5px;padding:0 12px}',
/* 阅读页 */
'.nm-read{position:fixed;inset:0;z-index:80;display:flex;flex-direction:column;background:#f5efe2;color:#2a2118}',
'.nm-read[data-theme="night"]{background:#12141a;color:#b9c0cc}',
'.nm-read[data-theme="white"]{background:#fff;color:#222}',
'.nm-read.hidden{display:none}',
'.nm-rscroll{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px 20px 40px}',
'.nm-rinner{max-width:720px;margin:0 auto}',
'.nm-rtitle{font-size:17px;font-weight:600;margin:8px 0 18px;line-height:1.5}',
'.nm-rbody{line-height:1.85}',
'.nm-rbody p{margin:0 0 .85em;text-indent:2em}',
'.nm-rfoot{margin-top:24px}',
'.nm-navbtns{display:flex;gap:10px}',
'.nm-navbtns .nm-btn{flex:1;background:rgba(0,0,0,.06);color:inherit}',
'.nm-num{text-align:center;font-size:12px;opacity:.6;margin-top:14px}',
'.nm-rbar{display:flex;gap:6px;padding:8px 12px calc(8px + env(safe-area-inset-bottom));background:rgba(0,0,0,.06)}',
'.nm-rbar.hidden{display:none}',
'.nm-read[data-theme="night"] .nm-rbar{background:rgba(255,255,255,.06)}',
'.nm-rbar button{flex:1;background:none;border:0;font-size:13px;color:inherit;padding:10px 0}'
].join('\n');

function nmEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function nmTrim(s) { return String(s == null ? '' : s).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, ''); }

function mount(ctx) {
  var host = ctx.el;
  var LS = ctx.local;
  var all = (window.ZY_BS || []).slice();
  var st = LS.get('v1', {}) || {};
  if (!st.shelf) st.shelf = [];
  if (!st.mine) st.mine = [];
  if (!st.on) { st.on = {}; (window.ZY_BS_DEFAULT || []).forEach(function (id) { st.on[id] = 1; }); }
  if (!st.fs) st.fs = 18;
  if (!st.theme) st.theme = 'paper';
  function save() { LS.set('v1', st); }

  if (!document.getElementById('nm-css')) {
    var style = document.createElement('style');
    style.id = 'nm-css';
    style.textContent = NM_CSS;
    document.head.appendChild(style);
  }

  /* ---------- 书源 ---------- */
  function normSrc(s) {
    if (s.nm) return s;
    return {
      nm: 1,
      id: s.id != null ? s.id : s.i,
      name: s.name || s.n || s.bookSourceName || '',
      base: nmTrim(s.base || s.u || s.bookSourceUrl || ''),
      group: s.group || s.g || s.bookSourceGroup || '',
      header: s.header || s.h || '',
      searchUrl: s.searchUrl || s.s || '',
      rs: s.rs || s.ruleSearch || {},
      ri: s.ri || s.ruleBookInfo || {},
      rt: s.rt || s.ruleToc || {},
      rc: s.rc || s.ruleContent || {},
      mine: !!s.mine
    };
  }
  function sources() {
    var out = [];
    for (var i = 0; i < all.length; i++) out.push(normSrc(all[i]));
    for (var j = 0; j < st.mine.length; j++) out.push(normSrc(st.mine[j]));
    return out;
  }
  function srcById(id) {
    for (var j = 0; j < st.mine.length; j++) if (String(st.mine[j].id) === String(id)) return normSrc(st.mine[j]);
    for (var i = 0; i < all.length; i++) if (String(all[i].i) === String(id)) return normSrc(all[i]);
    return null;
  }
  function hdrOf(src) {
    if (!src.header) return null;
    try {
      var h = typeof src.header === 'string' ? JSON.parse(src.header) : src.header;
      return (h && typeof h === 'object') ? h : null;
    } catch (e) { return null; }
  }

  /* ---------- 网络 ---------- */
  function http(url, opts, cb) { ctx.http.get(url, opts || {}, cb); }

  /* ---------- 视图 ---------- */
  var view = 'shelf';
  var curBook = null, cacheCh = {};
  var findState = { key: '', total: 0, done: 0, stop: false, list: [], seen: {}, rank: {} };

  function root() { return host.querySelector('#nm-root'); }
  function $(sel) { var r = root(); return r ? r.querySelector(sel) : null; }
  function bodyBox() { return $('#nm-body'); }

  function render() {
    host.innerHTML = '<div id="nm-root" class="nm-root">' +
      '<div class="nm-bar">' +
      (view === 'shelf' || view === 'src'
        ? '<span style="flex:1;font-size:15px;font-weight:600">' + (view === 'shelf' ? '小说阅读' : '书源') + '</span>' +
          (view === 'shelf' ? '<button class="nm-btn ghost" data-act="src" type="button">书源</button>' : '')
        : '<button class="nm-btn ghost" data-act="back" type="button">‹</button>' +
          '<span id="nm-title" style="flex:1;font-size:15px;font-weight:600">' + nmEsc(findState.key || '') + '</span>' +
          (view === 'find' ? '<button class="nm-btn ghost" data-act="stop" type="button">停止</button>' : '')) +
      '</div>' +
      '<div id="nm-body" class="nm-body"></div></div>';
    paint();
  }

  function paint() {
    if (view === 'shelf') return paintShelf();
    if (view === 'find') return paintFind();
    if (view === 'book') { if (curBook) paintBookPage(curBook); return; }
    if (view === 'src') return paintSrc();
  }

  /* ---------- 书架 ---------- */
  function paintShelf() {
    var b = bodyBox();
    var html = '<div class="nm-bar"><input id="nm-key" placeholder="搜书名或作者" enterkeyhint="search">' +
      '<button class="nm-btn" data-act="go" type="button">搜索</button></div>';
    if (!st.shelf.length) {
      html += '<div class="nm-empty">书架还空着<br>上面搜一本试试</div>';
    } else {
      html += '<div class="nm-grid">' + st.shelf.map(function (x, i) {
        return '<div class="nm-cell" data-shelf="' + i + '"><div class="nm-cover">' +
          (x.cover ? '<img src="' + nmEsc(x.cover) + '" referrerpolicy="no-referrer" onerror="this.remove()">' : '<span>' + nmEsc((x.name || '?').slice(0, 1)) + '</span>') +
          '</div><div class="nm-cname">' + nmEsc(x.name) + '</div>' +
          '<div class="nm-csub">' + nmEsc(x.lastRead || '未开始') + '</div></div>';
      }).join('') + '</div>';
    }
    var n = 0;
    for (var k in st.on) if (st.on[k]) n++;
    html += '<p class="nm-hint">已启用 ' + n + ' 个书源 · 直连书站，不走服务器</p>';
    b.innerHTML = html;
  }

  /* ---------- 搜索 ---------- */
  function startFind(key) {
    key = nmTrim(key);
    if (!key) { ctx.toast('先写书名或作者'); return; }
    var on = st.on, picked = sources().filter(function (s) { return on[s.id] && s.searchUrl && s.rs && s.rs.bookList; });
    if (!picked.length) { ctx.toast('没有启用的书源'); view = 'src'; render(); return; }
    var rank = {};
    (window.ZY_BS_DEFAULT || []).forEach(function (id, i) { rank[id] = i; });
    findState = { key: key, total: picked.length, done: 0, stop: false, list: [], seen: {}, rank: rank };
    view = 'find';
    render();
    var idx = 0, active = 0, CONC = 4;
    function next() {
      if (findState.stop) return;
      if (idx >= picked.length && active === 0) { findState.done = findState.total; paintProg(); return; }
      while (active < CONC && idx < picked.length) {
        (function (src) {
          active++;
          var settled = false;
          var timer = setTimeout(function () { if (settled) return; settled = true; active--; findState.done++; paintProg(); next(); }, 14000);
          searchOne(src, key, function (items) {
            if (settled) return;
            settled = true; clearTimeout(timer); active--; findState.done++;
            if (items && items.length) pushItems(items);
            paintProg();
            next();
          });
        })(picked[idx++]);
      }
    }
    next();
  }

  function searchOne(src, key, cb) {
    var rq = BR.parseSearchUrl(src.searchUrl, { key: key, page: 1, host: src.base, baseUrl: src.base });
    var url = rq.url;
    if (!url) return cb([]);
    if (!/^https?:/i.test(url)) url = BR.absUrl(url, src.base);
    if (!/^https?:/i.test(url)) return cb([]);
    http(url, { method: rq.method, body: rq.body, charset: rq.charset, headers: hdrOf(src) }, function (status, body) {
      if (status >= 400 || !body) return cb([]);
      var isJson = /^\s*[\{\[]/.test(body) && /\$\./.test(src.rs.bookList || '');
      var json = null;
      if (isJson) { try { json = JSON.parse(body); } catch (e) { json = null; } }
      var doc = isJson ? null : BR.parseHtml(body);
      var nodes = BR.list(doc, src.rs.bookList, url, json), items = [];
      for (var i = 0; i < nodes.length && i < 30; i++) {
        var el = nodes[i];
        var jn = (typeof el === 'object' && !el.nodeType) ? el : null;
        var nm = nmTrim(String(BR.inEl(jn ? null : el, src.rs.name, url, jn) || (jn && jn.name) || '').replace(/\s+/g, ' '));
        var bu = nmTrim(BR.inEl(jn ? null : el, src.rs.bookUrl, url, jn) || (jn && (jn.bookUrl || jn.url)) || '');
        if (!nm || !bu) continue;
        if (nm.length > 40 || /章节目录|最新章节|查看全部|本书角色|书友/.test(nm)) continue;
        var abs = BR.absUrl(bu, url);
        if (!/^https?:/i.test(abs)) continue;
        items.push({
          src: src.id, sName: src.name, name: nm,
          author: nmTrim(BR.inEl(jn ? null : el, src.rs.author, url, jn) || (jn && jn.author) || ''),
          url: abs,
          cover: BR.absUrl(BR.inEl(jn ? null : el, src.rs.coverUrl, url, jn) || (jn && jn.coverUrl) || '', url),
          kind: nmTrim(BR.inEl(jn ? null : el, src.rs.kind, url, jn) || (jn && jn.kind) || ''),
          last: nmTrim(BR.inEl(jn ? null : el, src.rs.lastChapter, url, jn) || (jn && jn.lastChapter) || '')
        });
      }
      cb(items);
    });
  }

  function pushItems(items) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i], k = (it.name + '|' + it.author).toLowerCase();
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
    var rk = findState.rank || {};
    findState.list.sort(function (a, b) {
      var ra = rk[a.src] == null ? 999 : rk[a.src], rb = rk[b.src] == null ? 999 : rk[b.src];
      return ra !== rb ? ra - rb : String(a.name).localeCompare(String(b.name));
    });
    paintFindList();
  }
  function findRow(it, i) {
    return '<div class="nm-item" data-find="' + i + '"><div class="nm-ava">' +
      (it.cover ? '<img src="' + nmEsc(it.cover) + '" referrerpolicy="no-referrer" onerror="this.remove()">' : nmEsc(it.name.slice(0, 1))) +
      '</div><div class="nm-imain"><div class="nm-iname">' + nmEsc(it.name) +
      (it.alt > 1 ? ' <span class="nm-alt">' + it.alt + ' 个源</span>' : '') + '</div>' +
      '<div class="nm-isub">' + nmEsc(it.author || '佚名') + (it.kind ? ' · ' + nmEsc(it.kind) : '') + '</div>' +
      '<div class="nm-isub">' + nmEsc(it.sName) + (it.last ? ' · ' + nmEsc(it.last) : '') + '</div></div></div>';
  }
  function paintFindList() {
    var list = $('#nm-list');
    if (!list) return;
    list.innerHTML = findState.list.map(findRow).join('');
  }
  function paintProg() {
    var p = $('#nm-prog');
    if (!p) return;
    var s = '已搜 ' + findState.done + ' / ' + findState.total + ' 个源，' + findState.list.length + ' 本';
    if (findState.done >= findState.total) s += '（完成）';
    if (findState.stop) s += '（已停止）';
    p.textContent = s;
  }
  function paintFind() {
    var b = bodyBox();
    b.innerHTML = '<p id="nm-prog" class="nm-hint"></p><div id="nm-list"></div>';
    paintProg();
    paintFindList();
  }

  /* ---------- 书籍详情 ---------- */
  function openBook(srcId, url, preset) {
    var src = srcById(srcId);
    if (!src) { ctx.toast('书源不见了'); return; }
    view = 'book';
    render();
    bodyBox().innerHTML = '<div class="nm-loading">正在打开…</div>';
    http(url, { headers: hdrOf(src) }, function (status, body) {
      var b = bodyBox();
      if (!b) return;
      if (status >= 400 || !body) { b.innerHTML = '<div class="nm-loading">打不开：' + nmEsc('HTTP ' + status) + '</div>'; return; }
      var doc = BR.parseHtml(body);
      var nm = nmTrim(String(BR.one(doc, src.ri.name || src.rs.name, url) || '').replace(/\s+/g, ' '));
      if (nm.length > 40) nm = '';
      var info = {
        name: nm || (preset && preset.name) || '',
        author: nmTrim(BR.one(doc, src.ri.author, url)) || (preset && preset.author) || '',
        cover: BR.absUrl(BR.one(doc, src.ri.coverUrl, url) || (preset && preset.cover) || '', url),
        intro: String(BR.one(doc, src.ri.intro, url) || '').slice(0, 1200),
        kind: nmTrim(BR.one(doc, src.ri.kind, url)),
        last: nmTrim(BR.one(doc, src.ri.lastChapter, url))
      };
      var tocUrl = BR.absUrl(BR.one(doc, src.ri.tocUrl, url), url) || url;
      var done = function (tocDoc, base) {
        var chs = [], nodes = BR.list(tocDoc, src.rt.chapterList, base);
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          var cn = nmTrim(BR.inEl(el, src.rt.chapterName, base));
          var cu = BR.absUrl(BR.inEl(el, src.rt.chapterUrl, base), base);
          if (!cn || !cu) continue;
          chs.push({ name: cn, url: cu });
        }
        var alts = chs.length ? [] : findAlts((preset && preset.name) || info.name || '', (preset && preset.author) || info.author || '');
        var book = curBook = {
          dbg: { url: url, st: status, len: (body || '').length, toc: tocUrl },
          srcId: src.id, srcName: src.name, url: url,
          name: info.name || (preset && preset.name) || '未命名',
          author: info.author || (preset && preset.author) || '',
          cover: info.cover, intro: info.intro, kind: info.kind, last: info.last,
          chapters: chs, alts: alts, chIdx: 0
        };
        var old = shelfFind(url);
        if (old) book.chIdx = old.chIdx || 0;
        paintBookPage(book);
      };
      if (tocUrl && tocUrl !== url) http(tocUrl, { headers: hdrOf(src) }, function (s2, b2) { done(s2 >= 400 || !b2 ? doc : BR.parseHtml(b2), tocUrl); });
      else done(doc, url);
    });
  }

  function findAlts(name, author) {
    var rec = findState.seen[(name + '|' + author).toLowerCase()];
    return rec ? rec.alts : [];
  }

  function paintBookPage(book) {
    var b = bodyBox();
    if (!b) return;
    host.querySelector('#nm-title').textContent = book.name;
    var html = '<div class="nm-head"><div class="nm-bcover">' +
      (book.cover ? '<img src="' + nmEsc(book.cover) + '" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
      '</div><div class="nm-hmain"><div class="nm-bname">' + nmEsc(book.name) + '</div>' +
      '<div class="nm-sub">' + nmEsc(book.author || '佚名') + '</div>' +
      '<div class="nm-sub">' + nmEsc(book.srcName) + '</div>' +
      (book.last ? '<div class="nm-sub">' + nmEsc(book.last) + '</div>' : '') + '</div></div>' +
      '<div class="nm-acts">' +
      '<button class="nm-btn" data-act="read" type="button">' + (book.chapters.length ? '开始阅读' : '重试') + '</button>' +
      '<button class="nm-btn ghost" data-act="shelf" type="button">' + (shelfFind(book.url) ? '已在书架' : '加入书架') + '</button></div>';
    if (book.intro) html += '<p class="nm-hint">' + nmEsc(book.intro) + '</p>';
    html += '<div class="nm-toc">';
    if (!book.chapters.length) {
      html += '<div class="nm-loading">这个源没读到目录' + (book.alts.length > 1 ? '，换个源试试：' : '（目录规则可能带 JS）') +
        '<br><span style="font-size:11px;opacity:.7">' + nmEsc((book.dbg ? book.dbg.url : '') + ' · HTTP ' + (book.dbg ? book.dbg.st : '?') + ' · ' + (book.dbg ? book.dbg.len : 0) + ' 字节') + '</span></div>';
      if (book.alts.length > 1) {
        html += '<div class="nm-altwrap">' + book.alts.slice(1, 9).map(function (a, i) {
          return '<button class="nm-btn ghost" data-alt="' + (i + 1) + '" type="button">' + nmEsc(a.sName) + '</button>';
        }).join('') + '</div>';
      }
    } else {
      html += '<div class="nm-tochead">目录 · ' + book.chapters.length + ' 章</div>';
      var lim = Math.min(book.chapters.length, 500);
      for (var i = 0; i < lim; i++) {
        html += '<div class="nm-ch' + (i === book.chIdx ? ' on' : '') + '" data-ch="' + i + '">' + nmEsc(book.chapters[i].name) + '</div>';
      }
    }
    html += '</div>';
    b.innerHTML = html;
  }

  /* ---------- 书架操作 ---------- */
  function shelfFind(url) {
    for (var i = 0; i < st.shelf.length; i++) if (st.shelf[i].url === url) return st.shelf[i];
    return null;
  }
  function addShelf(book) {
    var old = shelfFind(book.url);
    var row = {
      url: book.url, srcId: book.srcId, name: book.name, author: book.author, cover: book.cover,
      chIdx: old ? old.chIdx : 0, lastRead: old ? old.lastRead : '', ts: Date.now()
    };
    if (old) { for (var k in row) old[k] = row[k]; }
    else st.shelf.unshift(row);
    save();
  }

  /* ---------- 正文 ---------- */
  function plainText(t) {
    var x = String(t || '');
    if (x.indexOf('<') >= 0) {
      x = x.replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\/\s*(p|div|li|h\d)\s*>/gi, '\n').replace(/<[^>]+>/g, '');
      x = x.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    }
    return x.replace(/\r/g, '');
  }

  var readEl = null;
  function ensureReadEl() {
    if (readEl && document.body.contains(readEl)) return readEl;
    readEl = document.createElement('div');
    readEl.className = 'nm-read hidden';
    readEl.innerHTML = '<div class="nm-rscroll"><div class="nm-rinner">' +
      '<h2 class="nm-rtitle" id="nm-rtitle"></h2><div class="nm-rbody" id="nm-rbody"></div>' +
      '<div class="nm-rfoot" id="nm-rfoot"></div></div></div>' +
      '<div class="nm-rbar hidden" id="nm-rbar">' +
      '<button type="button" data-r="prev">上一章</button><button type="button" data-r="toc">目录</button>' +
      '<button type="button" data-r="next">下一章</button><button type="button" data-r="font">A+</button>' +
      '<button type="button" data-r="theme">纸</button></div>';
    document.body.appendChild(readEl);
    readEl.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-r]');
      if (btn) {
        var r = btn.getAttribute('data-r');
        if (r === 'prev') openChapter(curBook, curBook.chIdx - 1);
        else if (r === 'next') openChapter(curBook, curBook.chIdx + 1);
        else if (r === 'toc') closeRead(null);
        else if (r === 'font') { st.fs = st.fs >= 26 ? 16 : st.fs + 2; save(); applyReadStyle(); }
        else if (r === 'theme') {
          var order = ['paper', 'night', 'white'];
          st.theme = order[(order.indexOf(st.theme) + 1) % 3]; save(); applyReadStyle();
        }
        return;
      }
      var bar = readEl.querySelector('#nm-rbar');
      if (bar) bar.classList.toggle('hidden');
    });
    return readEl;
  }
  function applyReadStyle() {
    var el = ensureReadEl();
    el.setAttribute('data-theme', st.theme || 'paper');
    var body = el.querySelector('#nm-rbody');
    if (body) body.style.fontSize = (st.fs || 18) + 'px';
  }
  function openChapter(book, idx) {
    if (!book || !book.chapters.length) { ctx.toast('没有章节'); return; }
    idx = Math.max(0, Math.min(book.chapters.length - 1, idx));
    book.chIdx = idx;
    var ch = book.chapters[idx];
    var el = ensureReadEl();
    el.classList.remove('hidden');
    document.body.classList.add('nm-reading');
    applyReadStyle();
    var title = el.querySelector('#nm-rtitle'), body = el.querySelector('#nm-rbody'), foot = el.querySelector('#nm-rfoot');
    title.textContent = ch.name;
    var cached = cacheCh[ch.url];
    if (cached) { paintChapter(el, book, idx, cached); return; }
    body.innerHTML = '<div class="nm-loading">正在取正文…</div>';
    foot.innerHTML = '';
    var src = srcById(book.srcId);
    if (!src) { body.innerHTML = '<div class="nm-loading">书源不见了</div>'; return; }
    http(ch.url, { headers: hdrOf(src) }, function (status, html) {
      if (status >= 400 || !html) { body.innerHTML = '<div class="nm-loading">取不到正文（HTTP ' + status + '）</div>'; return; }
      var doc = BR.parseHtml(html);
      var txt = nmTrim(BR.one(doc, src.rc.content, ch.url));
      if (!txt || txt.length < 200) {
        var cands = ['#content', '#chaptercontent', '#chapterContent', '#booktext', '#TextContent', '#nr1',
                     '#article', '#htmlContent', '.read-content', '.content-body', '.content', 'article', '#txtContent'];
        for (var i = 0; i < cands.length; i++) {
          var pick = '';
          try { pick = nmTrim((doc.querySelector(cands[i]) || {}).textContent || ''); } catch (e) {}
          if (pick.length > (txt || '').length) txt = pick;
          if (txt.length > 400) break;
        }
      }
      if (!txt) { body.innerHTML = '<div class="nm-loading">这个源取不到正文（规则可能带 JS）</div>'; return; }
      cacheCh[ch.url] = txt;
      paintChapter(el, book, idx, txt);
    });
  }
  function paintChapter(el, book, idx, txt) {
    var paras = plainText(txt).split(/\n+/);
    var html = '';
    for (var i = 0; i < paras.length; i++) {
      var p = nmTrim(paras[i]);
      if (p) html += '<p>' + nmEsc(p) + '</p>';
    }
    el.querySelector('#nm-rbody').innerHTML = html;
    el.querySelector('#nm-rtitle').textContent = book.chapters[idx].name;
    el.querySelector('#nm-rfoot').innerHTML =
      '<div class="nm-navbtns"><button class="nm-btn" data-r="prev" type="button">上一章</button>' +
      '<button class="nm-btn" data-r="toc" type="button">目录</button>' +
      '<button class="nm-btn" data-r="next" type="button">下一章</button></div>' +
      '<div class="nm-num">' + (idx + 1) + ' / ' + book.chapters.length + '</div>';
    el.querySelector('.nm-rscroll').scrollTop = 0;
    book.lastRead = book.chapters[idx].name;
    addShelf(book);
  }
  function closeRead() {
    if (readEl) readEl.classList.add('hidden');
    document.body.classList.remove('nm-reading');
    if (curBook) paintBookPage(curBook);
    render();
  }

  /* ---------- 书源管理 ---------- */
  var srcFilter = '';
  function paintSrc() {
    var b = bodyBox();
    var on = st.on, nOn = 0;
    for (var k in on) if (on[k]) nOn++;
    var kw = nmTrim(srcFilter).toLowerCase();
    var list = sources().filter(function (s) {
      if (!s.searchUrl) return false;
      if (!kw) return true;
      return (s.name + ' ' + s.group).toLowerCase().indexOf(kw) >= 0;
    });
    var html = '<div class="nm-bar"><input id="nm-sk" placeholder="筛书源名 / 分组" value="' + nmEsc(srcFilter) + '">' +
      '<button class="nm-btn ghost" data-act="allon" type="button">全开</button>' +
      '<button class="nm-btn ghost" data-act="alloff" type="button">全关</button></div>';
    html += '<p class="nm-hint">共 ' + sources().length + ' 个源，启用 ' + nOn + ' 个。默认开的都是实测能搜到书的；想搜更多就按关键字筛出来打勾。</p>';
    html += '<div class="nm-srclist">';
    var lim = Math.min(list.length, 400);
    for (var i = 0; i < lim; i++) {
      var s = list[i];
      html += '<label class="nm-srcrow"><input type="checkbox" data-src="' + nmEsc(s.id) + '"' + (on[s.id] ? ' checked' : '') + '>' +
        '<span class="nm-srcname">' + nmEsc(s.name) + (s.mine ? ' <span class="nm-alt">自加</span>' : '') + '</span>' +
        '<span class="nm-srcgroup">' + nmEsc((s.group || '').split(',')[0]) + '</span>' +
        (s.mine ? '<button class="nm-srcdel" type="button" data-del="' + nmEsc(s.id) + '">删</button>' : '') + '</label>';
    }
    if (list.length > lim) html += '<p class="nm-hint">还有 ' + (list.length - lim) + ' 个，写关键字再筛</p>';
    html += '</div>';
    html += '<p class="nm-hint">添加书源（阅读 App 的 JSON 格式，可一次多个）：</p>' +
      '<textarea class="nm-textarea" id="nm-sjson" placeholder=\'[{"bookSourceName":"某某小说","bookSourceUrl":"https://…","searchUrl":"…","ruleSearch":{…}}]\'></textarea>' +
      '<div class="nm-row2"><button class="nm-btn" data-act="import" type="button">导入粘贴</button>' +
      '<button class="nm-btn ghost" data-act="file" type="button">选文件</button></div>' +
      '<input id="nm-sfile" type="file" accept=".json,application/json" hidden>';
    b.innerHTML = html;
  }

  function importJson(text) {
    text = nmTrim(text);
    if (!text) { ctx.toast('空的'); return; }
    var arr;
    try { arr = JSON.parse(text); } catch (e) { ctx.toast('不是合法 JSON'); return; }
    if (!Array.isArray(arr)) arr = [arr];
    var ok = 0, bad = 0;
    arr.forEach(function (s, i) {
      if (!s || typeof s !== 'object') { bad++; return; }
      var one = normSrc(s);
      if (!one.name || !one.searchUrl) { bad++; return; }
      var id = 'u' + Date.now().toString(36) + i;
      one.id = id; one.mine = true;
      st.mine.push({ id: id, name: one.name, base: one.base, group: one.group, header: one.header,
        searchUrl: one.searchUrl, rs: one.rs, ri: one.ri, rt: one.rt, rc: one.rc, mine: true });
      st.on[id] = 1;
      ok++;
    });
    save();
    ctx.toast('导入 ' + ok + ' 个' + (bad ? '，跳过 ' + bad + ' 个' : ''));
    paintSrc();
  }

  /* ---------- 事件 ---------- */
  function onClick(e) {
    var act = e.target.closest('[data-act]');
    if (act) {
      var a = act.getAttribute('data-act');
      if (a === 'src') { view = 'src'; render(); return; }
      if (a === 'back') {
        if (view === 'find') { findState.stop = true; view = 'shelf'; render(); return; }
        if (view === 'book') { view = findState.list.length ? 'find' : 'shelf'; render(); return; }
        if (view === 'src') { view = 'shelf'; render(); return; }
      }
      if (a === 'go') { var k = $('#nm-key'); startFind(k ? k.value : ''); return; }
      if (a === 'stop') { findState.stop = true; paintProg(); return; }
      if (a === 'alloff') { st.on = {}; save(); paintSrc(); return; }
      if (a === 'allon') {
        sources().forEach(function (s) { if (s.searchUrl) st.on[s.id] = 1; });
        save(); paintSrc(); ctx.toast('已全部启用'); return;
      }
      if (a === 'import') { importJson($('#nm-sjson').value); return; }
      if (a === 'file') { var f = $('#nm-sfile'); if (f) f.click(); return; }
      if (a === 'read') {
        if (!curBook) return;
        if (!curBook.chapters.length) { openBook(curBook.srcId, curBook.url, curBook); return; }
        openChapter(curBook, Math.min(curBook.chIdx || 0, curBook.chapters.length - 1)); return;
      }
      if (a === 'shelf') { if (curBook) { addShelf(curBook); ctx.toast('已加入书架'); paintBookPage(curBook); } return; }
    }
    var findRowEl = e.target.closest('[data-find]');
    if (findRowEl) {
      var it = findState.list[Number(findRowEl.getAttribute('data-find'))];
      if (it) openBook(it.src, it.url, { name: it.name, author: it.author, cover: it.cover });
      return;
    }
    var shelfEl = e.target.closest('[data-shelf]');
    if (shelfEl) {
      var bk = st.shelf[Number(shelfEl.getAttribute('data-shelf'))];
      if (bk) openBook(bk.srcId, bk.url, { name: bk.name, author: bk.author, cover: bk.cover });
      return;
    }
    var chEl = e.target.closest('[data-ch]');
    if (chEl && curBook) { openChapter(curBook, Number(chEl.getAttribute('data-ch'))); return; }
    var altEl = e.target.closest('[data-alt]');
    if (altEl && curBook) {
      var alt = curBook.alts[Number(altEl.getAttribute('data-alt'))];
      if (alt) openBook(alt.src, alt.url, { name: alt.name, author: alt.author, cover: alt.cover });
      return;
    }
  }
  function onChange(e) {
    var cb = e.target.closest('[data-src]');
    if (cb) {
      var id = cb.getAttribute('data-src');
      if (cb.checked) st.on[id] = 1; else delete st.on[id];
      save();
      return;
    }
    var f = e.target.closest('#nm-sfile');
    if (f && f.files && f.files[0]) {
      var fr = new FileReader();
      fr.onload = function () { importJson(String(fr.result || '')); };
      fr.onerror = function () { ctx.toast('读不了这个文件'); };
      fr.readAsText(f.files[0]);
    }
  }
  function onInput(e) {
    if (e.target.id === 'nm-sk') { srcFilter = e.target.value; paintSrc(); }
  }
  function onKey(e) {
    if (e.target.id === 'nm-key' && e.key === 'Enter') { e.preventDefault(); startFind(e.target.value); }
  }
  function onDelClick(e) {
    var del = e.target.closest('[data-del]');
    if (!del) return;
    var id = del.getAttribute('data-del');
    if (!ctx.confirmTap('nmdel' + id)) return;
    st.mine = st.mine.filter(function (s) { return String(s.id) !== String(id); });
    delete st.on[id];
    save(); paintSrc(); ctx.toast('已删除');
  }

  host.addEventListener('click', onClick);
  host.addEventListener('click', onDelClick);
  host.addEventListener('change', onChange);
  host.addEventListener('input', onInput);
  host.addEventListener('keydown', onKey);
  ctx.setTitle('小说阅读');
  render();

  ctx.__cleanup = function () {
    host.removeEventListener('click', onClick);
    host.removeEventListener('click', onDelClick);
    host.removeEventListener('change', onChange);
    host.removeEventListener('input', onInput);
    host.removeEventListener('keydown', onKey);
    if (readEl && readEl.parentNode) readEl.parentNode.removeChild(readEl);
    readEl = null;
    document.body.classList.remove('nm-reading');
  };
}

function unmount(ctx) {
  try { if (ctx && ctx.__cleanup) ctx.__cleanup(); } catch (e) {}
}

if (typeof module !== 'undefined' && module.exports) module.exports = { mount: mount, unmount: unmount };
