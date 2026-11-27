/* 广场（公共动态）：ES5，无依赖。由 app.js 在 boot 时 init，
   WebSocket 收到 moment_* 时调用 onMessage，其它钩子由 app 提供。 */
(function (w) {
  'use strict';
  var MOM = {};
  var api = null;
  var items = [];        // 新 → 旧
  var expanded = {};     // 动态 id → 评论是否全展开
  var replyTo = {};      // 动态 id → { cid, name } 当前回复谁
  var more = false;        // 还没拉过就是 false，别急着显示「加载更早」
  var loading = false;
  var myUid = 0;
  var pendingImg = '';   // dataURL
  var pendingW = 0, pendingH = 0;
  var opened = false;
  var lastSeenTs = 0;
  var unread = 0;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nowMs() { return Date.now(); }
  function timeAgo(ts) {
    var d = Math.max(0, nowMs() - Number(ts || 0));
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 604800000) return Math.floor(d / 86400000) + ' 天前';
    var dt = new Date(Number(ts));
    return (dt.getMonth() + 1) + '/' + dt.getDate();
  }
  // uid 不缓存：登录/切换账号的时机太多（auth / contacts / resume / uid），
  // 每次渲染都问一次最省事，省得漏同步
  function uidNow() { return Number((api && api.myUid && api.myUid()) || myUid || 0) || 0; }
  function isMine(m) { var u = uidNow(); return !!u && Number(m.uid) === u; }
  function likedBy(m, uid) {
    if (!uid) return false;
    for (var i = 0; i < (m.likes || []).length; i++) if (Number(m.likes[i]) === Number(uid)) return true;
    return false;
  }
  function setBadge(n) {
    unread = Math.max(0, n | 0);
    var dot = el('feedDot');
    if (!dot) return;
    dot.classList.toggle('hidden', unread <= 0);
    dot.textContent = unread > 9 ? '9+' : (unread > 0 ? String(unread) : '');
  }

  /* ---------------- 渲染 ---------------- */
  function cmtHTML(m, c) {
    var mineC = Number(c.uid) === uidNow();
    var canDel = mineC || isMine(m) || api.isDev();
    var who = '<b>' + esc(c.name || '某人') + '</b>' +
      (c.toName ? ' 回复 <b>' + esc(c.toName) + '</b>' : '') + '：';
    return '<div class="mo-cmt" data-mo-replyto="' + esc(c.id || '') + '">' +
      '<span class="mo-cmt-body">' + who + esc(c.text) + '</span>' +
      (canDel ? '<button class="mo-cmt-del" type="button" data-mo-cmtdel="' + esc(c.id || '') + '">删除</button>' : '') +
      '</div>';
  }
  function cardHTML(m) {
    var mine = isMine(m);
    var img = '';
    if (m.img) {
      var src = api.imgSrc ? api.imgSrc(m.img) : m.img;
      // 单图：按宽高比给一个不太高的框，避免一张长图占满屏
      var ratio = (m.w && m.h) ? (m.w / m.h) : 1.4;
      var hgt = ratio > 1 ? Math.round(180 / ratio) : 220;
      if (hgt < 90) hgt = 90;
      img = '<div class="mo-img" data-mo-img="' + esc(src) + '" style="height:' + hgt + 'px">' +
            '<img src="' + esc(src) + '" alt=""></div>';
    }
    var allC = m.comments || [];
    var exp = !!expanded[m.id];
    // 卡片上只摆最新两条，其余收在「查看全部 N 条评论」后面（QQ空间 也是这样）
    var showC = exp ? allC : allC.slice(Math.max(0, allC.length - 2));
    var cmts = showC.map(function (c) { return cmtHTML(m, c); }).join('');
    var moreC = (!exp && allC.length > showC.length)
      ? '<button class="mo-cmt-more" type="button" data-mo-expand="' + esc(m.id) + '">查看全部 ' + allC.length + ' 条评论</button>'
      : '';
    var nLike = (m.likes || []).length;
    return '<li class="mo-item' + (mine ? ' mine' : '') + '" data-mo-id="' + esc(m.id) + '">' +
      '<div class="mo-ava" style="background:' + (api.colorOf ? api.colorOf(m.uid || m.name) : '#8fa4f5') + '">' +
        (m.avatar ? '<img src="' + esc(api.imgSrc ? api.imgSrc(m.avatar) : m.avatar) + '" alt="">' : esc(String(m.name || '?').slice(0, 1))) +
      '</div>' +
      '<div class="mo-body">' +
        '<div class="mo-head"><b class="mo-name">' + esc(m.name || '某人') + '</b>' +
          (mine ? '<span class="mo-tag">我</span>' : '') +
          '<span class="mo-time">' + esc(timeAgo(m.ts)) + '</span>' +
          (mine || api.isDev() ? '<button class="mo-del" type="button" data-mo-del="' + esc(m.id) + '" aria-label="删除">⋯</button>' : '') +
          (!mine ? '<button class="mo-del mo-rep" type="button" data-mo-rep="' + esc(m.id) + '" aria-label="举报">⚑</button>' : '') +
        '</div>' +
        (m.text ? '<div class="mo-text-body">' + esc(m.text) + '</div>' : '') +
        img +
        (cmts || moreC ? '<div class="mo-cmts">' + cmts + moreC + '</div>' : '') +
        '<div class="mo-foot">' +
          '<button class="mo-btn' + (likedBy(m, uidNow()) ? ' on' : '') + '" type="button" data-mo-like="' + esc(m.id) + '">' +
            (likedBy(m, uidNow()) ? '♥ 已赞' : '♡ 赞') + (nLike ? ' ' + nLike : '') + '</button>' +
          '<button class="mo-btn" type="button" data-mo-cmt="' + esc(m.id) + '">💬 评论' + ((m.comments || []).length ? ' ' + (m.comments || []).length : '') + '</button>' +
        '</div>' +
        '<div class="mo-cmt-row hidden" data-mo-row="' + esc(m.id) + '" data-reply-to="">' +
          '<div class="mo-reply-chip hidden"><span class="mo-reply-text"></span>' +
            '<button class="mo-reply-x" type="button" data-mo-reply-x="' + esc(m.id) + '" aria-label="取消回复">×</button></div>' +
          '<div class="mo-cmt-line">' +
            '<input class="mo-cmt-input" maxlength="200" placeholder="评论…">' +
            '<button class="mo-cmt-send" type="button" data-mo-cmt-send="' + esc(m.id) + '">发送</button>' +
          '</div>' +
        '</div>' +
      '</div></li>';
  }
  function render() {
    var box = el('feedList');
    if (!box) return;
    if (!items.length) {
      box.innerHTML = '';
      var emp = el('feedEmpty');
      if (emp) emp.style.display = '';
      return;
    }
    var emp2 = el('feedEmpty');
    if (emp2) emp2.style.display = 'none';
    box.innerHTML = '<ul class="mo-list">' + items.map(cardHTML).join('') + '</ul>' +
      (more ? '<button class="mo-more" type="button" id="moMore">加载更早的</button>'
            : (items.length >= 12 ? '<p class="hint mo-end">没有更早的了</p>' : ''));
    var b = el('moMore');
    if (b) b.addEventListener('click', function () { load(true); });
  }
  function upsert(m) {
    for (var i = 0; i < items.length; i++) if (items[i].id === m.id) { items[i] = m; return true; }
    return false;
  }

  /* ---------------- 数据 ---------------- */
  var retryTimer = 0;
  function load(older, isRetry) {
    if (loading && !isRetry) return;
    if (!older && !isRetry) { if (items.length && nowMs() - lastSeenTs < 1500) return; }
    loading = true;
    var before = older && items.length ? items[items.length - 1].ts : 0;
    var ok = api.send({ t: 'moment_list', before: before, limit: 12 });
    if (!ok) { loading = false; api.toast('没连上服务器'); return; }
    lastSeenTs = nowMs();
    // 刚连上时客户端会连着发一串消息，服务端可能把这条挡掉；1 秒没回音就重试一次
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      if (!loading) return;
      loading = false;
      if (!isRetry) load(older, true);
    }, 1200);
  }

  /* ---------------- 交互 ---------------- */
  function openSheet() {
    var box = el('momentSheet');
    if (!box) return;
    pendingImg = ''; pendingW = 0; pendingH = 0;
    var t = el('moText');
    if (t) t.value = '';
    paintImg();
    box.classList.remove('hidden');
    setTimeout(function () {
      box.classList.add('open');
      if (t) setTimeout(function () { try { t.focus(); } catch (e) {} }, 120);
    }, 16);
  }
  function closeSheet() {
    var box = el('momentSheet');
    if (!box) return;
    box.classList.remove('open');
    setTimeout(function () { box.classList.add('hidden'); }, 220);
  }
  function paintImg() {
    var box = el('moImgBox'), img = el('moImg');
    if (!box || !img) return;
    if (pendingImg) { img.src = pendingImg; box.classList.remove('hidden'); }
    else box.classList.add('hidden');
  }
  function pickImg(file) {
    if (!file) return;
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      var max = 1080, w0 = img.width, h0 = img.height;
      if (w0 > max || h0 > max) { var sc = max / Math.max(w0, h0); w0 = Math.round(w0 * sc); h0 = Math.round(h0 * sc); }
      var c = document.createElement('canvas');
      c.width = w0; c.height = h0;
      c.getContext('2d').drawImage(img, 0, 0, w0, h0);
      var q = 0.82, data = '';
      try { data = c.toDataURL('image/jpeg', q); } catch (e) { api.toast('图片处理失败'); return; }
      while (data.length > 520000 && q > 0.35) { q -= 0.1; data = c.toDataURL('image/jpeg', q); }
      try { URL.revokeObjectURL(url); } catch (e2) {}
      pendingImg = data; pendingW = w0; pendingH = h0;
      paintImg();
    };
    img.onerror = function () { api.toast('这张图打不开'); };
    img.src = url;
  }
  function sendPost() {
    var t = el('moText');
    var text = (t && t.value || '').trim();
    if (!text && !pendingImg) { api.toast('写一句或配张图再发'); return; }
    var payload = { t: 'moment_post', text: text.slice(0, 600), w: pendingW, h: pendingH };
    if (pendingImg) payload.data = pendingImg;
    if (!api.send(payload)) { api.toast('没连上服务器'); return; }
    closeSheet();
    api.toast('已发布');
  }

  /* ---------------- 事件 ---------------- */
  // 打开某条动态的评论输入行；target 为空表示发普通评论，否则是「回复某人」
  function openRow(mid, target) {
    var list = el('feedList');
    if (!list) return;
    var row = list.querySelector('[data-mo-row="' + mid + '"]');
    if (!row) return;
    if (target && target.cid) {
      replyTo[mid] = target;
      row.setAttribute('data-reply-to', String(target.cid));
      row.setAttribute('data-reply-name', String(target.name || '某人').slice(0, 24));
    } else {
      replyTo[mid] = null;
      row.setAttribute('data-reply-to', '');
      row.removeAttribute('data-reply-name');
    }
    paintReply(row);
    row.classList.remove('hidden');
    try { row.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    var inp = row.querySelector('.mo-cmt-input');
    if (inp) {
      inp.placeholder = (target && target.cid) ? ('回复 ' + String(target.name || '某人').slice(0, 12) + '…') : '评论…';
      setTimeout(function () { try { inp.focus(); } catch (e) {} }, 60);
    }
  }
  function paintReply(row) {
    var chip = row.querySelector('.mo-reply-chip');
    var txt = row.querySelector('.mo-reply-text');
    if (!chip || !txt) return;
    if (row.getAttribute('data-reply-to')) {
      txt.textContent = '回复 ' + (row.getAttribute('data-reply-name') || '某人');
      chip.classList.remove('hidden');
    } else {
      chip.classList.add('hidden');
    }
  }
  function bind() {
    var list = el('feedList');
    if (list && !list.__momBound) {
      list.__momBound = true;
      list.addEventListener('click', function (e) {
        var t = e.target;
        var like = t.closest('[data-mo-like]');
        if (like) {
          if (!api.send({ t: 'moment_like', id: like.getAttribute('data-mo-like') })) api.toast('没连上服务器');
          return;
        }
        var cmt = t.closest('[data-mo-cmt]');
        if (cmt) {
          openRow(cmt.getAttribute('data-mo-cmt'), null);
          return;
        }
        // 点某条评论 = 回复这条评论（QQ空间 那样）
        var cmtLine = t.closest('[data-mo-replyto]');
        if (cmtLine && !t.closest('[data-mo-cmtdel]')) {
          var li = cmtLine.closest('[data-mo-id]');
          var mid = li && li.getAttribute('data-mo-id');
          if (mid) openRow(mid, { cid: cmtLine.getAttribute('data-mo-replyto'), name: cmtLine.querySelector('b').textContent });
          return;
        }
        var cmtDel = t.closest('[data-mo-cmtdel]');
        if (cmtDel) {
          var li2 = cmtDel.closest('[data-mo-id]');
          var mid2 = li2 && li2.getAttribute('data-mo-id');
          var cid = cmtDel.getAttribute('data-mo-cmtdel');
          if (!mid2) return;
          if (!api.confirmTap || api.confirmTap('moment-cmtdel-' + cid)) {
            if (!api.send({ t: 'moment_cmt_del', id: mid2, cid: cid })) api.toast('没连上服务器');
          }
          return;
        }
        var exp = t.closest('[data-mo-expand]');
        if (exp) {
          expanded[exp.getAttribute('data-mo-expand')] = true;
          render();
          return;
        }
        var rx = t.closest('[data-mo-reply-x]');
        if (rx) {
          var rid = rx.getAttribute('data-mo-reply-x');
          var rowx = list.querySelector('[data-mo-row="' + rid + '"]');
          if (rowx) { rowx.setAttribute('data-reply-to', ''); paintReply(rowx); }
          return;
        }
        var sendBtn = t.closest('[data-mo-cmt-send]');
        if (sendBtn) {
          var id = sendBtn.getAttribute('data-mo-cmt-send');
          var row2 = list.querySelector('[data-mo-row="' + id + '"]');
          var inp2 = row2 && row2.querySelector('.mo-cmt-input');
          var txt = (inp2 && inp2.value || '').trim();
          if (!txt) return;
          var rt = row2 && row2.getAttribute('data-reply-to');
          var payload = { t: 'moment_comment', id: id, text: txt.slice(0, 200) };
          if (rt) payload.replyTo = rt;
          if (!api.send(payload)) { api.toast('没连上服务器'); return; }
          inp2.value = '';
          if (row2) { row2.setAttribute('data-reply-to', ''); paintReply(row2); }
          return;
        }
        var del = t.closest('[data-mo-del]');
        if (del) {
          var did = del.getAttribute('data-mo-del');
          if (!api.confirmTap || api.confirmTap('moment-del-' + did)) {
            api.send({ t: 'moment_del', id: did });
          }
          return;
        }
        var rep = t.closest('[data-mo-rep]');
        if (rep) { openReport(findMoment(rep.getAttribute('data-mo-rep'))); return; }
        var im = t.closest('[data-mo-img]');
        if (im && api.viewImage) api.viewImage(im.getAttribute('data-mo-img'));
      });
      list.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var inp = e.target.closest && e.target.closest('.mo-cmt-input');
        if (!inp) return;
        var row = inp.closest('[data-mo-row]');
        var id = row && row.getAttribute('data-mo-row');
        var txt = (inp.value || '').trim();
        if (!id || !txt) return;
        e.preventDefault();
        var rt2 = row && row.getAttribute('data-reply-to');
        var pay2 = { t: 'moment_comment', id: id, text: txt.slice(0, 200) };
        if (rt2) pay2.replyTo = rt2;
        if (api.send(pay2)) {
          inp.value = '';
          if (row) { row.setAttribute('data-reply-to', ''); paintReply(row); }
        }
      });
      list.addEventListener('scroll', function () {
        if (!more || loading) return;
        if (list.scrollTop + list.clientHeight > list.scrollHeight - 220) load(true);
      }, { passive: true });
    }
    var fab = el('feedFab');
    if (fab) fab.addEventListener('click', function () { if (ftab === 'card') openShareCard(); else openSheet(); });
    bindReport();
    bindCards();
    var rf = el('feedRefresh');
    if (rf) rf.addEventListener('click', function () { items = []; more = false; load(false); });
    var scrim = el('momentSheet') && el('momentSheet').querySelector('.action-scrim');
    if (scrim) scrim.addEventListener('click', closeSheet);
    var pick = el('moPickImg');
    if (pick) pick.addEventListener('click', function () { var f = el('moImgInput'); if (f) { f.value = ''; f.click(); } });
    var fi = el('moImgInput');
    if (fi) fi.addEventListener('change', function () {
      var f = fi.files && fi.files[0];
      if (f) pickImg(f);
    });
    var idel = el('moImgDel');
    if (idel) idel.addEventListener('click', function () { pendingImg = ''; pendingW = 0; pendingH = 0; paintImg(); });
    var ms = el('moSend');
    if (ms) ms.addEventListener('click', sendPost);
  }


  /* ---------------- 弹层/编码小工具 ---------------- */
  function showLayer(id) {
    var L = el(id);
    if (!L) return;
    L.classList.remove('hidden');
    if (L.requestAnimationFrame) L.requestAnimationFrame(function () { L.classList.add('open'); });
    else setTimeout(function () { L.classList.add('open'); }, 16);
  }
  function hideLayer(id) {
    var L = el(id);
    if (!L) return;
    L.classList.remove('open');
    setTimeout(function () { L.classList.add('hidden'); }, 180);
  }
  function bytesToB64(u8) {
    var out = '', CH = 8192;
    for (var i = 0; i < u8.length; i += CH) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(out);
  }
  function b64ToUtf8(b64) {
    var bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(u8);
  }
  function utf8ToB64(str) {
    if (w.TextEncoder) return bytesToB64(new TextEncoder().encode(String(str)));
    return btoa(unescape(encodeURIComponent(String(str))));
  }
  function findMoment(id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  /* ---------------- 举报 ---------------- */
  var repTarget = null;
  var myReports = [];

  function openReport(m) {
    if (!m) return;
    repTarget = m.id;
    var what = el('reportWhat');
    if (what) {
      var body = m.text ? String(m.text).slice(0, 40) : (m.img ? '（图片动态）' : '（空动态）');
      what.textContent = '被举报人：' + (m.name || '某人') + '｜' + body;
    }
    var r = el('reportReason');
    if (r) r.value = '';
    showLayer('reportSheet');
  }
  function sendReport() {
    if (!repTarget) return;
    var r = el('reportReason');
    var txt = ((r && r.value) || '').trim();
    if (txt.length < 2) { api.toast('写一句理由，管理员才知道看什么'); return; }
    if (!api.send({ t: 'moment_report', id: repTarget, reason: txt.slice(0, 200) })) { api.toast('没连上服务器'); return; }
    hideLayer('reportSheet');
    repTarget = null;
    api.toast('已提交举报，管理员会看到');
  }
  function repItemHTML(r) {
    var snap = r.snap || {};
    var st = r.status === 'open' ? '待处理' : (r.status === 'removed' ? '已删帖' : '已保留');
    var img = snap.img ? '<img class="rp-card-img" src="' + esc(api.imgSrc ? api.imgSrc(snap.img) : snap.img) + '" alt="">' : '';
    var txt = snap.text ? '<div class="rp-card-text">' + esc(snap.text) + '</div>' : (snap.img ? '' : '<div class="rp-card-text">（内容已删）</div>');
    var head = '<div class="rp-card-head"><div><div class="rp-card-name">' + esc(r.targetName || '某人') +
      '<span class="rp-badge">' + esc(st) + '</span></div>' +
      '<div class="rp-card-meta">举报人：' + esc(r.reporterName || '某人') + ' · ' + esc(timeAgo(r.ts)) + '</div></div></div>';
    var reason = '<div class="rp-card-meta">理由：' + esc(r.reason || '') + '</div>';
    var acts = '';
    if (r.status === 'open') {
      acts = '<textarea class="rp-reason" data-rp-why="' + esc(r.id) + '" maxlength="200" placeholder="处理理由（会原样发给举报人和被举报人）"></textarea>' +
        '<div class="rp-acts">' +
          '<button class="flat" type="button" data-rp-keep="' + esc(r.id) + '">保留</button>' +
          '<button class="primary" type="button" data-rp-remove="' + esc(r.id) + '">删除动态</button>' +
        '</div>';
    } else {
      acts = '<div class="rp-card-meta">处理：' + esc(r.handleReason || '') + '</div>';
    }
    return '<div class="rp-card-item" data-rp-id="' + esc(r.id) + '">' + head + reason + txt + img + acts + '</div>';
  }
  var reportMode = 'dev';
  function renderReports(list, mode) {
    var box = el('reportList');
    if (!box) return;
    if (mode) reportMode = mode;
    var arr;
    if (reportMode === 'mine') { if (list) myReports = list; arr = myReports; }
    else { if (list) reports = list; arr = reports; }
    if (!arr.length) {
      box.innerHTML = '<p class="hint">' + (reportMode === 'mine' ? '你还没举报过什么。' : '还没有人举报。广场挺干净。') + '</p>';
      return;
    }
    box.innerHTML = arr.map(repItemHTML).join('');
  }
  var reports = [];
  function actReport(id, remove) {
    var why = document.querySelector('[data-rp-why="' + id + '"]');
    var reason = ((why && why.value) || '').trim();
    if (!reason) { api.toast('写一句处理理由，双方都会收到'); return; }
    if (!api.send({ t: 'report_act', rid: id, remove: !!remove, reason: reason.slice(0, 200) })) { api.toast('没连上服务器'); return; }
    api.toast(remove ? '已删帖，理由已发出' : '已保留，理由已发给举报人');
  }
  function bindReport() {
    var sh = el('reportSheet');
    if (sh && !sh.__repBound) {
      sh.__repBound = true;
      var sc = sh.querySelector('.action-scrim');
      if (sc) sc.addEventListener('click', function () { hideLayer('reportSheet'); });
      var cc = el('reportCancel');
      if (cc) cc.addEventListener('click', function () { hideLayer('reportSheet'); repTarget = null; });
      var sd = el('reportSend');
      if (sd) sd.addEventListener('click', sendReport);
    }
    var list = el('reportList');
    if (list && !list.__repBound) {
      list.__repBound = true;
      list.addEventListener('click', function (e) {
        var t = e.target;
        var rm = t.closest('[data-rp-remove]');
        if (rm) { actReport(rm.getAttribute('data-rp-remove'), true); return; }
        var kp = t.closest('[data-rp-keep]');
        if (kp) { actReport(kp.getAttribute('data-rp-keep'), false); return; }
      });
    }
  }

  /* ---------------- 人设广场 ---------------- */
  var cards = [];        // 新 → 旧
  var cardsMore = false;
  var cardsLoading = false;
  var cardsLoaded = false;
  var ftab = 'mom';

  function cardItemHTML(c) {
    var isPng = (c.ext || '') === 'png';
    var meta = (c.kind === 'pack' ? '人设包' : (isPng ? '图卡 PNG' : '人设卡 JSON')) +
      ' · ' + (c.size ? Math.max(1, Math.round(c.size / 1024)) + 'KB' : '?') +
      ' · 下载 ' + (c.dl || 0);
    return '<div class="feed-card" data-card-id="' + esc(c.id) + '">' +
      '<div class="feed-card-title">' + esc(c.title || '未命名人设') + '</div>' +
      '<div class="feed-card-note">' + (c.note ? esc(c.note) : '作者没写说明') + '</div>' +
      '<div class="feed-card-foot"><span>' + esc(c.name || '某人') + ' · ' + esc(timeAgo(c.ts)) + '</span>' +
        '<span class="rp-badge">' + esc(meta) + '</span>' +
        '<button class="flat" type="button" data-card-dl="' + esc(c.id) + '">下载</button>' +
      '</div></div>';
  }
  function renderCards() {
    var box = el('cardList');
    if (!box) return;
    var emp = el('cardEmpty');
    if (!cards.length) {
      box.innerHTML = '';
      if (emp) emp.style.display = cardsLoaded ? '' : 'none';
      return;
    }
    if (emp) emp.style.display = 'none';
    box.innerHTML = cards.map(cardItemHTML).join('') +
      (cardsMore ? '<button class="mo-more" type="button" id="cardMore">加载更早的</button>'
                 : (cards.length >= 12 ? '<p class="hint mo-end">没有更早的了</p>' : ''));
    var b = el('cardMore');
    if (b) b.addEventListener('click', function () { loadCards(true); });
  }
  function loadCards(more) {
    if (cardsLoading) return;
    cardsLoading = true;
    var before = 0;
    if (more && cards.length) before = cards[cards.length - 1].ts;
    if (!more) cards = [];
    if (!api.send({ t: 'card_list', before: before, limit: 12 })) { cardsLoading = false; api.toast('没连上服务器'); }
  }
  function switchTab(tab) {
    ftab = tab === 'card' ? 'card' : 'mom';
    var tabs = document.querySelectorAll('.feed-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-ftab') === ftab);
    }
    var fl = el('feedList'), cl = el('cardList'), fe = el('feedEmpty'), ce = el('cardEmpty');
    if (fl) fl.classList.toggle('hidden', ftab !== 'mom');
    if (cl) cl.classList.toggle('hidden', ftab !== 'card');
    if (fe && ftab !== 'mom') fe.style.display = 'none';
    if (ce && ftab !== 'card') ce.style.display = 'none';
    var fab = el('feedFab');
    if (fab) {
      fab.textContent = ftab === 'card' ? '＋' : '✏';
      fab.classList.toggle('card-mode', ftab === 'card');   // m3e 皮肤下图标是 CSS mask,靠这个换图标
      fab.setAttribute('aria-label', ftab === 'card' ? '分享人设' : '发动态');
    }
    if (ftab === 'card') {
      if (!cardsLoaded) { loadCards(false); cardsLoaded = true; }
      else renderCards();
    } else if (!items.length) load(false);
    else render();
  }
  function openShareCard() {
    var sel = el('cardPick');
    if (!sel) return;
    var list = (w.RP && w.RP.cards) ? w.RP.cards() : [];
    if (!list.length) { api.toast('还没有人设卡，先去「扮演」建一张'); return; }
    sel.innerHTML = list.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name || '未命名') + '</option>';
    }).join('');
    var t = el('cardTitle');
    if (t) t.value = list[0].name || '';
    var nt = el('cardNote');
    if (nt) nt.value = '';
    showLayer('cardSheet');
  }
  function shareCard() {
    var sel = el('cardPick');
    var id = sel && sel.value;
    var list = (w.RP && w.RP.cards) ? w.RP.cards() : [];
    var card = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) card = list[i];
    if (!card) { api.toast('选一张卡'); return; }
    if (!w.EX || !w.EX.card || !w.EX.text) { api.toast('卡模块没加载'); return; }
    var title = ((el('cardTitle') || {}).value || '').trim() || card.name || '未命名人设';
    var note = ((el('cardNote') || {}).value || '').trim();
    var obj, text;
    try { obj = w.EX.card(card, false); text = w.EX.text(obj); } catch (e) { api.toast('导出失败:' + e.message); return; }
    var b64 = utf8ToB64(text);
    if (b64.length > 700 * 1024) { api.toast('这张卡太大了，先精简一下'); return; }
    if (!api.send({ t: 'card_post', kind: 'card', title: title, note: note, ext: 'json', data: b64 })) { api.toast('没连上服务器'); return; }
    hideLayer('cardSheet');
    api.toast('正在上传…');
  }
  function saveCard(item, b64) {
    var nm = 'zy_' + (item.title || 'card').replace(/[\\/:*?"<>|]/g, '_') + '.' + (item.ext || 'json');
    var PN = w.PaperNative;
    if (PN && PN.exportBytes) PN.exportBytes(nm, b64, (item.ext === 'png') ? 'image/png' : 'application/json');
    else api.toast('这个版本不支持保存文件');
  }
  function gotCard(d) {
    var item = d.item || {};
    saveCard(item, d.data);
    // 人设卡(JSON)顺手导进「我的」,省得再手动导入一次
    if (item.kind === 'card' && (item.ext || 'json') === 'json' && w.EX && w.EX.parse && w.EX.import) {
      try {
        var pz = w.EX.parse(b64ToUtf8(d.data));
        var res = w.EX.import(pz, 'new');
        if (res && res.ok) {
          api.toast((res.cards || 0) > 0
            ? ('已保存到下载，并导入 ' + res.cards + ' 张卡')
            : '已保存到下载（这张卡你本来就有）');
        } else api.toast('已保存到下载（导入失败：' + ((res && res.err) || '格式不对') + '）');
      } catch (e) { api.toast('已保存到下载'); }
    } else {
      api.toast('已保存到 Download/DSH-Go/纸鸢备份');
    }
  }
  function bindCards() {
    var tabs = document.querySelectorAll('.feed-tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].__ftBound) continue;
      tabs[i].__ftBound = true;
      tabs[i].addEventListener('click', function (e) {
        e.preventDefault();
        switchTab(this.getAttribute('data-ftab'));
      });
    }
    var cl = el('cardList');
    if (cl && !cl.__cardBound) {
      cl.__cardBound = true;
      cl.addEventListener('click', function (e) {
        var b = e.target.closest('[data-card-dl]');
        if (!b) return;
        if (!api.send({ t: 'card_get', id: b.getAttribute('data-card-dl') })) api.toast('没连上服务器');
        else api.toast('正在下载…');
      });
    }
    var sh = el('cardSheet');
    if (sh && !sh.__cardSheetBound) {
      sh.__cardSheetBound = true;
      var sc = sh.querySelector('.action-scrim');
      if (sc) sc.addEventListener('click', function () { hideLayer('cardSheet'); });
      var cc = el('cardCancel');
      if (cc) cc.addEventListener('click', function () { hideLayer('cardSheet'); });
      var ok = el('cardShare');
      if (ok) ok.addEventListener('click', shareCard);
      var pick = el('cardPick');
      if (pick) pick.addEventListener('change', function () {
        var list = (w.RP && w.RP.cards) ? w.RP.cards() : [];
        for (var j = 0; j < list.length; j++) {
          if (list[j].id === pick.value) { var t2 = el('cardTitle'); if (t2) t2.value = list[j].name || ''; break; }
        }
      });
    }
  }

  /* ---------------- 对外接口 ---------------- */
  MOM.init = function (hooks) {
    api = hooks || {};
    myUid = Number(api.myUid && api.myUid()) || 0;
    bind();
    setBadge(0);
  };
  MOM.openReports = function () { if (api.send) api.send({ t: 'report_list' }); };
  MOM.openMine = function () {
    if (api.send) api.send({ t: 'report_mine' });
    renderReports(myReports, 'mine');
  };
  MOM.myReports = function () { return myReports; };
  MOM.renderReports = renderReports;
  MOM.openShareCard = openShareCard;
  MOM.setTab = switchTab;
  MOM.open = function () {
    opened = true;
    setBadge(0);
    bindReport();
    bindCards();
    if (ftab === 'card') { if (!cardsLoaded) { loadCards(false); cardsLoaded = true; } else renderCards(); return; }
    if (!items.length) load(false);
    else render();
  };
  MOM.close = function () { opened = false; };
  MOM.setUid = function (u) { myUid = Number(u) || 0; };
  var recv = {};
  MOM.onMessage = function (d) {
    if (!d) return;
    recv[d.t] = (recv[d.t] || 0) + 1;
    if (d.t === 'moment_list') {
      loading = false;
      var list = d.items || [];
      if (d.before === 0 || !items.length) items = list;
      else {
        for (var i = 0; i < list.length; i++) if (!upsert(list[i])) items.push(list[i]);
      }
      more = !!d.more;
      clearTimeout(retryTimer);
      if (opened) render();
      return;
    }
    if (d.t === 'moment_new') {
      if (!d.item) return;
      if (!upsert(d.item)) items.unshift(d.item);
      else items.sort(function (a, b) { return b.ts - a.ts; });
      if (opened) { render(); setBadge(0); } else setBadge(unread + 1);
      return;
    }
    if (d.t === 'moment_like') {
      for (var j = 0; j < items.length; j++) {
        if (items[j].id === d.id) { items[j].likes = d.likes || []; break; }
      }
      if (opened) render();
      return;
    }
    if (d.t === 'moment_comment') {
      for (var k = 0; k < items.length; k++) {
        if (items[k].id === d.id) {
          items[k].comments = (items[k].comments || []).concat([d.comment]);
          break;
        }
      }
      if (opened) render();
      return;
    }
    if (d.t === 'moment_cmt_del') {
      for (var q = 0; q < items.length; q++) {
        if (items[q].id !== d.id) continue;
        var gone = d.gone || [d.cid];
        items[q].comments = (items[q].comments || []).filter(function (c) { return gone.indexOf(String(c.id)) < 0; });
        break;
      }
      if (opened) render();
      return;
    }
    if (d.t === 'moment_del') {
      items = items.filter(function (m) { return m.id !== d.id; });
      if (opened) render();
      return;
    }
    if (d.t === 'report_result') {
      if (d.ok === false) api.toast(d.err || '举报没成功');
      else if (d.dup) api.toast('这条你已经举报过了，等管理员处理');
      return;
    }
    if (d.t === 'report_notice') {
      api.toast(d.text || '举报有结果了');
      return;
    }
    if (d.t === 'report_new') {
      if (d.item) {
        var at = -1;
        for (var ri = 0; ri < reports.length; ri++) if (reports[ri].id === d.item.id) { at = ri; break; }
        if (at < 0) reports.unshift(d.item); else reports[at] = d.item;
        renderReports();
      }
      api.toast('有人举报了一条动态');
      return;
    }
    if (d.t === 'report_done') {
      if (d.item) {
        var at2 = -1;
        for (var rj = 0; rj < reports.length; rj++) if (reports[rj].id === d.item.id) { at2 = rj; break; }
        if (at2 < 0) reports.unshift(d.item); else reports[at2] = d.item;
        renderReports();
      }
      return;
    }
    if (d.t === 'report_list') { renderReports(d.items || []); return; }
    if (d.t === 'report_mine') {
      myReports = d.items || [];
      if (reportMode === 'mine') renderReports(myReports, 'mine');
      var notes = d.notices || [];
      for (var ni = 0; ni < notes.length; ni++) { try { api.notify && api.notify('举报结果', notes[ni].text || ''); } catch (e) {} }
      if (notes.length) api.toast(notes[notes.length - 1].text || '');
      return;
    }
    if (d.t === 'card_list') {
      cardsLoading = false;
      cardsLoaded = true;
      var cl = d.items || [];
      if (d.before === 0 || !cards.length) cards = cl;
      else {
        for (var ci = 0; ci < cl.length; ci++) {
          var dup = false;
          for (var cj = 0; cj < cards.length; cj++) if (cards[cj].id === cl[ci].id) { dup = true; break; }
          if (!dup) cards.push(cl[ci]);
        }
      }
      cardsMore = !!d.more;
      if (opened && ftab === 'card') renderCards();
      return;
    }
    if (d.t === 'card_new') {
      if (!d.item) return;
      var had = false;
      for (var ck = 0; ck < cards.length; ck++) if (cards[ck].id === d.item.id) { cards[ck] = d.item; had = true; break; }
      if (!had) cards.unshift(d.item);
      if (opened && ftab === 'card') renderCards();
      return;
    }
    if (d.t === 'card_del') {
      cards = cards.filter(function (c) { return c.id !== d.id; });
      if (opened && ftab === 'card') renderCards();
      return;
    }
    if (d.t === 'card_posted') { api.toast('已分享到人设广场'); return; }
    if (d.t === 'card_result') {
      if (d.ok === false) api.toast(d.err || '操作没成功');
      return;
    }
    if (d.t === 'card_one') {
      if (!d.ok) { api.toast(d.err || '下载失败'); return; }
      gotCard(d);
      return;
    }
  };
  MOM.debug = function () { return { uid: uidNow(), n: items.length, unread: unread, more: more, loading: loading, recv: recv, ftab: ftab, cards: cards.length, reports: reports.length, mine: myReports.length }; };
  MOM.onWsOpen = function () { items = []; more = false; loading = false; };

  w.MOM = MOM;
})(window);