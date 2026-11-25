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
    if (fab) fab.addEventListener('click', openSheet);
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

  /* ---------------- 对外接口 ---------------- */
  MOM.init = function (hooks) {
    api = hooks || {};
    myUid = Number(api.myUid && api.myUid()) || 0;
    bind();
    setBadge(0);
  };
  MOM.open = function () {
    opened = true;
    setBadge(0);
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
  };
  MOM.debug = function () { return { uid: uidNow(), n: items.length, unread: unread, more: more, loading: loading, recv: recv }; };
  MOM.onWsOpen = function () { items = []; more = false; loading = false; };

  w.MOM = MOM;
})(window);