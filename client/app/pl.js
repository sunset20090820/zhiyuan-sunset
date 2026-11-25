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
      html: function (s) { host.innerHTML = s; return host; }
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
  function confirmBox(text, onOk) {
    var old = document.getElementById('modConfirm');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var box = document.createElement('div');
    box.id = 'modConfirm';
    box.className = 'mod-confirm';
    box.innerHTML = '<div class="mod-confirm-card">' +
      '<div class="mod-confirm-text">' + esc(text).replace(/\n/g, '<br>') + '</div>' +
      '<div class="mod-confirm-ops">' +
        '<button class="flat" type="button" data-mc-cancel>取消</button>' +
        '<button class="primary" type="button" data-mc-ok>确定</button>' +
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
          '<span class="mod-ver">v' + esc(m.ver || '1.0') + '</span></div>' +
        '<div class="mod-desc">' + esc(m.desc || '没有写简介') + '</div>' +
        '<div class="mod-meta">' + esc(m.author || '匿名') + ' · ' + esc((m.perms || []).join('/') || '无权限') +
          (m.size ? ' · ' + Math.round(m.size / 1024) + 'KB' : '') + '</div>' +
      '</div>' +
      '<div class="mod-ops">' +
        (got ? '<button class="mod-btn on" data-mod-open="' + esc(m.id) + '">打开</button>'
             : '<button class="mod-btn" data-mod-install="' + esc(m.id) + '">安装</button>') +
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
        '<div class="mod-name">' + esc(m.name || m.id) + '<span class="mod-ver">v' + esc(m.ver || '1.0') + '</span></div>' +
        '<div class="mod-desc">' + esc(m.desc || '没有写简介') + '</div>' +
        '<div class="mod-meta">' + esc(m.author || '匿名') + ' · ' + esc((m.perms || []).join('/') || '无权限') + '</div>' +
      '</div>' +
      '<div class="mod-ops">' +
        '<button class="mod-btn on" data-mod-open="' + esc(m.id) + '">打开</button>' +
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
    PL._open = true;
    p.classList.remove('hidden');
    if (!booted) booted = true;
    // 先让页面出来，再画画：这样即使列表渲染慢，也不会出现「点了没反应」
    setTimeout(function () {
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

  /* ---------------- 上传 ---------------- */
  function openUpload() {
    var box = $('#modUpload');
    if (!box) return;
    box.classList.remove('hidden');
    var m = $('#modUpManifest');
    if (m && !m.value) {
      m.value = JSON.stringify({
        id: 'my_module', name: '我的模块', ver: '1.0', desc: '做什么用的，一句话',
        author: '', perms: ['store'], icon: '🧩'
      }, null, 2);
    }
  }
  function closeUpload() { var box = $('#modUpload'); if (box) box.classList.add('hidden'); }
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
      var perms = man.perms || [];
      var msg = '安装「' + (man.name || man.id) + '」？' +
        (perms.length ? '\n它要用：' + perms.join(' / ') + '\n模块代码会跑在你手机上，只装你信任的。' : '');
      (api.confirmBox || confirmBox)(msg, function () {
        doInstall(man, code);
        api.toast('已安装，去「模块」里打开');
      });
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
        var ins = t.closest('[data-mod-install]');
        if (ins) { PL.install(ins.getAttribute('data-mod-install')); return; }
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
        if (e.target.closest('#modUpCancel')) { closeUpload(); return; }
        if (e.target.closest('#modUpSend')) { submitUpload(); return; }
      });
    }
    render();
  };

  PL.debug = function () {
    return { n: Object.keys(installed).length, ids: Object.keys(installed), market: market.length, running: current, tab: tab };
  };

  w.PL = PL;
})(window);