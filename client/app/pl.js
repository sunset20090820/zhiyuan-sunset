/* 纸鸢 模块运行时（PL）
   模块 = manifest + client.js。client.js 里定义：
     function mount(ctx) { … }            // 必选：往 ctx.el 里画界面
     function onMessage(d, ctx) { … }     // 可选：收到 mod.* 消息
     function unmount(ctx) { … }          // 可选：卸载/离开时收尾
   宿主只通过 ctx 给能力，模块拿不到 window 之外的东西（也拦不住，所以安装时把权限讲清楚）。
   模块代码可能存在本地（pl.mod.<id>.*），也可能从服务器市场下载。 */
(function (w) {
  'use strict';

  var PL = {};
  var api = {};                 // 宿主 hooks
  var installed = {};           // id -> { manifest, code }
  var running = {};             // id -> { mod, ctx }
  var market = [];              // 市场列表
  var tab = 'mine';             // mine | market
  var current = '';             // 正在运行的模块 id
  var booted = false;

  var KEY_INDEX = 'pl.modules.v1';
  var KEY_STEP = 'pl.lastStep';
  // 记下正在做的动作：万一整机卡死，重启后还能看到「最后一步」是哪个
  function step(n) {
    try { localStorage.setItem(KEY_STEP, String(n).slice(0, 40)); } catch (e) {}
    var box = $('#modLastStep');
    if (box) box.textContent = '上次操作：' + String(n).slice(0, 40);
  }
  PL.step = step;
  PL.lastStep = function () { try { return localStorage.getItem(KEY_STEP) || ''; } catch (e) { return ''; } };
  var KEY_CODE = 'pl.mod.';     // + id + '.code'

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(sel) { return document.querySelector(sel); }
  function nowMs() { return Date.now(); }

  /* ---------------- 本地已安装 ---------------- */
  function loadInstalled() {
    var raw = '';
    try { raw = localStorage.getItem(KEY_INDEX) || ''; } catch (e) { raw = ''; }
    if (!raw) { installed = {}; return; }
    try {
      var idx = JSON.parse(raw);
      if (!idx || typeof idx !== 'object') { installed = {}; return; }
      installed = {};
      Object.keys(idx).forEach(function (id) {
        var man = idx[id];
        if (!man || !man.id) return;
        var code = '';
        try { code = localStorage.getItem(KEY_CODE + id + '.code') || ''; } catch (e) { code = ''; }
        if (!code) return;
        installed[id] = { manifest: man, code: code };
      });
    } catch (e) { installed = {}; }
  }
  function saveInstalled() {
    var idx = {};
    Object.keys(installed).forEach(function (id) { idx[id] = installed[id].manifest; });
    try { localStorage.setItem(KEY_INDEX, JSON.stringify(idx)); } catch (e) {}
  }
  function saveCode(id, code) {
    try { localStorage.setItem(KEY_CODE + id + '.code', code); } catch (e) {}
  }
  function dropCode(id) {
    try { localStorage.removeItem(KEY_CODE + id + '.code'); } catch (e) {}
    try {
      var k = 'pl.mod.' + id + '.';
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var key = localStorage.key(i);
        if (key && key.indexOf(k) === 0) localStorage.removeItem(key);
      }
    } catch (e) {}
  }

  /* ---------------- 模块 ctx ---------------- */
  function makeCtx(id, man, host) {
    var ctx = {
      id: id,
      manifest: man,
      version: (api.version && api.version()) || 0,
      el: host,
      send: function (obj) { return api.send(obj); },
      toast: function (m) { return api.toast(m); },
      me: function () { return api.me ? api.me() : { uid: 0, nick: '' }; },
      imgSrc: function (v) { return api.imgSrc ? api.imgSrc(v) : v; },
      viewImage: function (v) { if (api.viewImage) api.viewImage(v); },
      confirmTap: function (key) { return api.confirmTap ? api.confirmTap(key) : true; },
      notify: function (title, text) { if (api.notify) api.notify(title, text); },
      setTitle: function (t) { var h = $('#modRunTitle'); if (h) h.textContent = String(t || man.name || '模块'); },
      local: {
        get: function (k, def) {
          try {
            var v = localStorage.getItem('pl.mod.' + id + '.' + k);
            return v === null ? def : JSON.parse(v);
          } catch (e) { return def; }
        },
        set: function (k, v) {
          try { localStorage.setItem('pl.mod.' + id + '.' + k, JSON.stringify(v)); return true; }
          catch (e) { return false; }
        },
        del: function (k) { try { localStorage.removeItem('pl.mod.' + id + '.' + k); } catch (e) {} }
      },
      // 服务器上的模块存储（按用户隔离，每模块 200 键 / 64KB）
      store: {
        get: function (k, cb) { PL._want = { id: id, key: String(k || ''), cb: cb }; api.send({ t: 'mod_kv_get', id: id, key: String(k || '') }); },
        set: function (k, v, cb) { PL._wantSet = { id: id, key: String(k || ''), cb: cb }; api.send({ t: 'mod_kv_set', id: id, key: String(k || ''), value: v }); },
        del: function (k, cb) { PL._wantSet = { id: id, key: String(k || ''), cb: cb }; api.send({ t: 'mod_kv_set', id: id, key: String(k || ''), value: null }); }
      },
      // 发一条能到服务端并被所有装了同模块的人收到的消息
      broadcast: function (body) { return api.send({ t: 'mod_relay', mod: id, body: body || {} }); },
      on: function (fn) { ctx.__onMsg = fn; },
      html: function (s) { host.innerHTML = s; return host; },
      // 抓网页（走原生 HTTP，绕开 WebView 的跨域/编码问题）
      http: {
        get: function (url, opts, cb) {
          if (typeof opts === 'function') { cb = opts; opts = {}; }
          if (api.http) api.http(url, opts || {}, cb);
          else if (cb) cb(0, '', '宿主没有提供网络能力');
        }
      }
    };
    return ctx;
  }

  /* ---------------- 运行 / 停止 ---------------- */
  function stop(id) {
    var r = running[id];
    if (!r) return;
    try { if (r.mod && typeof r.mod.unmount === 'function') r.mod.unmount(r.ctx); } catch (e) {}
    running[id] = null;
    delete running[id];
  }

  function runModule(id) {
    var rec = installed[id];
    if (!rec) { api.toast('这个模块还没装'); return false; }
    var body = $('#modRunBody');
    if (!body) return false;
    stop(id);
    $('#modRunTitle').textContent = rec.manifest.name || id;
    body.innerHTML = '<div class="mod-loading">正在启动…</div>';
    var host = document.createElement('div');
    host.className = 'mod-host';
    body.innerHTML = '';
    body.appendChild(host);
    var ctx = makeCtx(id, rec.manifest, host);
    var mod = null;
    try {
      // 模块代码在受限函数体里跑：拿得到 ctx，拿不到宿主的局部变量
      var factory = new Function('ctx', 'PL', rec.code + '\n' +
        ';return { mount: (typeof mount === "function" ? mount : null), ' +
        'onMessage: (typeof onMessage === "function" ? onMessage : null), ' +
        'unmount: (typeof unmount === "function" ? unmount : null) };');
      mod = factory.call(null, ctx, PL);
    } catch (e) {
      body.innerHTML = '<div class="mod-error">模块启动失败：' + esc(e && e.message) + '</div>';
      api.toast('模块出错：' + (e && e.message));
      return false;
    }
    if (!mod || typeof mod.mount !== 'function') {
      body.innerHTML = '<div class="mod-error">这个模块没写 mount(ctx)</div>';
      return false;
    }
    running[id] = { mod: mod, ctx: ctx };
    step('模块已启动 ' + id);
    ctx.__onMsg = mod.onMessage || null;
    try { mod.mount(ctx); } catch (e) {
      body.innerHTML = '<div class="mod-error">模块出错：' + esc(e && e.message) + '</div>';
      return false;
    }
    current = id;
    return true;
  }

  /* ---------------- 安装 / 卸载 ---------------- */
  function doInstall(man, code) {
    installed[man.id] = { manifest: man, code: code };
    saveInstalled();
    saveCode(man.id, code);
    render();
  }
  PL.install = function (id, cb) {
    if (!api.send({ t: 'mod_get', id: id })) { api.toast('没连上服务器'); return; }
    PL._installing = { id: id, cb: cb };
  };
  PL.uninstall = function (id, cb) {
    if (!installed[id]) return;
    stop(id);
    delete installed[id];
    saveInstalled();
    dropCode(id);
    render();
    if (cb) cb();
  };
  PL.has = function (id) { return !!installed[id]; };
  PL.list = function () { return Object.keys(installed).map(function (k) { return installed[k].manifest; }); };

  /* ---------------- 自带确认框 ---------------- */
  function confirmBox(text, onOk, okText) {
    var old = document.getElementById('modConfirm');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var box = document.createElement('div');
    box.id = 'modConfirm';
    box.className = 'mod-confirm';
    box.innerHTML = '<div class="mod-confirm-card">' +
      '<div class="mod-confirm-text">' + esc(text).replace(/\n/g, '<br>') + '</div>' +
      '<div class="mod-confirm-ops">' +
        '<button class="flat" type="button" data-mc-cancel>取消</button>' +
        '<button class="primary" type="button" data-mc-ok>' + esc(okText || '确定') + '</button>' +
      '</div></div>';
    document.body.appendChild(box);
    function done(ok) {
      if (box.parentNode) box.parentNode.removeChild(box);
      if (ok && onOk) { try { onOk(); } catch (e) { api.toast('出错了：' + (e && e.message)); } }
    }
    box.addEventListener('click', function (e) {
      if (e.target === box || e.target.closest('[data-mc-cancel]')) { done(false); return; }
      if (e.target.closest('[data-mc-ok]')) done(true);
    });
    return true;
  }
  api.confirmBox = confirmBox;

  /* ---------------- 界面 ---------------- */
  /* 版本号比较：1.2 > 1.10 这类按段比数字,非数字段按字典序兜底 */
  function cmpVer(a, b) {
    var pa = String(a == null ? '' : a).split(/[.\-_+\s]+/).filter(Boolean);
    var pb = String(b == null ? '' : b).split(/[.\-_+\s]+/).filter(Boolean);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] === undefined ? '0' : pa[i], y = pb[i] === undefined ? '0' : pb[i];
      var nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
      if (nx && ny) {
        var d = parseInt(x, 10) - parseInt(y, 10);
        if (d) return d > 0 ? 1 : -1;
      } else if (x !== y) {
        return x > y ? 1 : -1;
      }
    }
    return 0;
  }
  /* 已装模块的更新信息：市场里有更新版就返回那条 */
  function updateOf(id) {
    var rec = installed[id];
    if (!rec) return null;
    for (var i = 0; i < market.length; i++) {
      if (market[i] && market[i].id === id) {
        return cmpVer(market[i].ver, rec.manifest.ver) > 0 ? market[i] : null;
      }
    }
    return null;
  }
  PL.cmpVer = cmpVer;

  function statusText(m) {
    if (m.official) return '官方';
    if (m.status === 'pending') return '待审核';
    if (m.status === 'approved') return '';
    return '';
  }

  function marketCard(m) {
    var got = PL.has(m.id);
    var st = statusText(m);
    return '<li class="mod-item" data-mod-id="' + esc(m.id) + '">' +
      '<div class="mod-ico">' + esc(m.icon || String(m.name || '?').slice(0, 1)) + '</div>' +
      '<div class="mod-info">' +
        '<div class="mod-name">' + esc(m.name || m.id) +
          (st ? '<span class="mod-badge">' + esc(st) + '</span>' : '') +
          '<span class="mod-ver">v' + esc(m.ver || '1.0') + '</span>' +
          (got && updateOf(m.id) ? '<span class="mod-badge new">有新版</span>' : '') + '</div>' +
        '<div class="mod-desc">' + esc(m.desc || '没有写简介') + '</div>' +
        '<div class="mod-meta">' + esc(m.author || '匿名') + ' · ' + esc((m.perms || []).join('/') || '无权限') +
          (m.size ? ' · ' + Math.round(m.size / 1024) + 'KB' : '') + '</div>' +
      '</div>' +
      '<div class="mod-ops">' +
        (got ? '<button class="mod-btn on" data-mod-open="' + esc(m.id) + '">打开</button>'
             : '<button class="mod-btn" data-mod-install="' + esc(m.id) + '">安装</button>') +
        (got && updateOf(m.id) ? '<button class="mod-btn upd" data-mod-update="' + esc(m.id) + '">更新</button>' : '') +
        (got ? '<button class="mod-btn ghost" data-mod-remove="' + esc(m.id) + '">卸载</button>' : '') +
        (api.isDev && api.isDev() ? '<button class="mod-btn ghost" data-mod-review="' + esc(m.id) + '">审核</button>' : '') +
      '</div></li>';
  }

  function myCard(id) {
    var rec = installed[id];
    var m = rec.manifest;
    return '<li class="mod-item" data-mod-id="' + esc(m.id) + '">' +
      '<div class="mod-ico">' + esc(m.icon || String(m.name || '?').slice(0, 1)) + '</div>' +
      '<div class="mod-info">' +
        '<div class="mod-name">' + esc(m.name || m.id) + '<span class="mod-ver">v' + esc(m.ver || '1.0') + '</span>' +
          (updateOf(m.id) ? '<span class="mod-badge new">v' + esc(updateOf(m.id).ver) + ' 可更新</span>' : '') + '</div>' +
        '<div class="mod-desc">' + esc(m.desc || '没有写简介') + '</div>' +
        '<div class="mod-meta">' + esc(m.author || '匿名') + ' · ' + esc((m.perms || []).join('/') || '无权限') + '</div>' +
      '</div>' +
      '<div class="mod-ops">' +
        '<button class="mod-btn on" data-mod-open="' + esc(m.id) + '">打开</button>' +
        (updateOf(m.id) ? '<button class="mod-btn upd" data-mod-update="' + esc(m.id) + '">更新</button>' : '') +
        '<button class="mod-btn ghost" data-mod-remove="' + esc(m.id) + '">卸载</button>' +
      '</div></li>';
  }

  function render() {
    var box = $('#modList');
    if (!box) return;
    var tabs = $('#modTabs');
    if (tabs) {
      Array.prototype.forEach.call(tabs.querySelectorAll('[data-mod-tab]'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-mod-tab') === tab);
      });
    }
    var items = [];
    if (tab === 'mine') {
      // 为了在「我的模块」里标出「有新版」，市场列表没拉过就悄悄拉一次（不打扰）
      if (!market.length && !PL._loading && PL._open) { try { PL.loadMarket(); } catch (e) {} }
      var ids = Object.keys(installed);
      items = ids.map(myCard);
      if (!items.length) {
        box.innerHTML = '<div class="mod-empty">还没装模块。去「模块市场」看看，或者把模块文件放进手机里导入。</div>';
        return;
      }
      box.innerHTML = '<ul class="mod-list">' + items.join('') + '</ul>';
      return;
    }
    if (!market.length) {
      box.innerHTML = '<div class="mod-empty">' + (PL._loading ? '正在获取模块列表…' : '市场里还没有模块') +
        '</div><div class="mod-empty-ops"><button class="mod-btn" type="button" data-mod-retry>重新获取</button></div>';
      return;
    }
    box.innerHTML = '<ul class="mod-list">' + market.map(marketCard).join('') + '</ul>';
  }

  function openPage() {
    var p = $('#modPage');
    if (!p) return;
    step('打开模块页');
    PL._open = true;
    p.classList.remove('hidden');
    if (!booted) booted = true;
    // 先让页面出来，再画画：这样即使列表渲染慢，也不会出现「点了没反应」
    setTimeout(function () {
      step('渲染模块列表');
      try { render(); } catch (e) {}
      if (tab === 'market' && !market.length) PL.loadMarket();
    }, 0);
  }
  function closePage() {
    var p = $('#modPage');
    if (!p) return;
    PL._open = false;
    try { closeRun(); } catch (e) {}
    p.classList.add('hidden');
  }
  function actuallyRun(id) {
    step('运行模块 ' + id);
    var rec = installed[id];
    if (!rec) { api.toast('这个模块还没装'); return; }
    $('#modRun').classList.remove('hidden');
    $('#modRunTitle').textContent = rec.manifest.name || id;
    runModule(id);
  }
  function openRun(id) {
    var rec = installed[id];
    if (!rec) { api.toast('这个模块还没装'); return; }
    var perms = rec.manifest.perms || [];
    var seen = false;
    try { seen = localStorage.getItem('pl.mod.' + id + '.permok') === '1'; } catch (e) { seen = false; }
    if (perms.length && !seen) {
      (api.confirmBox || confirmBox)('「' + (rec.manifest.name || id) + '」要用：' + perms.join(' / ') +
        '\n\n模块代码在你手机上运行，只能装你信任的模块。继续打开？', function () {
          try { localStorage.setItem('pl.mod.' + id + '.permok', '1'); } catch (e) {}
          actuallyRun(id);
        });
      return;
    }
    actuallyRun(id);
  }
  function closeRun() {
    if (current) stop(current);
    current = '';
    var r = $('#modRun');
    if (r) r.classList.add('hidden');
  }

  PL.loadMarket = function () {
    step('请求模块市场');
    PL._loading = true;
    render();
    if (!api.send({ t: 'mod_index' })) { PL._loading = false; api.toast('没连上服务器'); render(); }
  };

  PL.openUpload = openUpload;
  PL.open = openPage;
  PL.close = closePage;
  PL.openRun = openRun;
  PL.closeRun = closeRun;
  PL.setTab = function (t) { tab = t; if (t === 'market') PL.loadMarket(); else render(); };

  /* ---------------- 模块包：内置 ZIP 读取（无依赖） ----------------
     目标：像装插件一样，直接选一个 .zip（manifest.json + client.js）就能装，
     不再让人手粘 JSON 和代码。Android WebView 里没有 Node 的 zlib，
     所以这里自带一个 RFC1951 的 inflate（只支持 store / fixed / dynamic 三种块）。 */
  var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DEXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function BitReader(data, pos) { this.d = data; this.p = pos || 0; this.b = 0; this.n = 0; }
  BitReader.prototype.bit = function () {
    if (!this.n) { this.b = this.d[this.p++] || 0; this.n = 8; }
    var v = this.b & 1; this.b >>= 1; this.n--; return v;
  };
  BitReader.prototype.bits = function (k) {
    var v = 0;
    for (var i = 0; i < k; i++) v |= this.bit() << i;
    return v;
  };
  BitReader.prototype.align = function () { this.b = 0; this.n = 0; };

  function buildHuff(lengths) {
    var count = [], sym = [], i;
    for (i = 0; i < 16; i++) count[i] = 0;
    for (i = 0; i < lengths.length; i++) count[lengths[i]]++;
    count[0] = 0;
    var offs = [], total = 0;
    for (i = 1; i < 16; i++) { offs[i] = total; total += count[i]; }
    for (i = 0; i < lengths.length; i++) if (lengths[i]) sym[offs[lengths[i]]++] = i;
    return { count: count, symbol: sym };
  }
  function decodeSym(br, h) {
    var code = 0, first = 0, index = 0;
    for (var len = 1; len <= 15; len++) {
      code |= br.bit();
      var c = h.count[len];
      if (code - first < c) return h.symbol[index + (code - first)];
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    throw new Error('inflate: 无效的哈夫曼码');
  }
  function fixedTables() {
    var ll = [], dd = [], i;
    for (i = 0; i < 144; i++) ll[i] = 8;
    for (; i < 256; i++) ll[i] = 9;
    for (; i < 280; i++) ll[i] = 7;
    for (; i < 288; i++) ll[i] = 8;
    for (i = 0; i < 30; i++) dd[i] = 5;
    return { lit: buildHuff(ll), dist: buildHuff(dd) };
  }
  /* 解压一段 raw deflate，输出长度已知（uncompressed size） */
  function inflateRaw(src, outLen) {
    var out = new Uint8Array(outLen || 0), op = 0;
    var br = new BitReader(src, 0), fixed = null;
    function put(b) { if (op >= out.length) { var n2 = new Uint8Array(Math.max(64, out.length * 2 + (op - out.length + 32))); n2.set(out); out = n2; } out[op++] = b; }
    var last = 0;
    while (!last) {
      last = br.bit();
      var type = br.bits(2);
      if (type === 0) {                       // stored
        br.align();
        var len = src[br.p] | (src[br.p + 1] << 8);
        var nlen = src[br.p + 2] | (src[br.p + 3] << 8);
        br.p += 4;
        if ((len ^ 0xffff) !== nlen) throw new Error('inflate: stored 长度校验失败');
        for (var i0 = 0; i0 < len; i0++) put(src[br.p++]);
        continue;
      }
      var lit, dist;
      if (type === 1) { if (!fixed) fixed = fixedTables(); lit = fixed.lit; dist = fixed.dist; }
      else if (type === 2) {
        var hlit = br.bits(5) + 257, hdist = br.bits(5) + 1, hclen = br.bits(4) + 4;
        var clen = [], k;
        for (k = 0; k < 19; k++) clen[k] = 0;
        for (k = 0; k < hclen; k++) clen[CORDER[k]] = br.bits(3);
        var ch = buildHuff(clen), lens = [];
        var total = hlit + hdist;
        for (k = 0; k < total;) {
          var sym = decodeSym(br, ch);
          if (sym < 16) { lens[k++] = sym; continue; }
          var rep = 0, val = 0;
          if (sym === 16) { if (!k) throw new Error('inflate: 重复码前面没有值'); val = lens[k - 1]; rep = 3 + br.bits(2); }
          else if (sym === 17) { rep = 3 + br.bits(3); }
          else { rep = 11 + br.bits(7); }
          while (rep--) lens[k++] = val;
        }
        var ll = lens.slice(0, hlit), dd = lens.slice(hlit, hlit + hdist);
        lit = buildHuff(ll); dist = buildHuff(dd);
      } else throw new Error('inflate: 块类型 3');

      for (;;) {
        var s = decodeSym(br, lit);
        if (s === 256) break;
        if (s < 256) { put(s); continue; }
        s -= 257;
        var L = LBASE[s] + br.bits(LEXTRA[s]);
        var ds = decodeSym(br, dist);
        var D = DBASE[ds] + br.bits(DEXTRA[ds]);
        for (var j = 0; j < L; j++) put(out[op - D]);
      }
    }
    return op === out.length ? out : out.subarray(0, op);
  }

  function u16(b, i) { return b[i] | (b[i + 1] << 8); }
  function u32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

  /* 读 zip：返回 { name: string/Uint8Array } */
  function unzip(buf) {
    var b = new Uint8Array(buf), i;
    // End of central directory
    var eocd = -1;
    for (i = b.length - 22; i >= 0 && i > b.length - 66000; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是 zip 文件（找不到中央目录）');
    var count = u16(b, eocd + 10), cdOff = u32(b, eocd + 16);
    var out = {}, p = cdOff;
    for (var n = 0; n < count; n++) {
      if (u32(b, p) !== 0x02014b50) break;
      var method = u16(b, p + 10);
      var csize = u32(b, p + 20), usize = u32(b, p + 24);
      var fnLen = u16(b, p + 28), exLen = u16(b, p + 30), cmLen = u16(b, p + 32);
      var lho = u32(b, p + 42);
      var name = '';
      for (var c = 0; c < fnLen; c++) name += String.fromCharCode(b[p + 46 + c]);
      // 有些 zip 用 UTF-8 名字：按 UTF-8 解一遍
      try {
        var bytes = b.subarray(p + 46, p + 46 + fnLen);
        name = decodeURIComponent(bytes.reduce(function (acc, x) { return acc + '%' + ('0' + x.toString(16)).slice(-2); }, ''));
      } catch (e) {}
      p += 46 + fnLen + exLen + cmLen;
      if (/\/$/.test(name)) continue;                        // 目录
      if (u32(b, lho) !== 0x04034b50) continue;
      var lfn = u16(b, lho + 26), lex = u16(b, lho + 28);
      var dataOff = lho + 30 + lfn + lex;
      var data = b.subarray(dataOff, dataOff + csize);
      var raw;
      if (method === 0) raw = data;
      else if (method === 8) raw = inflateRaw(data, usize);
      else throw new Error('不支持的压缩方式 ' + method);
      out[name] = raw;
    }
    return out;
  }
  function bytesToText(u8) {
    try { return new TextDecoder('utf-8').decode(u8); } catch (e) {}
    var s2 = '';
    for (var i = 0; i < u8.length; i++) s2 += String.fromCharCode(u8[i]);
    try { return decodeURIComponent(escape(s2)); } catch (e2) { return s2; }
  }
  /* 在 zip 里找 manifest.json / client.js（允许包一层目录） */
  function pickModuleFiles(files) {
    var man = null, code = null, k;
    for (k in files) {
      if (!files.hasOwnProperty(k)) continue;
      if (/(^|\/)manifest\.json$/i.test(k)) man = k;
      else if (/(^|\/)client\.js$/i.test(k)) code = k;
    }
    if (!man || !code) return null;
    return {
      manifest: bytesToText(files[man]),
      code: bytesToText(files[code])
    };
  }

  PL.installFromFile = function (f) { return readPkgFile(f); };
  PL.unzip = unzip;
  PL.pickModuleFiles = pickModuleFiles;
  PL.inflateRaw = inflateRaw;

  /* ---------------- 从文件安装模块包 ---------------- */
  function pkgMsg(t) {
    var el = $('#modPkgMsg');
    if (el) el.textContent = String(t || '');
  }
  function normManifest(man) {
    if (!man || typeof man !== 'object') return null;
    var id = String(man.id || '').trim();
    if (!/^[a-z0-9][a-z0-9_.-]{1,39}$/i.test(id)) return { err: 'manifest 里的 id 不合法（2-40 位字母数字，可带 . _ -）' };
    var out = {
      id: id, name: String(man.name || id).slice(0, 40), ver: String(man.ver || '1.0').slice(0, 20),
      desc: String(man.desc || '').slice(0, 200), author: String(man.author || '').slice(0, 40),
      icon: String(man.icon || '🧩').slice(0, 4),
      perms: (Array.isArray(man.perms) ? man.perms : []).map(function (x) { return String(x).slice(0, 20); }).slice(0, 8),
      minApp: parseInt(man.minApp, 10) || 0
    };
    return { manifest: out };
  }
  function installPackage(text, code) {
    var parsed = normManifest(text);
    if (parsed && parsed.err) { pkgMsg(parsed.err); api.toast(parsed.err); return; }
    var man = parsed.manifest;
    if (!/function\s+mount\s*\(/.test(code)) {
      pkgMsg('client.js 里找不到 function mount(ctx)，装的会是个打不开的模块');
      api.toast('模块代码不完整');
      return;
    }
    var need = man.minApp || 0, have = (api.version && api.version()) || 0;
    if (need && have && need > have) { api.toast('这个模块要 App ' + need + ' 以上'); return; }
    var perms = man.perms || [];
    (api.confirmBox || confirmBox)('装「' + man.name + '」？' +
      (perms.length ? '\n它要用：' + perms.join(' / ') : '') +
      '\n模块代码会跑在你手机上，只装你信得过的包。', function () {
      doInstall(man, code);
      pkgMsg('已安装：' + man.name + '（v' + man.ver + '）');
      api.toast('装好了，去「我的模块」里打开');
      try { PL.setTab('mine'); } catch (e) {}
    });
  }
  function readPkgFile(file) {
    if (!file) return;
    pkgMsg('正在读取 ' + file.name + '…');
    var fr = new FileReader();
    fr.onerror = function () { pkgMsg('读不了这个文件'); };
    fr.onload = function () {
      try {
        var name = String(file.name || '').toLowerCase();
        if (/\.json$/.test(name)) {
          // 也接受单个 json：{manifest:{...}, code:"..."} 或 {id,name,code}
          var o = JSON.parse(String(fr.result));
          if (o && o.code) {
            var man = o.manifest || o;
            installPackage(man, String(o.code));
            return;
          }
          pkgMsg('这个 JSON 里没有 code 字段');
          return;
        }
        var files = unzip(fr.result);
        var picked = pickModuleFiles(files);
        if (!picked) { pkgMsg('包里没找到 manifest.json / client.js'); return; }
        var manText = null;
        try { manText = JSON.parse(picked.manifest); } catch (e) { pkgMsg('manifest.json 不是合法 JSON'); return; }
        installPackage(manText, picked.code);
      } catch (err) {
        pkgMsg('安装失败：' + (err && err.message || err));
      }
    };
    if (/\.json$/.test(String(file.name || '').toLowerCase())) fr.readAsText(file);
    else fr.readAsArrayBuffer(file);
  }

  /* ---------------- 上传 ---------------- */
  function openUpload() {
    var box = $('#modUpload');
    if (!box) return;
    step('打开上传面板');
    box.classList.remove('hidden');
    requestAnimationFrame(function () { box.classList.add('open'); });
    var m = $('#modUpManifest');
    if (m && !m.value) {
      m.value = JSON.stringify({
        id: 'my_module', name: '我的模块', ver: '1.0', desc: '做什么用的，一句话',
        author: '', perms: ['store'], icon: '🧩'
      }, null, 2);
    }
  }
  function closeUpload() {
    var box = $('#modUpload');
    if (!box) return;
    box.classList.remove('open');
    setTimeout(function () { box.classList.add('hidden'); }, 220);
  }
  function submitUpload() {
    var manTxt = ($('#modUpManifest') || {}).value || '';
    var code = ($('#modUpCode') || {}).value || '';
    var man = null;
    try { man = JSON.parse(manTxt); } catch (e) { api.toast('模块描述不是合法 JSON'); return; }
    if (!code.trim()) { api.toast('把 client.js 的内容粘进来'); return; }
    if (!api.send({ t: 'mod_upload', manifest: man, code: code })) { api.toast('没连上服务器'); return; }
    api.toast(api.isDev && api.isDev() ? '正在上传…' : '已提交，等开发者审核');
  }

  /* ---------------- 消息 ---------------- */
  PL.onMessage = function (d) {
    if (!d) return;
    if (d.t === 'mod_index') {
      step('收到模块列表');
      PL._loading = false;
      market = d.items || [];
      render();
      return;
    }
    if (d.t === 'mod_get') {
      var man = d.manifest || {};
      var code = String(d.code || '');
      if (!man.id || !code) { api.toast('模块内容为空'); return; }
      var need = parseInt(man.minApp, 10) || 0;
      var have = (api.version && api.version()) || 0;
      if (need && have && need > have) {
        api.toast('这个模块要 App ' + need + ' 以上，先更新');
        return;
      }
      var prev = installed[man.id];
      var perms = man.perms || [];
      var msg, okText;
      if (prev) {
        var from = prev.manifest.ver || '1.0', to = man.ver || '1.0';
        var c = cmpVer(to, from);
        if (c > 0) { msg = '把「' + (man.name || man.id) + '」从 v' + from + ' 更新到 v' + to + '？'; okText = '更新'; }
        else if (c < 0) { msg = '服务器上的版本(v' + to + ')比本地(v' + from + ')旧，要降级吗？'; okText = '降级'; }
        else { msg = '「' + (man.name || man.id) + '」已经是最新的 v' + to + '，重新装一遍？'; okText = '重装'; }
        if (perms.length) msg += '\n它要用：' + perms.join(' / ');
      } else {
        msg = '安装「' + (man.name || man.id) + '」？' +
          (perms.length ? '\n它要用：' + perms.join(' / ') + '\n模块代码会跑在你手机上，只装你信任的。' : '');
        okText = '安装';
      }
      (api.confirmBox || confirmBox)(msg, function () {
        var wasRunning = !!running[man.id];
        doInstall(man, code);
        if (wasRunning) { try { stop(man.id); runModule(man.id); } catch (e) {} }
        api.toast(prev ? ('已更新到 v' + (man.ver || '1.0')) : '已安装，去「模块」里打开');
      }, okText);
      return;
    }
    if (d.t === 'mod_upload_ok') {
      api.toast(d.status === 'approved' ? '已上架' : '已提交，等开发者审核');
      closeUpload();
      PL.loadMarket();
      return;
    }
    if (d.t === 'mod_review_ok') {
      api.toast(d.ok ? '已通过' : '已下架');
      PL.loadMarket();
      return;
    }
    if (d.t === 'mod_del_ok') { api.toast('模块已删除'); PL.loadMarket(); return; }
    if (d.t === 'mod_kv') {
      var want = PL._want;
      PL._want = null;
      if (want && want.id === d.id && want.cb) want.cb(d.value, d.keys);
      return;
    }
    if (d.t === 'mod_kv_ok') {
      var ws = PL._wantSet;
      PL._wantSet = null;
      if (ws && ws.cb) ws.cb(true);
      return;
    }
    if (d.t === 'mod_push') {
      var r = running[d.mod];
      if (r && r.ctx && typeof r.ctx.__onMsg === 'function') {
        try { r.ctx.__onMsg(d, r.ctx); } catch (e) { api.toast('模块出错：' + (e && e.message)); }
      }
      // 模块卸载后也把消息发给「已安装但没运行」的模块？不做，避免后台乱跑
      return;
    }
  };

  /* ---------------- 兜底退出 ---------------- */
  // 不依赖 init 是否成功：模块页/运行页的返回键永远有效，退出时把底栏还原
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (!t.closest('#modBack') && !t.closest('#modRunBack')) return;
    try { closeRun(); } catch (x) {}
    try { closePage(); } catch (x) {}
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var run = $('#modRun'), page = $('#modPage');
    var open = (run && !run.classList.contains('hidden')) || (page && !page.classList.contains('hidden'));
    if (!open) return;
    try { closeRun(); } catch (x) {}
    try { closePage(); } catch (x) {}
  }, true);

  /* ---------------- 初始化 ---------------- */
  PL.init = function (hooks) {
    api = hooks || {};
    api.confirmBox = api.confirmBox || confirmBox;
    try {
      initUi();
    } catch (e) {
      PL.initError = String((e && e.message) || e);
      var box = $('#modList');
      if (box) box.innerHTML = '<div class="mod-error">模块页初始化失败：' + esc(PL.initError) + '</div>';
    }
  };

  function initUi() {
    loadInstalled();
    var page = $('#modPage');
    if (page && !page.__modBound) {
      page.__modBound = true;
      page.addEventListener('click', function (e) {
        var t = e.target;
        if (t.closest('[data-mod-tab]')) { PL.setTab(t.closest('[data-mod-tab]').getAttribute('data-mod-tab')); return; }
        if (t.closest('#modBack')) { closePage(); return; }
        if (t.closest('#modRefresh') || t.closest('[data-mod-retry]')) { PL.loadMarket(); return; }
        if (t.closest('#modUploadBtn')) { openUpload(); return; }
        var op = t.closest('[data-mod-open]');
        if (op) { openRun(op.getAttribute('data-mod-open')); return; }
        var ins = t.closest('[data-mod-install]') || t.closest('[data-mod-update]');
        if (ins) {
          var mid = ins.getAttribute('data-mod-install') || ins.getAttribute('data-mod-update');
          step((t.closest('[data-mod-update]') ? '更新模块 ' : '安装模块 ') + mid);
          PL.install(mid);
          return;
        }
        var rem = t.closest('[data-mod-remove]');
        if (rem) {
          var id = rem.getAttribute('data-mod-remove');
          api.confirmBox('卸载「' + ((installed[id] || { manifest: {} }).manifest.name || id) + '」？本地数据也会清掉。', function () {
            PL.uninstall(id);
            api.toast('已卸载');
          });
          return;
        }
        var rev = t.closest('[data-mod-review]');
        if (rev) {
          var rid = rev.getAttribute('data-mod-review');
          api.confirmBox('审核通过这个模块？', function () {
            api.send({ t: 'mod_review', id: rid, ok: true });
          });
          return;
        }
      });
    }
    var run = $('#modRun');
    if (run && !run.__modBound) {
      run.__modBound = true;
      run.addEventListener('click', function (e) {
        if (e.target.closest('#modRunBack')) closeRun();
      });
    }
    var up = $('#modUpload');
    if (up && !up.__modBound) {
      up.__modBound = true;
      up.addEventListener('click', function (e) {
        if (e.target.closest('.action-scrim')) { closeUpload(); return; }
        if (e.target.closest('#modUpCancel')) { closeUpload(); return; }
        if (e.target.closest('#modUpSend')) { submitUpload(); return; }
        if (e.target.closest('#modPickPkg')) {
          var inp = $('#modPkgInput');
          if (inp) { inp.value = ''; inp.click(); }
          return;
        }
      });
    }
    var pkgIn = $('#modPkgInput');
    if (pkgIn && !pkgIn.__pkgBound) {
      pkgIn.__pkgBound = true;
      pkgIn.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (f) readPkgFile(f);
      });
    }
    render();
  };

  PL.debug = function () {
    return { n: Object.keys(installed).length, ids: Object.keys(installed), market: market.length, running: current, tab: tab };
  };

  w.PL = PL;
})(window);