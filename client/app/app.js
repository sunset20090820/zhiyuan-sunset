/* 纸鸢 · 轻量聊天前端
   一个文件搞定：连接、渲染、本地记录。没有框架，没有依赖。 */
(function () {
  'use strict';

  var LOCAL_RID = 'dm:local';
  var LOCAL_PEER = 'local';
  var AI_RID = 'dm:ai';
  var lastSendPath = '';
  var AI_PEER = 'ai';
  var ROOMS_DEFAULT = [
    { id: 'lobby', name: '公共大厅', emoji: '💬', color: '#3390ec' },
    { id: 'tech',  name: '技术交流', emoji: '🛠', color: '#4caf50' },
    { id: 'fun',   name: '摸鱼水区', emoji: '🐟', color: '#ff9f0a' }
  ];
  var STORE = 'paperlite.v1';
  var HIST_MAX = 300;

  /* ---------------- 多服务器：本地数据按服务器隔离 ---------------- */
  var CUR_SRV_KEY = 'pl.curServer';
  var CFG = window.ZY_CONFIG || {};
  // 更新源：留空 = 不检查更新（自建服务器可以自己配）
  var OFFICIAL_SERVER = String(CFG.updateServer || '').replace(/\/+$/, '');
  var srvTag = 'default';
  function srvTagOf(server) {
    var t = String(server || '').replace(/^wss?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    if (!t) return 'default';
    var h = 5381;
    for (var i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
    return 's' + h.toString(36);
  }
  function LK(name) { return 'pl.' + srvTag + '.' + name; }
  function setCurrentServer(s) {
    var before = srvTag;
    try { localStorage.setItem(CUR_SRV_KEY, s || ''); } catch (e) {}
    srvTag = srvTagOf(s);
    if (before !== srvTag) { try { S.msgs = {}; } catch (e) {} }   // 前缀变了，缓存作废
  }
  function currentServer() {
    try { return localStorage.getItem(CUR_SRV_KEY) || ''; } catch (e) { return ''; }
  }
  function migrateLegacy() {
    try {
      if (localStorage.getItem(LK('v1'))) return;
      var old = localStorage.getItem(STORE);
      if (!old) return;
      var o = {};
      try { o = JSON.parse(old) || {}; } catch (e) { o = {}; }
      if (o.server && srvTagOf(o.server) !== srvTag) setCurrentServer(o.server);
      localStorage.setItem(LK('v1'), old);
      var dms = localStorage.getItem('paperlite.dms');   // 注意：这里读的是旧版全局键
      if (dms && !localStorage.getItem(LK('dms'))) localStorage.setItem(LK('dms'), dms);
      var rm = localStorage.getItem('paperlite.remarks');
      if (rm && !localStorage.getItem(LK('remarks'))) localStorage.setItem(LK('remarks'), rm);
      var moved = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('paperlite.hist.') === 0) moved.push(k);
      }
      moved.forEach(function (k) {
        var nk = LK('hist.' + k.slice('paperlite.hist.'.length));
        if (!localStorage.getItem(nk)) localStorage.setItem(nk, localStorage.getItem(k));
      });
    } catch (e) {}
  }

  var S = {
    nick: '', server: '', me: '',
    rooms: ROOMS_DEFAULT.slice(),
    online: {}, members: [], last: {}, unread: {},
    cur: null, msgs: {}, deviceId: '', user: '', auth: false, remarks: {}, people: [], dms: {}, stickers: [], groups: {}, pendingAuth: null,
    uid: 0, token: '', friends: [], pendingIn: [], pendingOut: [], searchHit: null, tab: 'chats', mutes: {},
    localAgent: { on: false, port: 6721, lan: false, clients: 0, error: '', name: '本地用户', avatar: '' },
    ai: { on: false, base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', name: 'AI 助手', models: [], effort: 'low' },
    unreadAt: {}, mentionAt: {}, jumpTarget: null, avatars: {}, myAvatar: '', pins: {}, agentUser: { on: false, user: '', pass: '', nick: '', avatar: '', ready: false, error: '', port: 6722, lan: false, clients: 0, last: '' },
    bg: { scope: 'chat',
          chat: { key: 'mist', image: '', dim: 0.18, blur: 0, imageDark: false },
          list: { key: 'none', image: '', dim: 0.12, blur: 0, imageDark: false } },
    glass: true, glassLevel: 55, accent: 'periwinkle', topbarText: 'auto', skin: 'm3e'
  };
  /* 备注：只改自己看到的称呼，存本地 */
  function loadRemarks() {
    try { S.remarks = JSON.parse(localStorage.getItem(LK('remarks')) || '{}') || {}; } catch (e) { S.remarks = {}; }
  }
  function saveRemarks() {
    try { localStorage.setItem(LK('remarks'), JSON.stringify(S.remarks)); } catch (e) {}
  }
  function nameOf(id, fallback) {
    return S.remarks[id] || fallback || '匿名';
  }
  function getDeviceId() {
    try {
      var saved = localStorage.getItem('paperlite.deviceId');
      if (saved && /^[a-f0-9]{32}$/.test(saved)) return saved;
      var bytes = new Uint8Array(16);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
      else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      var id = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      localStorage.setItem('paperlite.deviceId', id);
      return id;
    } catch (e) { return 'd' + Date.now().toString(16) + Math.random().toString(16).slice(2, 21); }
  }
  S.deviceId = getDeviceId();
  var authTimer = null, ws = null, retry = 0, retryTimer = null, queue = [], connected = false;
  var HEARTBEAT_MS = 20000, PONG_TIMEOUT = 50000, lastRx = 0, hbTimer = null, staleTries = 0;
  var replyTarget = null, selectedMessage = null, mentionState = null, actionTimer = null;

  function $(sel) { return document.querySelector(sel); }
  // 容错绑定：某个元素不存在也不会中断后面所有按钮的绑定
  function on(sel, ev, fn, capture) {
    var el = typeof sel === 'string' ? $(sel) : sel;
    if (!el) { return null; }
    try { el.addEventListener(ev, fn, capture || false); } catch (e) {}
    return el;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function room(id) {
    for (var i = 0; i < S.rooms.length; i++) if (S.rooms[i].id === id) return S.rooms[i];
    if (id && id.indexOf('g:') === 0) {
      var g = S.groups[id.slice(2)];
      if (g) return { id: id, name: g.name || '群聊', emoji: '👥', color: '#7c5cff' };
    }
    var ks = Object.keys(S.dms);
    for (var j = 0; j < ks.length; j++) {
      if (dmRoomOf(ks[j]) === id) {
        return { id: id, name: nameOf(ks[j], S.dms[ks[j]].name || '私信'), emoji: '👤', color: '#6b7d8f' };
      }
    }
    return { id: id, name: id, emoji: '💬', color: '#3390ec' };
  }
  function sameDay(a, b) {
    var x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }
  function fmtTime(ts) {
    var d = new Date(ts), now = Date.now();
    if (sameDay(ts, now)) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (sameDay(ts, now - 864e5)) return '昨天';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function fmtDay(ts) {
    var d = new Date(ts), now = Date.now();
    if (sameDay(ts, now)) return '今天';
    if (sameDay(ts, now - 864e5)) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /* ---------------- 本地存储 ---------------- */
  // 原生在页面加载完后把镜像状态直接推回来（不依赖桥读取时序）
  window.__nativeRestore = function (json) {
    blog('原生推送恢复: ' + (json ? '有数据' : '空') + (S.auth ? '（已登录，忽略）' : ''));
    if (!json || S.auth) return;
    try {
      var o = JSON.parse(json);
      if (!o || !o.auth) { lastDiag.native = '有镜像但未登录'; return; }
      S.nick = o.nick || S.nick;
      S.server = o.server || S.server;
      S.user = o.user || S.user;
      S.token = o.token || S.token;
      S.uid = Number(o.uid) || S.uid;
      S.last = o.last || {};
      S.unread = o.unread || {};
      S.auth = true;
      setCurrentServer(o.server || S.server || '');
      try { localStorage.setItem(LK('v1'), json); } catch (e) {}
      lastDiag.native = '恢复成功 ' + new Date(o.ts || 0).toLocaleString();
      $('#setup').classList.add('hidden');
      connect();
      toast('已恢复登录状态');
    } catch (e) { lastDiag.native = '解析失败'; }
  };

  // 诊断为「我的」页提供状态：本地 / 原生镜像
  var lastDiag = { local: '-', native: '-', code: '-' };
  var bootLog = [];
  function blog(msg) {
    try {
      bootLog.push(new Date().toLocaleTimeString() + ' ' + msg);
      if (bootLog.length > 12) bootLog.shift();
    } catch (e) {}
  }

  // 原生在 onPause 时要求立刻同步状态
  window.__flushState = function () {
    try { save(); } catch (e) {}
    try {
      if (window.PaperNative && window.PaperNative.saveState) {
        window.PaperNative.saveState(JSON.stringify({
          nick: S.nick, server: S.server, last: S.last, unread: S.unread, user: S.user, auth: S.auth
        }));
      }
    } catch (e) {}
  };

  function save() {
    var payload = { nick: S.nick, server: S.server, last: S.last, unread: S.unread, user: S.user, auth: S.auth, token: S.token, uid: S.uid, avatars: S.avatars, myAvatar: S.myAvatar, pins: S.pins, mutes: S.mutes, localAgent: S.localAgent, ai: S.ai, agentUser: S.agentUser, bg: S.bg, glass: S.glass, glassLevel: S.glassLevel, accent: S.accent, topbarText: S.topbarText, skin: S.skin, cur: S.cur, ts: Date.now(), log: bootLog.slice(-12) };
    try { localStorage.setItem(LK('v1'), JSON.stringify(payload)); } catch (e) {}
    // 原生侧再存一份：进程被杀时 localStorage 可能来不及落盘
    try {
      if (window.PaperNative && window.PaperNative.saveState) {
        window.PaperNative.saveState(JSON.stringify(payload));
      }
    } catch (e) {}
  }
  function load() {
    // 两份状态：localStorage 可能只落盘了登录前的旧值（auth:false），所以要按时间戳取新的
    var raw0 = null;
    try {
      if (window.PaperNative && window.PaperNative.loadState) raw0 = window.PaperNative.loadState() || null;
    } catch (e) {}
    try {
      var raw = localStorage.getItem(LK('v1'));
      if (raw0) {
        var t0 = 0, t1 = 0;
        try { t0 = JSON.parse(raw0).ts || 0; } catch (e) {}
        try { t1 = raw ? (JSON.parse(raw).ts || 0) : 0; } catch (e) {}
        if (!raw || t0 > t1) raw = raw0;
        blog('读取: localStorage t=' + t1 + ' / 镜像 t=' + t0 + '，采用 ' + ((!raw || t0 > t1) ? '镜像' : '本地'));
      }
      if (raw) {
        var o = JSON.parse(raw);
        S.nick = o.nick || '';
        S.server = o.server || '';
        S.user = o.user || '';
        S.token = o.token || '';
        S.uid = Number(o.uid) || 0;
        S.avatars = o.avatars || {};
        S.myAvatar = o.myAvatar || '';
        S.pins = o.pins || {};
        S.mutes = o.mutes || {};
        S.localAgent = Object.assign({ on: false, port: 6721, lan: false, clients: 0, error: '', name: '本地用户', avatar: '' }, o.localAgent || {});
        S.ai = Object.assign({ on: false, base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', name: 'AI 助手', models: [], effort: 'low' }, o.ai || {});
        if (!Array.isArray(S.ai.models)) S.ai.models = [];
        S.agentUser = Object.assign({ on: false, user: '', pass: '', nick: '', avatar: '', ready: false, error: '', port: 6722, lan: false }, o.agentUser || {});
        S.bg = normalizeBg(o.bg);
        if (typeof o.glass === 'boolean') S.glass = o.glass;
        if (typeof o.glassLevel === 'number') S.glassLevel = o.glassLevel;
        if (o.accent) S.accent = o.accent;
        if (o.topbarText) S.topbarText = o.topbarText;
        if (o.skin) S.skin = o.skin;
        S.auth = !!o.auth;
        S.last = o.last || {};
        S.unread = o.unread || {};
        if (o.cur) S.cur = o.cur;
      }
    } catch (e) {}
  }
  function histKey(id) { return LK('hist.' + id); }
  function loadHist(id) {
    if (S.msgs[id] && S.msgs[id].length) return S.msgs[id];   // 只缓存非空的；空的重新读盘
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem(histKey(id)) || '[]') || []; } catch (e) {}
    S.msgs[id] = arr;
    return arr;
  }
  function saveHist(id) {
    try { localStorage.setItem(histKey(id), JSON.stringify(loadHist(id).slice(-HIST_MAX))); } catch (e) {}
  }

  /* ---------------- 消息存储 ---------------- */
  // 自己发的消息：用设备 ID 认领，避免换了连接后把自己的消息当成别人的
  function ownMsg(m) {
    if (!m) return m;
    if (m.deviceId && m.deviceId === S.deviceId) m.from = S.deviceId;
    return m;
  }
  function addMsg(rid, m) {
    ownMsg(m);
    try {
      if (m && m.avatar && m.from) {
        if (!S.avatars) S.avatars = {};
        S.avatars[m.from] = m.avatar;
        if (m.name) S.avatars[m.name] = m.avatar;
        if (m.fromUid) S.avatars['uid:' + m.fromUid] = m.avatar;
        if (S.dms && S.dms[m.from]) S.dms[m.from].avatar = m.avatar;
      }
    } catch (e) {}
    var arr = loadHist(rid);
    if (m.id) {
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id === m.id) {
          var wasLocal = arr[i].from === S.deviceId || arr[i].from === 'me' || arr[i].deviceId === S.deviceId;
          arr[i] = Object.assign({}, arr[i], m);
          if (wasLocal) arr[i].from = S.deviceId;
          saveHist(rid);
          return arr[i];
        }
        if (m.tempId && arr[i].tempId === m.tempId) {          // 自己发的消息回来了
          arr[i] = Object.assign({}, arr[i], m, { from: S.deviceId || m.from, serverFrom: m.from, pending: false });
          saveHist(rid);
          return arr[i];
        }
      }
    }
    arr.push(ownMsg(m));
    if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX);
    saveHist(rid);
    return m;
  }

  /* ---------------- 连接 ---------------- */
  function setConn(on) {
    connected = on;
    var brand = document.querySelector('#chats .brand');
    if (brand) {
      brand.innerHTML = '纸鸢 <span id="connDot" class="dot' + (on ? ' on' : '') + '"></span>' +
        '<span class="conn-txt">' + (on ? '在线' : (S.server ? '连接中…' : '未设置服务器')) + '</span>';
    }
    $('#connDot').classList.toggle('on', on);
    $('#banner').classList.toggle('hidden', on || !S.server);
    if (S.cur) {
      $('#chatSub').textContent = on
        ? (S.online[S.cur] ? S.online[S.cur] + ' 人在线' : '在线')
        : '未连接 · 重试中';
    }
  }
  function startHeartbeat() {
    stopHeartbeat();
    lastRx = Date.now();
    hbTimer = setInterval(function () {
      if (!ws || ws.readyState !== 1) return;
      wsSend({ t: 'ping' });
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  }
  // 看门狗：WebSocket 半开连接不会触发 onclose，只能靠“多久没收到东西”判断
  function watchdog() {
    if (!S.server) return;
    if (!ws || ws.readyState > 1) {
      if (!retryTimer) scheduleRetry();
      return;
    }
    if (ws.readyState === 1 && lastRx && Date.now() - lastRx > PONG_TIMEOUT) {
      staleTries++;
      try { ws.close(); } catch (e) {}
      try { ws = null; } catch (e) {}
      setConn(false);
      if (staleTries > 2) toast('网络不稳，正在重连');
      scheduleRetry();
    }
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (!S.server) return;
    retry = Math.min(retry + 1, 5);
    retryTimer = setTimeout(connect, Math.min(15000, 800 * Math.pow(2, retry - 1)));
  }
  // 给游戏模块用的发送通道
  window.__zySend = function (obj) { return wsSend(obj); };
  var sendLog = [];
  function noteSend(kind, detail, text) {
    try {
      sendLog.push({ kind: kind, detail: detail, text: String(text || '').slice(0, 24), ts: Date.now() });
      if (sendLog.length > 30) sendLog.shift();
    } catch (e) {}
  }

  function wsSend(obj) {
    try {
      if (obj && obj.t === 'msg') noteSend('server', 'room=' + (obj.room || '(空)'), obj.text);
      else if (obj && obj.t === 'pm') noteSend('server', 'pm→' + (obj.to || '(空)'), obj.text);
    } catch (e) {}
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  }
  function connect() {
    if (!S.server) return setConn(false);
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    var sock;
    try { sock = new WebSocket(S.server); } catch (e) { setConn(false); scheduleRetry(); return; }
    ws = sock;   // 旧连接的迟到回调用 !ws===sock 挡掉，避免把新连接清空
    sock.onopen = function () {
      if (ws !== sock) return;
      retry = 0;
      staleTries = 0;
      setConn(true);
      startHeartbeat();
      if (S.pendingAuth) { sendAuth(S.pendingAuth); return; }   // 等验证通过再 join
      checkVersion();                                           // 版本检查与登录状态无关
      // 已登录：先用令牌恢复服务端身份，拿回 uid/好友/私信，否则服务端只当游客
      if (S.auth && S.token) {
        wsSend({ t: 'resume', token: S.token, device: S.deviceId });
        wsSend({ t: 'join', name: S.nick, room: S.cur || 'lobby', device: S.deviceId });
        wsSend({ t: 'groups' });
        wsSend({ t: 'contacts' });
        refreshDMs();
        flushQueue();
        return;
      }
      wsSend({ t: 'join', name: S.nick, room: S.cur || 'lobby', device: S.deviceId });
      wsSend({ t: 'groups' });
      wsSend({ t: 'contacts' });   // 已登录直接连上的情况也要拉好友列表
      checkVersion();
      refreshDMs();
      flushQueue();
    };
    sock.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      lastRx = Date.now();
      onServer(d);
    };
    sock.onclose = function () {
      if (ws !== sock) return;
      stopHeartbeat(); ws = null; setConn(false); scheduleRetry();
    };
    sock.onerror = function () { if (ws !== sock) return; setConn(false); };
  }
  // 认证请求：socket 已经连着时也要能发出去（之前重试会卡在这里）
  function sendAuth(p) {
    if (!p) return false;
    var sent = false;
    if (p.kind === 'login') sent = wsSend({ t: 'login', user: p.user, pass: p.pass, device: S.deviceId });
    else if (p.kind === 'register') sent = wsSend({ t: 'register', user: p.user, pass: p.pass, nick: p.nick, question: p.question, answer: p.answer, device: S.deviceId });
    else if (p.kind === 'resetpass') sent = wsSend({ t: 'resetpass', user: p.user, answer: p.answer, pass: p.pass, device: S.deviceId });
    if (!sent) { connect(); return false; }
    clearTimeout(authTimer);
    authTimer = setTimeout(function () {
      if (S.pendingAuth) {
        S.pendingAuth = null;
        $('#setup').classList.remove('hidden');
        toast('服务器没有响应，请检查地址或稍后重试');
      }
    }, 9000);
    return true;
  }

  function dropFakeQueue() {
    try {
      var before = queue.length;
      for (var i = queue.length - 1; i >= 0; i--) {
        var q = queue[i];
        if (!q) continue;
        var rid = q.room || q.to || '';
        if (rid === AI_RID || rid === LOCAL_RID || rid === AI_PEER || rid === LOCAL_PEER) queue.splice(i, 1);
      }
      if (queue.length !== before) bootLog.push('丢掉 ' + (before - queue.length) + ' 条 AI/本地 残留排队消息');
    } catch (e) {}
  }

  function flushQueue() {
    while (queue.length) {
      var q = queue.shift();
      if (q.pm) {
        if (!wsSend({ t: 'pm', to: q.to, text: q.text, tempId: q.tempId, replyTo: q.replyTo })) { queue.unshift(q); break; }
      } else if (!wsSend(Object.assign({ t: 'msg' }, q))) { queue.unshift(q); break; }
    }
  }

  function onServer(d) {
    if (d.t === 'pong') { lastRx = Date.now(); return; }
    if (d.t === 'blocked') {
      var bu = $('#blockedUsers'), bg = $('#blockedGroups');
      if (bu) {
        bu.innerHTML = (d.users || []).length ? d.users.map(function (u) {
          return '<div class="me-row"><span class="me-ico">🚫</span>' + esc(u.name || ('用户' + u.uid)) +
                 '<button class="mini-btn" type="button" data-unblock="' + esc(u.uid) + '">解除</button></div>';
        }).join('') : '<div class="me-row" style="color:var(--tg-sub)">没有拉黑任何人</div>';
      }
      if (bg) {
        bg.innerHTML = (d.groups || []).length ? d.groups.map(function (g) {
          return '<div class="me-row"><span class="me-ico">👥</span>' + esc(g.name) +
                 '<button class="mini-btn" type="button" data-unblockg="' + esc(g.id) + '">解除</button></div>';
        }).join('') : '<div class="me-row" style="color:var(--tg-sub)">没有拉黑任何群</div>';
      }
      return;
    }
    if (d.t === 'avatar') {
      S.avatars[d.user] = d.avatar;
      if (d.nick) S.avatars[d.nick] = d.avatar;
      if (d.uid) S.avatars['uid:' + d.uid] = d.avatar;
      save();
      if (S.cur) renderMsgs(false);
      renderRooms();
      return;
    }
    if (d.t === 'avatar_ok') {
      S.myAvatar = d.avatar;
      save();
      renderMeAvatar();
      toast('头像已更新');
      return;
    }
    if (typeof d.t === 'string' && d.t.indexOf('ww_') === 0) {
      if (window.WW) { try { window.WW.onMessage(d); } catch (e) {} }
      return;
    }
    if (d.t === 'version_info') {
      if (d.needUpdate) remindUpdate(d);
      else clearUpdateBadge();
      return;
    }
    if (d.t === 'auth' && d.action === 'resume' && !d.ok) {
      blog('令牌恢复失败: ' + (d.err || ''));
      S.auth = false; S.token = '';
      save();
      $('#setup').classList.remove('hidden');
      toast('登录已过期，请重新输入密码');
      return;
    }
    if (d.t === 'auth') {
      S.pendingAuth = null;
      clearTimeout(authTimer);
      var errBox = (S.pendingAuth && S.pendingAuth.kind === 'register') ? $('#regError') : $('#loginError');
      if (!d.ok) {
        var wasKind = S.pendingAuth ? S.pendingAuth.kind : '';
        S.pendingAuth = null;
        $('#setup').classList.remove('hidden');
        var box = wasKind === 'register' ? $('#regError') : $('#loginError');
        if (box) { box.textContent = d.err || '验证失败'; box.classList.remove('hidden'); }
        toast(d.err || '验证失败');
        return;
      }
      if ($('#loginError')) $('#loginError').classList.add('hidden');
      if ($('#regError')) $('#regError').classList.add('hidden');
      S.user = d.user; S.nick = d.nick || d.user; S.auth = true;
      if (d.token) S.token = d.token;
      if (d.uid) { S.uid = Number(d.uid); S.myId = 'uid:' + S.uid; }
      blog('登录成功 ' + S.user + '，令牌 ' + (S.token ? '已保存' : '缺失'));
      if (d.uid) S.uid = Number(d.uid);
      save();
      $('#setup').classList.add('hidden');
      wsSend({ t: 'join', name: S.nick, room: S.cur || 'lobby', device: S.deviceId, account: S.user });
      wsSend({ t: 'contacts' });
      refreshDMs();
      checkVersion();
      flushQueue();
      toast((d.action === 'register' ? '注册成功，' : d.action === 'reset' ? '密码已重置，' : '登录成功，') + '欢迎 ' + S.nick);
      return;
    }
    if (d.t === 'recover') {
      var res = $('#forgotResult');
      if (!d.ok) { if (res) res.textContent = d.err || '找回失败'; toast(d.err || '找回失败'); return; }
      if (res) res.innerHTML = '找回成功：你的用户名是 <b>' + esc(d.user) + '</b><br>密保问题：' + esc(d.question || '') + '<br><small>记下来后回到登录页登录即可。</small>';
      $('#forgotUserWrap').classList.remove('hidden');
      $('#forgotUser').value = d.user;
      $('#forgotMode').value = 'reset';
      $('#forgotNewPassWrap').classList.remove('hidden');
      toast('已找回用户名');
      return;
    }
    if (d.t === 'question') {
      var q = $('#forgotQuestion');
      if (q) q.textContent = '密保问题：' + d.question;
      return;
    }
    if (d.t === 'welcome') {
      S.me = d.you && d.you.id || '';
      if (d.you && d.you.name) S.nick = d.you.name;
      loadHist(d.room || S.cur || 'lobby').forEach(function (m) {
        if (m.deviceId === S.deviceId || m.serverFrom === S.me || (m.from === S.me && m.name === S.nick)) {
          m.from = S.deviceId;
          m.serverFrom = m.serverFrom || S.me;
        }
      });
      if (d.rooms && d.rooms.length) {
        S.rooms = d.rooms.map(function (r) {
          var old = room(r.id);
          return { id: r.id, name: r.name || old.name, emoji: r.emoji || old.emoji, color: old.color };
        });
      }
      if (d.history && d.room) {
        d.history.forEach(function (m) { addMsg(d.room, m); });
      }
      if (d.members && d.room === S.cur) S.members = d.members;
      renderRooms();
      if (S.cur) renderMsgs(true);
      setConn(true);
      return;
    }
    if (d.t === 'msg') {
      var rid = d.msg.room || S.cur;
      addMsg(rid, d.msg);
      if (rid === S.cur) {
        renderMsgs(false);
      } else {
        S.unread[rid] = (S.unread[rid] || 0) + 1;
        markUnread(rid, d.msg);
        notifyMessage(rid, d.msg);
      }
      S.last[rid] = { id: d.msg.id, text: d.msg.text, name: d.msg.name, ts: d.msg.ts, retracted: !!d.msg.retracted };
      save();
      renderRooms();
      return;
    }
    if (d.t === 'retract') {
      var list = loadHist(d.room || S.cur || 'lobby');
      for (var ri = 0; ri < list.length; ri++) {
        if (list[ri].id === d.id) {
          list[ri].text = ''; list[ri].retracted = true; list[ri].replyTo = null; list[ri].mentions = [];
          saveHist(d.room || S.cur || 'lobby');
          break;
        }
      }
      if ((d.room || S.cur) === S.cur) renderMsgs(false);
      if (S.last[d.room] && S.last[d.room].id === d.id) { S.last[d.room].retracted = true; S.last[d.room].text = ''; }
      renderRooms(); return;
    }
    if (d.t === 'members') {
      if (d.room === S.cur) { S.members = d.members || []; renderMentionBox(); }
      learnAvatars(d.members);
      return;
    }
    if (d.t === 'people') { S.people = d.list || []; learnAvatars(S.people); return; }
    if (d.t === 'uid') { S.uid = d.uid || 0; if (S.tab === 'me') fillMe(); return; }
    if (d.t === 'contacts') {
      S.friends = d.friends || [];
      learnAvatars(S.friends);
      try { (S.friends || []).forEach(function (f) { if (f.avatar) S.avatars['uid:' + f.uid] = f.avatar; }); } catch (e) {}
      S.pendingIn = d.pendingIn || d.pending_in || [];
      S.pendingOut = d.pendingOut || d.pending_out || [];
      if (d.uid) S.uid = d.uid;
      checkFriendRequests(S.pendingIn);
      renderContacts();
      return;
    }
    if (d.t === 'contact_result') {
      clearTimeout(window.__searchTimer);
      S.searchHit = d.found ? d : null;
      showSearchResult(d.found ? d : null, d.uid);
      return;
    }
    if (d.t === 'contact_event') {
      toast(d.message || '好友状态有更新');
      wsSend({ t: 'contacts' });
      return;
    }
    if (d.t === 'groups') { mergeGroups(d.groups); return; }
    if (d.t === 'group_kicked') {
      delete S.groups[d.gid];
      if (S.cur === 'g:' + d.gid) { closeRoom(); }
      renderRooms();
      toast('你已被移出该群');
      return;
    }
    if (d.t === 'group_created') {
      mergeGroups([d.group]);
      openGroup(d.group.id);
      return;
    }
    if (d.t === 'group_update') {
      if (d.group) {
        if (d.group.members && d.group.members.indexOf(S.deviceId) < 0) delete S.groups[d.group.id];
        else S.groups[d.group.id] = d.group;
        renderRooms();
        if (S.cur === 'g:' + d.group.id) $('#chatSub').textContent = d.group.members.length + ' 人';
        if (gpGid && gpGid === d.group.id && window.__gpOpen && window.__gpOpen()) openGroupPanel(d.group.id);
      }
      return;
    }
    if (d.t === 'group_history') {
      var gid2 = d.group && d.group.id;
      if (gid2) {
        S.groups[gid2] = d.group;
        var rid2 = 'g:' + gid2;
        (d.history || []).forEach(function (m) { addMsg(rid2, m); });
        if (S.cur === rid2) {
          $('#chatName').textContent = d.group.name;
          $('#chatSub').textContent = d.group.members.length + ' 人';
          renderMsgs(true);
        }
        renderRooms();
      }
      return;
    }
    if (d.t === 'group_msg') {
      var gid3 = d.gid;
      var rid3 = 'g:' + gid3;
      addMsg(rid3, d.msg);
      var mine = d.msg.deviceId === S.deviceId;
      S.last[rid3] = { id: d.msg.id, text: d.msg.text, name: mine ? '' : d.msg.name, ts: d.msg.ts };
      if (S.cur !== rid3) S.unread[rid3] = (S.unread[rid3] || 0) + 1;
      save();
      if (S.cur === rid3) renderMsgs(false);
      renderRooms();
      return;
    }
    if (d.t === 'pm_history') {
      var peerId = d.with || '';
      if (peerId === AI_PEER || peerId === LOCAL_PEER || /^dm:(ai|local)(\||$)/.test(String(d.room || ''))) {
        return;      // AI / 本地是本机的，服务端别拿它的私信房间号覆盖我们
      }
      upsertDm(peerId, d.room, d.peer && d.peer.name, d.peer && d.peer.uid, d.peer && d.peer.dev);
      try { localStorage.setItem(LK('dms'), JSON.stringify(S.dms)); } catch (e) {}
      if (S.cur && isDM(S.cur)) S.cur = d.room;
      (d.history || []).forEach(function (m) { addMsg(d.room, m); });
      var hist = d.history || [];
      if (hist.length) {
        var lastM = hist[hist.length - 1];
        if (!S.last[d.room] || (S.last[d.room].ts || 0) < lastM.ts) {
          S.last[d.room] = { id: lastM.id, text: lastM.text, name: lastM.name, ts: lastM.ts };
        }
      }
      if (S.cur === d.room) { S.unread[d.room] = 0; renderMsgs(true); }
      save(); renderRooms();
      return;
    }
    if (d.t === 'pm_saved') {
      if (S.last[d.room]) S.last[d.room].offline = true;
      toast(d.message || '对方不在线，稍后送达');
      return;
    }
    if (d.t === 'pm') {
      try {
        if (d.msg && d.msg.avatar) {
          if (!S.avatars) S.avatars = {};
          if (d.msg.from) S.avatars[d.msg.from] = d.msg.avatar;
          if (d.msg.name) S.avatars[d.msg.name] = d.msg.avatar;
          if (d.msg.fromUid) S.avatars['uid:' + d.msg.fromUid] = d.msg.avatar;
          if (d.with) S.avatars[d.with] = d.msg.avatar;
        }
      } catch (e) {}
      addMsg(d.room, d.msg);
      var mineMsg = d.msg.deviceId === S.deviceId;
      var peerId = mineMsg ? d.with
        : (d.msg.fromUid ? ('uid:' + d.msg.fromUid) : (d.msg.deviceId || d.msg.from));
      // 先统一会话记录：同一会话只留一条，键尽量用账号 ID
      if (peerId) {
        upsertDm(peerId, d.room, d.msg.name, mineMsg ? 0 : d.msg.fromUid, mineMsg ? 0 : d.msg.deviceId);
        try { localStorage.setItem(LK('dms'), JSON.stringify(S.dms)); } catch (e) {}
      }
      if (!isDM(S.cur) || S.cur !== d.room) {
        markUnread(d.room, d.msg);
        notifyMessage(d.room, d.msg);
        S.unread[d.room] = (S.unread[d.room] || 0) + 1;
      }
      S.last[d.room] = { id: d.msg.id, text: d.msg.text, name: d.msg.deviceId === S.deviceId ? '' : d.msg.name, ts: d.msg.ts };
      save(); renderRooms();
      if (S.cur === d.room) renderMsgs(false);
      return;
    }
    if (d.t === 'presence') { S.online[d.room] = d.online; renderRooms(); setConn(connected); return; }
    if (d.t === 'rooms') { renderRooms(); return; }
    if (d.t === 'error' && d.message) toast(d.message);
  }

  /* ---------------- 本地用户（Agent 接入） ---------------- */
  function localAgentOn() { return !!(window.PaperNative && window.PaperNative.agentEnable); }
  function localAgentName() { return (S.localAgent && S.localAgent.name) || '本地用户'; }
  function localAgentAvatar() { return (S.localAgent && S.localAgent.avatar) || ''; }
  // 把名称/头像落到会话列表和头像表里（本地会话，不走服务器）
  function applyAgentProfile() {
    var nm = localAgentName(), av = localAgentAvatar();
    if (S.dms[LOCAL_PEER]) S.dms[LOCAL_PEER].name = nm;
    if (!S.avatars) S.avatars = {};
    if (av) S.avatars[LOCAL_PEER] = av; else delete S.avatars[LOCAL_PEER];
    try { localStorage.setItem(LK('dms'), JSON.stringify(S.dms)); } catch (e) {}
    try { if (window.PaperNative && window.PaperNative.agentName) window.PaperNative.agentName(nm); } catch (e) {}
    renderRooms();
    if (S.cur === LOCAL_RID) { try { renderMsgs(true); } catch (e) {} }
  }
  function ensureLocalConv(on) {
    if (on) {
      if (!S.dms[LOCAL_PEER]) S.dms[LOCAL_PEER] = { name: localAgentName(), roomId: LOCAL_RID, local: true };
      S.dms[LOCAL_PEER].name = localAgentName();
      S.dms[LOCAL_PEER].local = true;
    } else if (S.dms[LOCAL_PEER]) {
      delete S.dms[LOCAL_PEER];
      if (S.cur === LOCAL_RID) { S.cur = null; $('#chat').classList.add('hidden'); }
    }
    try { localStorage.setItem(LK('dms'), JSON.stringify(S.dms)); } catch (e) {}
    renderRooms();
  }
  function agentApply(on, port, lan) {
    if (!localAgentOn()) { toast('这个版本不支持本地用户'); return; }
    S.localAgent.on = !!on;
    S.localAgent.port = Number(port) || 6721;
    S.localAgent.lan = !!lan;
    var nmEl = $('#agentName');
    if (nmEl) S.localAgent.name = (nmEl.value || '').trim().slice(0, 16) || '本地用户';
    save();
    applyAgentProfile();
    try { window.PaperNative.agentEnable(!!on, S.localAgent.port, !!lan); } catch (e) {}
    ensureLocalConv(!!on);
    refreshAgentStatus();
    toast(on ? ('本地用户已开启，端口 ' + S.localAgent.port) : '本地用户已关闭');
  }
  /* ---------------- 自带 AI 助手（填 key 就能聊，和「本地用户」互不影响） ---------------- */
  function aiName() { return (S.ai && S.ai.name) || 'AI 助手'; }
  function aiKeyStore(k, v) {
    // key 优先放原生私有存储（Android SharedPreferences），没桥时退回 localStorage
    try {
      var P = window.PaperNative;
      if (P && P.secretSet && v !== undefined) { P.secretSet('ai_key', v); return; }
      if (P && P.secretGet) { var got = P.secretGet('ai_key'); if (got) return got; }
    } catch (e) {}
    try {
      if (v !== undefined) localStorage.setItem('pl.ai.key', v);
      return localStorage.getItem('pl.ai.key') || '';
    } catch (e) { return ''; }
  }
  /* AI 助手只有一个：清掉重复条目、把 roomId 纠正回 dm:ai、记 ai:true 好识别 */
  /* 三种接入（公共大厅 / 本地用户 / AI 助手）各自只能有一个会话：
     把条目的 roomId 归位到规范 id、重复条目合并、历史记录搬过去、房间列表去重。 */
  function roomExists(rid) {
    if (!rid) return false;
    for (var i = 0; i < (S.rooms || []).length; i++) if (S.rooms[i] && S.rooms[i].id === rid) return true;
    return false;
  }

  function dmRoomOf(peerId) {
    if (peerId === AI_PEER) return AI_RID;
    if (peerId === LOCAL_PEER) return LOCAL_RID;
    var d = (S.dms && S.dms[peerId]) || {};
    return d.roomId || ('dm:' + peerId);
  }
  function migrateHist(from, to) {
    if (!from || !to || from === to) return 0;
    var a = [];
    try { a = loadHist(from) || []; } catch (e) { a = []; }
    if (!a.length) {
      try { localStorage.removeItem(histKey(from)); } catch (e2) {}
      return 0;
    }
    var b = [];
    try { b = loadHist(to) || []; } catch (e) { b = []; }
    var seen = {};
    b.forEach(function (m) { if (m && m.id) seen[m.id] = 1; });
    var moved = 0;
    a.forEach(function (m) {
      if (!m || !m.id || seen[m.id]) return;
      b.push(m); seen[m.id] = 1; moved++;
    });
    if (!moved) { try { localStorage.removeItem(histKey(from)); } catch (e3) {} return 0; }
    b.sort(function (x, y) { return (x.ts || 0) - (y.ts || 0); });
    S.msgs[to] = b;
    try { saveHist(to); } catch (e) {}
    delete S.msgs[from];
    try { localStorage.removeItem(histKey(from)); } catch (e) {}
    try {
      if (!S.last) S.last = {};
      if (!S.last[to] && S.last[from]) { S.last[to] = S.last[from]; delete S.last[from]; }
    } catch (e4) {}
    try {
      if (!S.unread) S.unread = {};
      if (S.unread[from]) { S.unread[to] = (S.unread[to] || 0) + S.unread[from]; delete S.unread[from]; }
    } catch (e5) {}
    try {
      if (!S.pins) S.pins = {};
      if (S.pins[from]) { S.pins[to] = 1; delete S.pins[from]; }
    } catch (e6) {}
    return moved;
  }
  function aiNormalize() {
    if (!S.dms) S.dms = {};
    var changed = false;
    // 1) 条目自愈：roomId 归位、打上身份标记、历史从旧 id 搬过来
    Object.keys(S.dms).forEach(function (peerId) {
      var d = S.dms[peerId];
      if (!d) { delete S.dms[peerId]; changed = true; return; }
      var want = dmRoomOf(peerId);
      var isAi = (peerId === AI_PEER) || d.ai === true;
      var isLocal = (peerId === LOCAL_PEER) || d.local === true && !isAi;
      if (isAi) { want = AI_RID; }
      else if (isLocal) { want = LOCAL_RID; }
      var old = d.roomId;
      // 假条目占了真房间（大厅/群聊）的房间号：它不是会话，直接删掉，否则列表里多一行
      if (!isAi && !isLocal && old && (S.rooms || []).some(function (x) { return x && x.id === old; })) {
        delete S.dms[peerId];
        changed = true;
        return;
      }
      if (old !== want) { d.roomId = want; changed = true; }
      if (isAi && d.ai !== true) { d.ai = true; changed = true; }
      if ((isAi || isLocal) && d.local !== true) { d.local = true; changed = true; }
      if (old && old !== want) {
        // 旧房间号可能正被大厅/群聊占着，只有它不属于真房间时才搬历史
        try {
          var realRoom = (S.rooms || []).some(function (x) { return x && x.id === old; });
          if (!realRoom) migrateHist(old, want);
        } catch (e) {}
      }
    });
    // 2) 同一个 roomId 只留一个条目（优先 AI / 本地 / 有历史的）
    var byRoom = {};
    Object.keys(S.dms).forEach(function (peerId) {
      var rid = dmRoomOf(peerId);
      if (!byRoom[rid]) { byRoom[rid] = peerId; return; }
      var cur = byRoom[rid];
      var score = function (p) { return (p === AI_PEER ? 3 : 0) + (p === LOCAL_PEER ? 2 : 0) + ((S.dms[p].avatar) ? 1 : 0); };
      var loser = score(peerId) > score(cur) ? cur : peerId;
      var win = loser === cur ? peerId : cur;
      byRoom[rid] = win;
      if (!S.dms[win].avatar && S.dms[loser].avatar) S.dms[win].avatar = S.dms[loser].avatar;
      delete S.dms[loser];
      changed = true;
    });
    // 3) AI / 本地：开着就必须恰好各有一条
    if (S.ai && S.ai.on) {
      if (!S.dms[AI_PEER]) { S.dms[AI_PEER] = { name: aiName(), roomId: AI_RID, local: true, ai: true }; changed = true; }
      var aiD = S.dms[AI_PEER];
      var wantAi = { roomId: AI_RID, ai: true, local: true, name: aiName() };
      if (S.ai.avatar) wantAi.avatar = S.ai.avatar;
      Object.keys(wantAi).forEach(function (k) {
        if (aiD[k] !== wantAi[k]) { aiD[k] = wantAi[k]; changed = true; }
      });
      // AI 头像等于你自己的头像 = 之前被污染了，清掉（否则会一直显示你的脸）
      if (S.ai.avatar && (S.ai.avatar === S.myAvatar ||
          (S.avatars && S.nick && S.ai.avatar === S.avatars[S.nick]))) {
        S.ai.avatar = '';
        changed = true;
      }
      // 只认 S.ai.avatar：以前的合并会把它写成别人的头像（用户遇到过"她用的是我的头像"）
      if (S.ai.avatar !== aiD.avatar) {
        if (S.ai.avatar) { aiD.avatar = S.ai.avatar; }
        else { delete aiD.avatar; }
        changed = true;
      }
    }
    if (S.localAgent && S.localAgent.on) {
      if (!S.dms[LOCAL_PEER]) { S.dms[LOCAL_PEER] = { name: localAgentName(), roomId: LOCAL_RID, local: true }; changed = true; }
      else if (S.dms[LOCAL_PEER].roomId !== LOCAL_RID) { S.dms[LOCAL_PEER].roomId = LOCAL_RID; changed = true; }
    }
    // 4) 房间列表按 id 去重（服务器偶尔会重复下发）
    if (S.rooms && S.rooms.length) {
      var seenRoom = {};
      var dedup = [];
      S.rooms.forEach(function (r) {
        if (!r || !r.id || seenRoom[r.id]) { changed = true; return; }
        seenRoom[r.id] = 1; dedup.push(r);
      });
      if (dedup.length !== S.rooms.length) S.rooms = dedup;
    }
    if (changed) {
      try { localStorage.setItem(LK('dms'), JSON.stringify(S.dms)); } catch (e) {}
      try { save(); } catch (e) {}
    }
    return changed;
  }

  function aiIsRoom(rid) {
    if (!rid) return false;
    if (rid === AI_RID) return true;
    if (/^dm:ai(\||$)/.test(rid)) return true;
    if (/^dm:local(\||$)/.test(rid)) return true;
    var d = S.dms && S.dms[AI_PEER];
    return !!(d && d.ai === true && d.roomId === rid);
  }

  function ensureAiConv(on) {
    if (on) {
      aiNormalize();
      if (!S.dms[AI_PEER]) S.dms[AI_PEER] = { name: aiName(), roomId: AI_RID, local: true, ai: true };
      S.dms[AI_PEER].name = aiName();
      S.dms[AI_PEER].local = true;
      S.dms[AI_PEER].ai = true;
      S.dms[AI_PEER].roomId = AI_RID;
      if (S.ai && S.ai.avatar) S.dms[AI_PEER].avatar = S.ai.avatar;
    } else if (S.dms[AI_PEER]) {
      delete S.dms[AI_PEER];
      if (S.cur === AI_RID) { S.cur = null; $('#chat').classList.add('hidden'); showTab(S.tab || 'chats'); }
    }
    try { localStorage.setItem(LK('dms'), JSON.stringify(S.dms)); } catch (e) {}
    renderRooms();
  }
  try { aiNormalize(); } catch (e) {}
  try { dropFakeQueue(); } catch (e) {}
  function aiReady() { return !!(S.ai && S.ai.on && S.ai.base && S.ai.model && aiKeyStore()); }
  function refreshAiStat() {
    var el = $('#aiStat');
    if (!el) return;
    if (!S.ai || !S.ai.on) { el.textContent = '未开启'; return; }
    if (!aiKeyStore()) { el.textContent = '还没填 API key'; return; }
    el.textContent = '已开启 · ' + S.ai.model + ' · ' + (S.ai.base || '').replace(/^https?:\/\//, '');
  }
  /* ---------- 模型列表：向接口地址要 /models，勾选后保存，会话里可切换 ---------- */
  var aiModelFetched = [];       // 这次从接口拿到的全部可选模型
  function aiModelList() {
    var a = S.ai || {};
    if (!Array.isArray(a.models)) a.models = [];
    return a.models;
  }
  function renderAiModelList() {
    var box = $('#aiModelList');
    if (!box) return;
    var picked = aiModelList();
    var cur = (S.ai && S.ai.model) || '';
    var rows = '';
    // 已勾选的排前面，当前模型打勾标记
    var list = aiModelFetched.slice();
    picked.forEach(function (m) { if (list.indexOf(m) < 0) list.push(m); });
    if (!list.length) {
      box.innerHTML = '<p class="ai-model-empty">还没获取过模型列表，点上面的「获取」。</p>';
      var f0 = $('#aiModelFilter');
      if (f0) f0.classList.add('hidden');
      return;
    }
    var fEl = $('#aiModelFilter');
    var q = fEl ? String(fEl.value || '').trim().toLowerCase() : '';
    if (fEl) fEl.classList.toggle('hidden', list.length < 8);
    if (q) list = list.filter(function (m) { return m.toLowerCase().indexOf(q) >= 0; });
    if (!list.length) {
      box.innerHTML = '<p class="ai-model-empty">没有名字里带「' + esc(q) + '」的模型。</p>';
      return;
    }
    list.forEach(function (m) {
      var on = picked.indexOf(m) >= 0;
      var isCur = m === cur;
      rows += '<div class="ai-model-row' + (on ? ' on' : '') + (isCur ? ' cur' : '') + '">' +
                '<button class="ai-model-hit" type="button" data-model="' + esc(m) + '">' +
                  '<span class="ai-model-box">' + (on ? '✓' : '') + '</span>' +
                  '<span class="ai-model-name">' + esc(m) + '</span>' +
                '</button>' +
                (isCur
                  ? '<span class="ai-model-badge">当前</span>'
                  : (on ? '<button class="ai-model-use" type="button" data-cur="' + esc(m) + '">设为当前</button>' : '')) +
              '</div>';
    });
    box.innerHTML = rows;
  }
  /* AI 助手头像：选本地图，裁成方形 256，存成 data URL（只在本机，不上传） */
  function aiPickAvatar(file) {
    if (!file) return;
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      var size = 256;
      var c = document.createElement('canvas');
      c.width = size; c.height = size;
      var ctx = c.getContext('2d');
      var sSide = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - sSide) / 2, (img.height - sSide) / 2, sSide, sSide, 0, 0, size, size);
      var data = '';
      try { data = c.toDataURL('image/jpeg', 0.82); } catch (err) { toast('图片处理失败'); return; }
      URL.revokeObjectURL(url);
      if (!S.ai) S.ai = {};
      S.ai.avatar = data;
      aiNormalize();
      if (S.dms[AI_PEER]) S.dms[AI_PEER].avatar = data;
      save();
      try { localStorage.setItem(LK('dms'), JSON.stringify(S.dms)); } catch (e) {}
      renderAiPanel(); renderRooms(); syncAiModelUi();
      try { paintChatAva(AI_RID); } catch (e) {}
      toast('头像换好了');
    };
    img.onerror = function () { toast('这张图打不开'); };
    img.src = url;
  }
  function renderAiId() {
    var b = $('#aiAvatarBtn');
    if (b) {
      if (S.ai && S.ai.avatar) b.innerHTML = '<img src="' + esc(S.ai.avatar) + '" alt="">';
      else b.innerHTML = '🤖';
      b.classList.toggle('has-img', !!(S.ai && S.ai.avatar));
    }
    if ($('#aiIdName')) $('#aiIdName').textContent = aiName();
  }

  function aiToggleModel(m) {
    var picked = aiModelList();
    var i = picked.indexOf(m);
    if (i >= 0) {
      if (picked.length === 1) { toast('至少留一个模型'); return; }
      picked.splice(i, 1);
      if (S.ai.model === m) S.ai.model = picked[0];     // 删掉的正好是当前的，换第一个
    } else {
      picked.push(m);
      if (!S.ai.model || aiModelList().indexOf(S.ai.model) < 0) S.ai.model = m;
    }
    save(); renderAiModelList(); syncAiModelUi();
  }
  // 在勾选好的模型里切换当前用的那个
  function aiSetCurrent(m) {
    if (aiModelList().indexOf(m) < 0) return;
    S.ai.model = m;
    save(); renderAiModelList(); syncAiModelUi();
    toast('已切到 ' + m);
  }
  function paintPathSub() {
    var el = $('#chatSub');
    if (!el) return;
    if (S.cur === AI_RID) {
      var m = (S.ai && S.ai.model) || '未选模型';
      el.textContent = 'AI 通路 · dm:ai · ' + m;
      return true;
    }
    if (S.cur === LOCAL_RID) {
      el.textContent = '本地通路 · dm:local';
      return true;
    }
    if (S.cur === 'lobby') {
      el.textContent = '服务器通路 · lobby';
      return true;
    }
    return false;
  }
  function syncAiModelUi() {
    var a = S.ai || {};
    try { paintPathSub(); } catch (e) {}
    if ($('#aiModel')) $('#aiModel').value = a.model || '';
    if ($('#aiModelHint')) {
      var n = aiModelList().length;
      $('#aiModelHint').textContent = n
        ? ('已勾选 ' + n + ' 个模型，当前用的是 ' + (a.model || '') + '；点模型名字可以换。')
        : '点「获取」向接口地址请求可用模型，勾选你要的。';
    }
    // 聊天页顶栏：AI 会话里显示当前模型
    var chip = $('#aiModelChip');
    if (chip) {
      var inAi = S.cur === AI_RID;
      chip.classList.toggle('hidden', !inAi);
      if (inAi) chip.textContent = (a.model || '模型') + ' ▾';
    }
  }
  function aiFetchModels(silent) {
    var base = normAiBase($('#aiBase') ? $('#aiBase').value : (S.ai && S.ai.base));
    var hint = $('#aiModelHint');
    if (!aiKeyStore()) { toast('先填 API key'); return; }
    if (hint) hint.textContent = '正在向 ' + base + ' 获取模型列表…';
    var btn = $('#aiFetchModels');
    if (btn) btn.disabled = true;
    aiModelSilent = !!silent;
    var done = function (ids, err) {
      if (btn) btn.disabled = false;
      if (err) { if (hint) hint.textContent = '获取失败：' + err; toast('获取模型失败'); return; }
      aiModelFetched = ids.slice();
      var picked = aiModelList();
      if (!picked.length && ids.length) { picked.push(ids[0]); S.ai.model = S.ai.model || ids[0]; }
      // 当前模型不在新的列表里就换成第一个可用的
      if (ids.length && ids.indexOf(S.ai.model) < 0 && picked.indexOf(S.ai.model) < 0) S.ai.model = ids[0];
      save(); renderAiModelList(); syncAiModelUi();
      if (!silent) toast('拿到 ' + ids.length + ' 个模型');
    };
    try {
      if (window.PaperNative && window.PaperNative.aiModels) {
        window.PaperNative.aiModels(base);
        return;
      }
    } catch (e) {}
    // 浏览器调试时才走 fetch
    try {
      fetch(base + '/models', { headers: { 'Authorization': 'Bearer ' + aiKeyStore() } })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { done(((j && j.data) || []).map(function (x) { return x.id; }).filter(Boolean)); })
        .catch(function (e) { done([], e.message); });
    } catch (e) { done([], e.message); }
  }
  /* ---------- 测试连接：把真实的 HTTP 结果摊开给人看 ---------- */
  function aiDiag() {
    var lines = [];
    try {
      lines.push('当前会话：' + (S.cur || '(无)'));
      lines.push('最近一次发送走：' + (lastSendPath || '(还没发过)'));
      var d = S.dms || {};
      lines.push('私信条目：' + (Object.keys(d).length ? Object.keys(d).map(function (k) {
        return k + '→' + (d[k] && d[k].roomId);
      }).join('、') : '(空)'));
      lines.push('AI 开启：' + (!!(S.ai && S.ai.on)) + ' · AI 房间号：' + AI_RID + ' · 头像：' + ((S.ai && S.ai.avatar) ? '有' : '无'));
      lines.push('房间列表：' + (S.rooms || []).map(function (r) { return r && r.id; }).join('、'));
      var aiHist = 0, last = null;
      try { aiHist = (loadHist(AI_RID) || []).length; } catch (e) {}
      try { last = S.last[AI_RID]; } catch (e) {}
      lines.push('AI 历史：' + aiHist + ' 条' + (last ? ' · 最后一条在 ' + fmtTime(last.ts) : ''));
      var lob = 0;
      try { lob = (loadHist('lobby') || []).length; } catch (e) {}
      lines.push('大厅历史：' + lob + ' 条');
      var dup = {};
      Object.keys(d).forEach(function (k) { var v = dmRoomOf(k); dup[v] = (dup[v] || 0) + 1; });
      var bad = Object.keys(dup).filter(function (k) { return dup[k] > 1; });
      lines.push('重复房间号：' + (bad.length ? bad.join('、') : '无'));
      if (sendLog.length) {
        lines.push('最近发送：' + sendLog.slice(-6).map(function (x) {
          return x.kind + '[' + x.detail + ']' + (x.text ? '"' + x.text + '"' : '');
        }).join(' · '));
      } else {
        lines.push('最近发送：(无)');
      }
      var name = $('#aiName') ? $('#aiName').value : '';
      lines.push('面板名字：' + name + ' · 列表名：' + aiName());
    } catch (e) { lines.push('自检出错：' + e.message); }
    aiTestOut(lines.join('\n'));
    // 顺手把结果落到会话里，手机上截图更方便
    try {
      var ridForDiag = S.cur && (S.cur === AI_RID || isDM(S.cur) || roomExists(S.cur)) ? S.cur : AI_RID;
      addMsg(ridForDiag, { id: 'diag' + Date.now(), from: AI_PEER, name: '自检', text: lines.join('\n'), ts: Date.now(), sys: true });
      saveHist(ridForDiag);
      if (S.cur === ridForDiag) renderMsgs(false);
    } catch (e) {}
  }
  function aiRepair() {
    var did = false;
    try { did = aiNormalize(); } catch (e) {}
    renderRooms();
    if (S.cur) { try { renderMsgs(true); } catch (e) {} }
    fireDiag();
    toast(did ? '会话已归位' : '会话本来就是对的');
  }
  function fireDiag() { try { aiDiag(); } catch (e) {} }

  function aiTestOut(text) {
    var el = $('#aiTestOut');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
  }
  function aiTest() {
    var a = S.ai || {};
    var base = normAiBase($('#aiBase') ? $('#aiBase').value : a.base);
    var model = (($('#aiModel') && $('#aiModel').value) || a.model || '').trim();
    if (!aiKeyStore()) { aiTestOut('还没填 API key，先在上面填好再点「保存并启用」。'); return; }
    if (!model) { aiTestOut('还没选模型，点「获取」勾一个。'); return; }
    var btn = $('#aiTest');
    if (btn) btn.disabled = true;
    aiTestOut('正在请求 ' + base + '/chat/completions · model=' + model + ' …');
    var msgs = JSON.stringify([{ role: 'user', content: '你好' }]);
    var doneOne = function (msg) {
      if (btn) btn.disabled = false;
      aiTestOut(msg);
    };
    var slow = setTimeout(function () { if (btn) btn.disabled = false; }, 130000);
    try {
      if (window.PaperNative && window.PaperNative.aiAsk) {
        aiAskNative(base, model, msgs, function () { /* 结果统一在 onRaw 里摊开 */ }, function (payload, j) {
          clearTimeout(slow);
          if (j && j.ok) doneOne('通了，模型回：' + String(j.text || '').slice(0, 200));
          else {
            var e2 = String(payload || '').slice(0, 400);
            if (/model[^.]*not|not.?found|invalid.?model|model_not_found|not available/i.test(e2)) {
              try { aiFetchModels(true); } catch (err) {}
              e2 = e2 + '\n\n这个地址没有这个模型名：按「获取」看它实际提供哪些，勾一个再试。';
            }
            doneOne('失败：' + e2);
          }
        });
        return;
      }
    } catch (e) { }
    // 浏览器里调试才走 fetch
    try {
      fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aiKeyStore() },
        body: JSON.stringify({ model: model, messages: [{ role: 'user', content: '你好' }], stream: false })
      }).then(function (r) {
        return r.text().then(function (t) {
          doneOne('HTTP ' + r.status + ' · ' + String(t || '').slice(0, 400));
        });
      }).catch(function (e) { doneOne('请求失败：' + (e && e.message ? e.message : e)); });
    } catch (e) { doneOne('请求没发出去：' + e.message); }
  }

  // 原生回调：{"ok":true,"ids":[...]} / {"ok":false,"error":"..."}
  window.__aiModelsReply = function (payload) {
    var j = null;
    try { j = JSON.parse(payload); } catch (e) {}
    if (j && j.ok && Array.isArray(j.ids)) return aiModelDone(j.ids);
    var hint = $('#aiModelHint');
    var btn = $('#aiFetchModels');
    if (btn) btn.disabled = false;
    if (hint) hint.textContent = '获取失败：' + ((j && j.error) || '未知错误');
    toast('获取模型失败');
  };
  var aiModelSilent = false;
  var aiModelDone = function (ids) {
    var hint = $('#aiModelHint'), btn = $('#aiFetchModels');
    if (btn) btn.disabled = false;
    aiModelFetched = ids.slice();
    var picked = aiModelList();
    if (!picked.length && ids.length) picked.push(ids[0]);
    if (ids.length && picked.indexOf(S.ai.model) < 0 && ids.indexOf(S.ai.model) < 0) S.ai.model = ids[0];
    if (!S.ai.model && ids.length) S.ai.model = ids[0];
    save(); renderAiModelList(); syncAiModelUi();
    if (hint) hint.textContent = '拿到 ' + ids.length + ' 个模型';
    if (!aiModelSilent) toast('拿到 ' + ids.length + ' 个模型');
  };

  /* 输入框展开：值太长时点开看全、改全 */
  var aiExpandTarget = null;
  var AI_FIELD_TITLES = { aiBase: '接口地址', aiModel: '模型', aiKey: 'API key', aiName: '名称' };
  function aiOpenExpand(id) {
    var src = $('#' + id);
    if (!src || !$('#aiExpand')) return;
    aiExpandTarget = id;
    $('#aiExpandTitle').textContent = AI_FIELD_TITLES[id] || '编辑';
    var v = src.value;
    if (id === 'aiKey') { var real = aiKeyStore(); if (real) v = real; }
    $('#aiExpandText').value = v || '';
    var el = $('#aiExpand');
    el.classList.remove('hidden');
    requestAnimationFrame(function () {
      el.classList.add('open');
      setTimeout(function () { try { $('#aiExpandText').focus(); } catch (e) {} }, 140);
    });
  }
  function aiCloseExpand(keep) {
    var el = $('#aiExpand');
    if (!el) return;
    if (keep && aiExpandTarget) {
      var src = $('#' + aiExpandTarget);
      if (src) src.value = $('#aiExpandText').value;
    }
    aiExpandTarget = null;
    el.classList.remove('open');
    setTimeout(function () { try { el.classList.add('hidden'); } catch (e) {} }, 200);
  }

  function renderAiPanel() {
    var a = S.ai || {};
    if ($('#aiOn')) $('#aiOn').checked = !!a.on;
    if ($('#aiBase')) $('#aiBase').value = a.base || '';
    if ($('#aiModel')) $('#aiModel').value = a.model || '';
    if ($('#aiName')) $('#aiName').value = a.name || 'AI 助手';
    var eff = a.effort || 'low';
    Array.prototype.forEach.call(document.querySelectorAll('#aiEffort .ai-eff'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-eff') === eff);
    });
    renderAiId();
    renderAiModelList(); syncAiModelUi();
    if ($('#aiKey')) { var k = aiKeyStore(); $('#aiKey').value = k ? '••••••••' : ''; }
    refreshAiStat();
  }
  function aiApply(on) {
    var a = S.ai || (S.ai = {});
    a.on = !!on;
    a.base = normAiBase($('#aiBase') ? $('#aiBase').value : a.base);
    a.model = (($('#aiModel') && $('#aiModel').value) || a.model || 'deepseek-chat').trim().slice(0, 60);
    a.name = (($('#aiName') && $('#aiName').value) || 'AI 助手').trim().slice(0, 16) || 'AI 助手';
    var kEl = $('#aiKey');
    var kv = kEl ? kEl.value.trim() : '';
    if (kv && kv.indexOf('••') !== 0) aiKeyStore('', kv);     // 只有真改过才覆盖
    save();
    ensureAiConv(!!a.on);
    refreshAiStat();
    try { renderAiId(); } catch (e) {}
    try { syncAiModelUi(); } catch (e) {}
    try { renderRooms(); } catch (e) {}
    try { paintChatAva(AI_RID); } catch (e) {}
    toast(a.on ? ('AI 助手已开启（' + a.model + '）') : 'AI 助手已关闭');
  }
  function normAiBase(v) {
    var t = String(v || '').trim().replace(/\s+/g, '');
    if (!t) return 'https://api.deepseek.com/v1';
    if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
    return t.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  }
  // 聊天里给 AI 发消息：把最近几条历史一起发过去，回复直接落到会话里
  // 每次请求带一个号，原生原样回传，避免「一次没回、后面全错位」
  var aiRidSeq = 0, aiWait = {};
  function aiAskNative(base, model, msgs, onText, onRaw) {
    var rid = 'q' + (++aiRidSeq) + Date.now();
    aiWait[rid] = { text: onText, raw: onRaw };
    try {
      if (window.PaperNative && window.PaperNative.aiAsk) {
        var opts = JSON.stringify({ effort: (S.ai && S.ai.effort) || 'low' });
        window.PaperNative.aiAsk(base, model, msgs, rid, opts);
        return rid;
      }
    } catch (e) { delete aiWait[rid]; throw e; }
    delete aiWait[rid];
    return null;
  }
  window.__aiReply = function (payload, rid) {
    var w = (rid && aiWait[rid]) || null;
    if (!w) {                    // 老版本原生不带号：取最早还在等的那个
      var keys = Object.keys(aiWait);
      if (!keys.length) return;
      w = aiWait[keys[0]];
      rid = keys[0];
    }
    delete aiWait[rid];
    var j = null;
    try { j = JSON.parse(payload); } catch (e) {}
    // 原生可能换了地址才通（少写/多写 /v1）：把通的地址记下来，下次直接用
    if (j && j.ok && j.url) aiAdoptUrl(j.url);
    if (w.raw) w.raw(payload, j);
    if (j && j.ok) w.text(String(j.text || '(模型没返回内容)').trim());
    else {
      var errText = String((j && j.error) || '未知错误');
      var modelBad = /model[^.]*not|not.?found|invalid.?model|model_not_found|not available|does not exist/i.test(errText);
      if (modelBad) {
        // 这个地址没有这个模型：顺手把它真正提供的模型抓回来，面板里就能直接勾
        var oldModel = (S.ai && S.ai.model) || '';
        try { aiFetchModels(true); } catch (e) {}
        errText = errText + '｜模型名和这个地址对不上（当前填的是 ' + oldModel + '），点开 AI 面板按「获取」挑它真正提供的模型';
        try { toast('这个地址没有 ' + oldModel + '，正在获取它的模型列表'); } catch (e) {}
      }
      w.text('连不上模型：' + errText);
    }
  };
  // 原生实际打通的地址（不带 scheme，如 api.deepseek.com/v1/chat/completions）
  function aiAdoptUrl(url) {
    var u = String(url || '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (S.ai && S.ai.base !== u) {
      S.ai.base = u;
      save();
      try { if ($('#aiBase')) $('#aiBase').value = u; } catch (e) {}
      try { refreshAiStat(); } catch (e) {}
    }
  }
  function askAi(text, tid) {
    var hist = loadHist(AI_RID).filter(function (m) { return m && m.text && !m.sys; });
    var msgs = [{ role: 'system', content: '你是纸鸢里的 AI 助手，中文口语回答，简洁，不要用 Markdown 列表。' }];
    hist.slice(-16).forEach(function (m) {
      if (m.id === tid) return;                     // 刚发的那条单独加，免得重复
      var out = (m.from === S.deviceId || m.from === S.me || m.from === 'me');
      msgs.push({ role: out ? 'user' : 'assistant', content: String(m.text || '').slice(0, 4000) });
    });
    msgs.push({ role: 'user', content: text });

    var ph = { id: 'ai' + Date.now(), from: AI_PEER, name: aiName(), text: '思考中…', ts: Date.now(), sys: true, typing: true };
    addMsg(AI_RID, ph); saveHist(AI_RID); renderMsgs(true);

    var done = function (outText) {
      var list = loadHist(AI_RID);
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].id === ph.id) {
          list[i].text = outText; list[i].sys = false; list[i].typing = false;
          break;
        }
      }
      saveHist(AI_RID);
      S.last[AI_RID] = { id: ph.id, text: outText, name: aiName(), ts: Date.now() };
      save();
      if (S.cur === AI_RID) renderMsgs(true);
      renderRooms();
    };

    var msgsJson = JSON.stringify(msgs);
    var wantSlowHint = true;
    var waited = 0;
    var tickTimer = setInterval(function () {
      waited += 1;
      if (!wantSlowHint) return;
      var list0 = loadHist(AI_RID);
      for (var i0 = 0; i0 < list0.length; i0++) {
        if (list0[i0] && list0[i0].id === ph.id && list0[i0].typing) {
          list0[i0].text = '思考中… ' + waited + ' 秒';
          saveHist(AI_RID);
          if (S.cur === AI_RID) renderMsgs(false);
          break;
        }
      }
    }, 1000);
    setTimeout(function () {
      if (!wantSlowHint) return;
      var list = loadHist(AI_RID);
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === ph.id && list[i].typing) {
          list[i].text = '（还没回应，最多等 2 分钟；一直这样就在面板里点「测试」看具体报错）';
          saveHist(AI_RID);
          if (S.cur === AI_RID) renderMsgs(false);
          break;
        }
      }
    }, 25000);
    var stopTick = function () { try { clearInterval(tickTimer); } catch (e) {} };
    // 原生发请求：WebView 里 fetch 会被 CORS / file:// 拦住，浏览器调试时才走 fetch
    try {
      if (window.PaperNative && window.PaperNative.aiAsk) {
        aiAskNative(S.ai.base || '', S.ai.model || '', msgsJson, function (t) { wantSlowHint = false; stopTick(); done(t); });
        return;
      }
    } catch (e) {}
    wantSlowHint = false;
    stopTick();
    try {
      fetch((S.ai.base || '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aiKeyStore() },
        body: JSON.stringify({ model: S.ai.model, messages: msgs, stream: false })
      }).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + String(t || '').slice(0, 120)); });
        return r.json();
      }).then(function (j) {
        var t = j && j.choices && j.choices[0] && (j.choices[0].message || {}).content;
        done(String(t || '(模型没返回内容)').trim());
      }).catch(function (e) { done('连不上模型：' + (e && e.message ? e.message : e)); });
    } catch (e) { done('请求没发出去：' + e.message); }
  }

  /* ---------------- 用户接入（Agent 作为真账号） ---------------- */
  function agentUserOn() { return !!(window.PaperNative && window.PaperNative.agentUserApply); }
  function renderAgentUserPanel() {
    var u = S.agentUser || {};
    if ($('#agentUserOn')) $('#agentUserOn').checked = !!u.on;
    if ($('#agentUserAcc')) $('#agentUserAcc').value = u.user || '';
    if ($('#agentUserPass')) $('#agentUserPass').value = u.pass || '';
    if ($('#agentUserNick')) $('#agentUserNick').value = u.nick || '';
    if ($('#agentUserPort')) $('#agentUserPort').value = u.port || 6722;
    if ($('#agentUserLan')) $('#agentUserLan').checked = !!u.lan;
    var pv = $('#agentUserAvatarPrev');
    if (pv) pv.innerHTML = u.avatar ? '<img src="' + esc(u.avatar) + '" alt="">' : '🤖';
    var st = $('#agentUserStat');
    if (st) {
      if (!u.on) st.textContent = u.error ? ('未开启 · ' + u.error) : '未开启';
      else if (u.ready) {
        var cnt = Number(u.clients) || 0;
        st.textContent = '已上线：' + (u.nick || u.user) + '（账号 ' + (u.user || '-') + '）'
          + ' · 监听 ' + (u.port || 6722)
          + ' · ' + (cnt ? (cnt + ' 个 Agent 已连接') : '等待 Agent 连接')
          + (u.last ? ('（最近：' + u.last + '）') : '');
      }
      else st.textContent = '连接中…' + (u.error ? (' · ' + u.error) : '');
    }
  }
  function agentUserApplyFromPanel() {
    if (!agentUserOn()) { toast('这个版本不支持用户接入'); return; }
    var on = !!($('#agentUserOn') && $('#agentUserOn').checked);
    var user = ($('#agentUserAcc') ? $('#agentUserAcc').value : '').trim();
    var pass = ($('#agentUserPass') ? $('#agentUserPass').value : '').trim();
    var nick = ($('#agentUserNick') ? $('#agentUserNick').value : '').trim();
    if (on && (user.length < 2 || pass.length < 4)) { toast('账号至少 2 位、密码至少 4 位'); return; }
    S.agentUser.on = on;
    S.agentUser.user = user;
    S.agentUser.pass = pass;
    S.agentUser.nick = nick || user;
    var port = Number($('#agentUserPort') ? $('#agentUserPort').value : 0) || 6722;
    var lan = !!($('#agentUserLan') && $('#agentUserLan').checked);
    S.agentUser.port = port;
    S.agentUser.lan = lan;
    save();
    try {
      window.PaperNative.agentUserApply(on, user, pass, S.agentUser.nick, S.agentUser.avatar || '', port, lan);
    } catch (e) {}
    renderAgentUserPanel();
    toast(on ? ('用户接入已开启：' + S.agentUser.nick) : '用户接入已关闭');
  }
  function refreshAgentUserStatus(st) {
    if (!st) return;
    var u = null;
    try { u = typeof st.user === 'string' ? JSON.parse(st.user) : st.user; } catch (e) { u = null; }
    if (!u) return;
    S.agentUser.ready = !!u.ready;
    S.agentUser.clients = Number(u.clients) || 0;
    S.agentUser.last = u.last || '';
    S.agentUser.error = u.error || '';
    if (u.user) S.agentUser.user = u.user;
    if (u.nick) S.agentUser.nick = u.nick;
    if (u.port) S.agentUser.port = Number(u.port) || 6722;
    renderAgentUserPanel();
  }

  function renderAgentAvatarPreview() {
    var el = $('#agentAvatarPrev');
    if (!el) return;
    var av = localAgentAvatar();
    el.innerHTML = av ? '<img src="' + esc(av) + '" alt="">' : '👤';
  }
  function refreshAgentStatus() {
    var st = null;
    try { if (window.PaperNative && window.PaperNative.agentStatus) st = JSON.parse(window.PaperNative.agentStatus() || '{}'); } catch (e) { st = null; }
    if (st) {
      S.localAgent.on = !!st.on;
      S.localAgent.clients = Number(st.clients) || 0;
      if (st.port) S.localAgent.port = Number(st.port);
      S.localAgent.error = st.error || '';
    }
    var el = $('#agentStat');
    if (el) {
      el.textContent = S.localAgent.on
        ? ('监听 ' + (S.localAgent.lan ? '0.0.0.0' : '127.0.0.1') + ':' + S.localAgent.port +
           ' · ' + (S.localAgent.clients ? (S.localAgent.clients + ' 个 Agent 已连接') : '等待 Agent 连接') +
           (S.localAgent.last ? ('（最近：' + S.localAgent.last + '）') : '') +
           (S.localAgent.error ? (' · ' + S.localAgent.error) : ''))
        : (S.localAgent.error ? ('未开启 · ' + S.localAgent.error) : '未开启');
    }
    return st;
  }
  // Agent 发来的消息
  window.__agentOnMessage = function (text) {
    if (!text) return;
    if (!S.dms[LOCAL_PEER]) return;
    var m = { id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), from: LOCAL_PEER, name: localAgentName(), avatar: localAgentAvatar(), text: text, ts: Date.now() };
    addMsg(LOCAL_RID, m);
    S.last[LOCAL_RID] = { id: m.id, text: text, name: '本地用户', ts: m.ts };
    if (S.cur !== LOCAL_RID) {
      markUnread(LOCAL_RID, m);
      S.unread[LOCAL_RID] = (S.unread[LOCAL_RID] || 0) + 1;
      notifyMessage(LOCAL_RID, m);
    }
    save(); renderRooms();
    if (S.cur === LOCAL_RID) renderMsgs(false);
  };
  window.__agentOnStatus = function (json) {
    try {
      var st = typeof json === 'string' ? JSON.parse(json) : json;
      if (!st) return;
      S.localAgent.on = !!st.on;
      S.localAgent.clients = Number(st.clients) || 0;
      if (st.port) S.localAgent.port = Number(st.port);
      S.localAgent.error = st.error || '';
      if (st.last) S.localAgent.last = st.last;
      refreshAgentStatus();
      refreshAgentUserStatus(st);
    } catch (e) {}
  };

  /* ---------------- 渲染：会话列表 ---------------- */
  // 从 members/people/contacts 这类列表里把头像记下来
  function learnAvatars(list) {
    try {
      if (!list || !list.length) return;
      if (!S.avatars) S.avatars = {};
      list.forEach(function (it) {
        if (!it || !it.avatar) return;
        if (it.id) S.avatars[it.id] = it.avatar;
        if (it.name) S.avatars[it.name] = it.avatar;
        if (it.uid) S.avatars['uid:' + it.uid] = it.avatar;
      });
      renderRooms();
      if (S.tab === 'contacts') renderContacts();
    } catch (e) {}
  }

  // 会话列表/联系人列表用的头像：能拿到图就用图，拿不到退回首字
  function peerAvatarUrl(keys) {
    if (!S.avatars) return '';
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!k) continue;
      var v = S.avatars[k];
      if (v) return /^(data:|https?:)/.test(v) ? v : httpBase() + v;
    }
    return '';
  }
  function avaBox(url, text, bg, cls) {
    if (url) return '<div class="ava has-img' + (cls ? ' ' + cls : '') + '"><img src="' + esc(url) + '" alt=""></div>';
    return '<div class="ava' + (cls ? ' ' + cls : '') + '" style="background:' + esc(bg) + '">' + esc(text) + '</div>';
  }

  /* 聊天页顶栏头像：跟会话列表用同一套取图逻辑。
     以前这里只写了 emoji / 👤，带图片头像的用户进会话后顶栏永远是那个占位符。 */
  function paintChatAva(rid) {
    var el = $('#chatAva');
    if (!el || !rid) return;
    var r = room(rid) || {};
    var url = '', text = r.emoji || '💬', bg = r.color || '#3390ec';
    if (isDM(rid)) {
      var peerId = dmPeerOf(rid);
      var dd = (S.dms && S.dms[peerId]) || {};
      if (peerId === AI_PEER) url = absAvatar((S.ai && S.ai.avatar) || '');
      else if (peerId === LOCAL_PEER) url = absAvatar((S.localAgent && S.localAgent.avatar) || '');
      else url = peerAvatarUrl([peerId, dd.peerId, dd.name, r.name]) ||
                 absAvatar(dd.avatar) || absAvatar(r.avatar);
      text = String(dd.name || r.name || '?').trim().slice(0, 1).toUpperCase() || '👤';
      bg = colorOf(peerId || r.name || '');
    } else if (r.avatar) {
      url = absAvatar(r.avatar);
    }
    if (url) {
      el.classList.add('has-img');
      el.style.background = '';
      el.innerHTML = '<img src="' + esc(url) + '" alt="">';
    } else {
      el.classList.remove('has-img');
      el.style.background = bg;
      el.textContent = text;
    }
  }
  // 头像地址可能是相对路径，补上服务器前缀
  function absAvatar(v) {
    if (!v) return '';
    return /^(data:|https?:)/.test(v) ? v : httpBase() + v;
  }

  function renderRooms() {
    try { aiNormalize(); } catch (e) {}
    var html = '';
    function item(r, isDM, peerId) {
      var last = S.last[r.id];
      var preview = last ? (last.name ? last.name + '：' : '') + (last.retracted ? '消息已撤回' : last.text) : (isDM ? '开始私聊吧' : '还没有消息，打个招呼吧');
      var un = S.unread[r.id] || 0;
      var cls = 'room' + (isDM ? ' room-dm' : '') + (S.pins[r.id] ? ' pinned' : '');
      var avaUrl = '';
      var avaText = r.emoji, avaBg = r.color;
      if (isDM) {
        var dd = (S.dms && S.dms[peerId]) || {};
        if (peerId === AI_PEER) avaUrl = (S.ai && S.ai.avatar) || '';
        else if (peerId === LOCAL_PEER) avaUrl = (S.localAgent && S.localAgent.avatar) || '';
        else avaUrl = peerAvatarUrl([peerId, dd.peerId, dd.name, r.name]);
        avaText = String(dd.name || r.name || '?').trim().slice(0, 1).toUpperCase() || '👤';
        avaBg = colorOf(peerId || r.name || '');
      } else if (r.avatar) {
        avaUrl = /^(data:|https?:)/.test(r.avatar) ? r.avatar : httpBase() + r.avatar;
      }
      return '<li class="' + cls + '" data-room="' + esc(r.id) + '"' + (peerId ? ' data-peer="' + esc(peerId) + '"' : '') + '>' +
        avaBox(avaUrl, avaText, avaBg) +
        '<div class="room-main">' +
          '<div class="room-line1"><div class="room-name">' + (S.pins[r.id] ? '<span class="pin-ico">📌</span>' : '') + (S.mutes[r.id] ? '<span class="mute-ico">🔕</span>' : '') + esc(r.name) + '</div>' +
            '<div class="room-time">' + (last ? esc(fmtTime(last.ts)) : '') + '</div></div>' +
          '<div class="room-line2"><div class="room-last">' + esc(preview) + '</div>' +
            (un ? '<div class="badge">' + (un > 99 ? '99+' : un) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<button class="room-more" type="button" data-more="' + esc(r.id) + '" aria-label="更多">⋯</button>' +
      '</li>';
    }
    var list = [];
    Object.keys(S.dms).forEach(function (peerId) {
      var d = S.dms[peerId];
      list.push({ r: { id: dmRoomOf(peerId), name: nameOf(peerId, d.name || '私信'), emoji: '👤', color: '#6b7d8f',
        avatar: d.avatar || '' }, isDM: true, peerId: peerId });
    });
    Object.keys(S.groups).forEach(function (gid) {
      var g = S.groups[gid];
      if (!g) return;
      list.push({ r: groupRoom(g), isDM: false, peerId: null });
    });
    S.rooms.forEach(function (r) { list.push({ r: r, isDM: false, peerId: null }); });

    // 顶栏头像跟列表同一套逻辑：别人换了头像、或私信记录刚补上头像，聊天页里也要跟着变
    try { if (S.cur && $('#chat') && !$('#chat').classList.contains('hidden')) paintChatAva(S.cur); } catch (e) {}

    // 置顶排最前，各自按最后消息时间倒序
    list.sort(function (a, b) {
      var pa = S.pins[a.r.id] ? 1 : 0, pb = S.pins[b.r.id] ? 1 : 0;
      if (pa !== pb) return pb - pa;
      var ta = (S.last[a.r.id] && S.last[a.r.id].ts) || 0;
      var tb = (S.last[b.r.id] && S.last[b.r.id].ts) || 0;
      if (ta !== tb) return tb - ta;
      return 0;
    });
    list.forEach(function (x) { html += item(x.r, x.isDM, x.peerId); });
    var box = $('#roomList');
    // 内容没变就别重建：presence 心跳/在线状态每秒都会调用这里，
    // 全量重设 innerHTML 会掉滚动位置、也像「界面在刷新」
    if (box.__html === html) { markPainted(box, 600); return; }
    var scroller = box.parentElement;
    var keepScroll = scroller ? scroller.scrollTop : 0;
    box.__html = html;
    box.innerHTML = html;
    if (scroller && keepScroll) scroller.scrollTop = keepScroll;
    markPainted(box, 600);
    try { observeRows(box); } catch (e) {}
  }

  /* 首屏入场动画只播一次：播完打个 painted，之后重绘不再重播 */
  function markPainted(el, delay) {
    if (!el || el.classList.contains('painted')) return;
    setTimeout(function () { try { el.classList.add('painted'); } catch (e) {} }, delay || 600);
  }

  /* 卡片滚动到场才浮现：只对还没露出的行加 .row-in，露过一次就不再管 */
  var rowObserver = null;
  function observeRows(box) {
    if (!box) return;
    if (!('IntersectionObserver' in window)) return;
    if (!rowObserver) {
      rowObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add('row-in');
            rowObserver.unobserve(en.target);
          }
        });
      }, { root: box, rootMargin: '0px 0px -8% 0px', threshold: 0.01 });
    }
    Array.prototype.forEach.call(box.querySelectorAll('.room'), function (el, i) {
      if (el.classList.contains('painted-row')) return;
      el.classList.add('painted-row');
      el.style.animationDelay = (Math.min(i, 6) * 26) + 'ms';
      rowObserver.observe(el);
    });
  }
  /* 任何路径改动列表（renderRooms / renderContacts / 直接 innerHTML）都自动接上 */
  function watchLists() {
    ['#roomList', '#friendList'].forEach(function (sel) {
      var box = $(sel);
      if (!box || box.__watched) return;
      box.__watched = true;
      try {
        new MutationObserver(function () {
          try { observeRows(box); } catch (e) {}
        }).observe(box, { childList: true });
      } catch (e) {}
      try { observeRows(box); } catch (e) {}
    });
  }
  /* ---------------- 渲染：聊天页 ---------------- */
  function renderMsgs(force) {
    var rid = S.cur;
    if (!rid) return;
    var arr = loadHist(rid);
    var box = $('#msgs');
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    var html = '', prevDay = '', prevFrom = '', prevTs = 0;

    arr.forEach(function (m, mi) {
      var day = fmtDay(m.ts);
      if (day !== prevDay) {
        html += '<div class="day">' + esc(day) + '</div>';
        prevDay = day; prevFrom = ''; prevTs = 0;
      }
      var nextM = arr[mi + 1];
      // 同一个人连着发、且间隔小于 5 分钟 = 同一组；组的最后一条才画尾巴
      var isLast = !nextM || nextM.from !== m.from || nextM.ts - m.ts > 5 * 60000 || fmtDay(nextM.ts) !== day;
      var out = m.from === S.deviceId || m.from === S.me || m.from === 'me' || (!!m.deviceId && m.deviceId === S.deviceId);
      var tail = (prevFrom === m.from && m.ts - prevTs < 5 * 60000 && prevDay === day);
      var uid = m.deviceId || (out ? '' : m.from);
      var initial = (nameOf(uid, m.name) || '?').trim().slice(0, 1).toUpperCase() || '?';
      var color = colorOf(uid || m.from);
      var av = avatarOf(m);
      html += '<div class="msg' + (out ? ' out' : '') + (tail ? ' tail' : '') + (isLast ? ' last' : '') +
              (m.pending ? ' pending' : '') + '" data-id="' + esc(m.id || '') + '" data-uid="' + esc(uid) + '">' +
        (av
          ? '<div class="mini-ava has-img"><img src="' + esc(av) + '" alt=""></div>'
          : '<div class="mini-ava" style="background:' + color + '">' + esc(initial) + '</div>') +
        '<div class="bubble' + (m.image && !m.sticker ? ' has-img' : '') + (m.sticker ? ' sticker' : '') + '">' +
          (function () {
            var nm = out ? (S.nick || '我') : nameOf(uid, m.name);
            var col = out ? 'var(--tg-meta)' : colorOf(m.from || m.name || '');
            return '<div class="who" style="color:' + col + '">' + esc(nm) + '</div>';
          })() +
          (m.replyTo && !m.retracted ? '<div class="quoted" data-quote-id="' + esc(m.replyTo.id || '') + '"><b>' + esc(nameOf(m.replyTo.from, m.replyTo.name)) + '</b><span>' + esc(m.replyTo.text || '消息') + '</span></div>' : '') +
          (m.retracted ? '<span class="retracted">消息已撤回</span>' : messageBody(m)) +
          '<span class="meta">' + (out ? '<span class="ticks' + (m.pending ? ' queued' : '') + '">' + (m.pending ? '✓' : '✓✓') + '</span>' : '') + esc(fmtTime(m.ts)) + '</span>' +
        '</div></div>';
      prevFrom = m.from; prevTs = m.ts;
    });

    box.innerHTML = html || '<div class="day">还没有消息</div>';
    if (force || nearBottom) snapBottom(box);
  }

  /* 直接落到底部：.msgs 上有 scroll-behavior: smooth，赋值 scrollTop 会变成一段
     500ms 的滚动动画——进会话时就是那一下「抽搐」。这里临时关掉平滑再落位。 */
  function snapBottom(box) {
    if (!box) return;
    var prev = box.style.scrollBehavior;
    box.style.scrollBehavior = 'auto';
    box.scrollTop = box.scrollHeight;
    void box.scrollHeight;
    box.style.scrollBehavior = prev;
  }
  function messageBody(m) {
    if (m.voice) {
      var dur = Math.max(1, Math.round(Number(m.duration) || 0));
      return '<div class="voice-card" data-voice="' + esc(m.file || '') + '">' +
        '<button class="voice-play" type="button" aria-label="播放">▶</button>' +
        '<div class="voice-bar"><i></i></div>' +
        '<span class="voice-time">' + dur + '"</span></div>';
    }
    if (m.file) {
      var k = fileKind(m.fileName, m.mime);
      return '<div class="file-card">' +
        '<div class="file-icon">' + k.icon + '</div>' +
        '<div class="file-meta"><div class="file-name">' + esc(m.fileName || k.tip) + '</div>' +
        '<div class="file-size">' + k.tip + ' · ' + fmtBytes2(m.fileSize) + '</div></div>' +
        '<a class="file-dl" href="' + esc(downloadUrl(m)) + '" target="_blank" rel="noopener">下载</a>' +
        '</div>';
    }
    if (m.image) {
      var src = imgSrc(m);
      if (m.sticker) return '<img class="sticker-img" src="' + esc(src) + '" alt="表情">';
      return '<img class="msg-img" src="' + esc(src) + '" alt="图片">' +
        (m.text ? '<div class="caption">' + renderMessageText(m.text, m.mentions) + '</div>' : '');
    }
    if (m.big) return '<span class="big-emoji">' + esc(m.text) + '</span>';
    return '<span class="msg-text">' + renderMessageText(m.text, m.mentions) + '</span>';
  }
  function renderMessageText(text, mentions) {
    var safe = esc(text || '');
    (mentions || []).slice().sort(function (a, b) { return (b.name || '').length - (a.name || '').length; }).forEach(function (m) {
      if (!m || !m.name) return;
      var needle = esc('@' + m.name);
      safe = safe.split(needle).join('<span class="mention">' + needle + '</span>');
    });
    return safe;
  }
  function avatarOf(m) {
    if (!m) return '';
    if (m.avatar) return /^(data:|https?:)/.test(m.avatar) ? m.avatar : httpBase() + m.avatar;
    var key = m.from || m.name || '';
    if (S.avatars && S.avatars[key]) {
      var v = S.avatars[key];
      return /^(data:|https?:)/.test(v) ? v : httpBase() + v;
    }
    if (m.name && S.avatars && S.avatars[m.name]) {
      var v2 = S.avatars[m.name];
      return /^(data:|https?:)/.test(v2) ? v2 : httpBase() + v2;
    }
    return '';
  }
  function colorOf(id) {
    var palette = ['#3390ec', '#e57373', '#4caf50', '#ff9f0a', '#9c66d9', '#26a69a', '#ec407a', '#5c6bc0'];
    var h = 0;
    for (var i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) % 9973;
    return palette[h % palette.length];
  }

  /* ---------------- 打开会话 ---------------- */
  function isDM(id) { return !!id && id.indexOf('dm:') === 0; }
  function openRoom(rid) {
    try { aiNormalize(); } catch (e) {}
    if (aiIsRoom(rid) && rid !== AI_RID) rid = AI_RID;
    if (rid && rid.indexOf('dm:') === 0) {
      var pid = dmPeerOf(rid);
      if (pid === AI_PEER) rid = AI_RID;
      else if (pid === LOCAL_PEER) rid = LOCAL_RID;
    }
    S.cur = rid;
    S.unread[rid] = 0; save(); renderRooms();
    showJumpButton(rid);
    var r = room(rid);
    paintChatAva(rid);
    try { syncAiModelUi(); } catch (e) {}
    $('#chatName').textContent = r.name;
    setConn(connected);
    try { if (!paintPathSub()) { } } catch (e) {}
    $('#chat').classList.remove('hidden');
    $('#chat').classList.remove('chat-close');
    $('#chat').classList.add('chat-open');
    // 要等进场动画（400ms）走完再撤类，不然会被截断
    setTimeout(function () { try { $('#chat').classList.remove('chat-open'); } catch (e) {} }, 430);
    try {
      var _ct = document.querySelector('.chat-top');
      if (_ct) {
        // 收起的顶栏要「立刻」还原，不能跟着 300ms 过渡长大——进会话时那也是一下抽搐
        _ct.classList.add('no-anim');
        _ct.classList.remove('compact');
        setTimeout(function () { try { _ct.classList.remove('no-anim'); } catch (e) {} }, 260);
      }
      var _ms = $('#msgs');
      if (_ms && _ms.__chatReset) _ms.__chatReset();
      if (_ms) {
        // 首屏整块重建，最后一条不该再弹一次
        _ms.classList.add('fresh');
        setTimeout(function () { try { _ms.classList.remove('fresh'); } catch (e) {} }, 420);
      }
    } catch (e) {}
    $('#tabbar').classList.add('hidden');
    markPainted($('#msgs'), 500);
    syncPinBtn();
    syncComposer();
    renderMsgs(true);
    if (isDM(rid)) {
      var peerId = dmPeerOf(rid);
      // 本地用户是纯本机会话，不能把它的对端告诉服务器
      if (peerId && peerId !== LOCAL_PEER) wsSend({ t: 'pm_open', with: peerId, withName: room(rid).name });
    } else {
      wsSend({ t: 'room', room: rid });
    }
    setTimeout(function () { snapBottom($('#msgs')); }, 30);
  }
  function dmPeerOf(roomId) {
    var keys = Object.keys(S.dms);
    for (var i = 0; i < keys.length; i++) {
      if (S.dms[keys[i]] && S.dms[keys[i]].roomId === roomId) return keys[i];
    }
    // 服务端会把私信房间号写成 dm:<我>|<对方>，AI/本地也可能被写成这样
    if (roomId && roomId.indexOf('dm:') === 0) {
      var tail = roomId.slice(3).split('|')[0];
      if (tail === AI_PEER || tail === LOCAL_PEER) return tail;
      if (S.dms[tail]) return tail;
    }
    return null;
  }
  function upsertDm(peerId, roomId, peerName, uid, altPeer) {
    if (!roomId) return null;
    var keys = Object.keys(S.dms), i, k = '';
    for (i = 0; i < keys.length; i++) if (S.dms[keys[i]].roomId === roomId) { k = keys[i]; break; }
    if (!k && altPeer) {
      for (i = 0; i < keys.length; i++) if (keys[i] === altPeer || S.dms[keys[i]].peerId === altPeer) { k = keys[i]; break; }
    }
    if (!k && peerId) for (i = 0; i < keys.length; i++) if (keys[i] === peerId) { k = keys[i]; break; }
    if (!k && peerName) {
      var cand = keys.filter(function (x) { return S.dms[x] && S.dms[x].name === peerName; });
      if (cand.length === 1) k = cand[0];
    }
    if (k && peerId && k !== peerId) {
      // 旧记录用的是设备号，换成账号键，避免同一会话出现两行
      S.dms[peerId] = S.dms[k]; delete S.dms[k]; k = peerId;
    }
    if (!k && peerId) { k = peerId; S.dms[k] = dmRoomMap(peerId, peerName); }
    if (!k) return null;
    S.dms[k].roomId = roomId;
    S.dms[k].name = S.dms[k].name || peerName;
    if (uid) S.dms[k].uid = Number(uid) || 0;
    return k;
  }
  function dmRoomMap(peerId, peerName) {
    var a = S.deviceId, b = peerId;
    var key = 'dm:' + [a, b].sort().join('|');
    return { roomId: key, peerId: peerId, name: peerName || '私信' };
  }
  function openDM(peerId, peerName) {
    if (!peerId || peerId === S.deviceId) { toast('这是你自己'); return; }
    if (!S.dms[peerId]) {
      S.dms[peerId] = dmRoomMap(peerId, peerName);
      try { localStorage.setItem(LK('dms'), JSON.stringify(S.dms)); } catch (e) {}
    }
    if (peerName && !S.dms[peerId].name) S.dms[peerId].name = peerName;
    renderRooms();
    // 先按本地键打开，收到 pm_history 后用服务端键校正（两边一致，离线消息也能看到）
    openRoom(S.dms[peerId].roomId);
    wsSend({ t: 'pm_open', with: peerId, withName: peerName || '' });
    toast('已打开与 ' + nameOf(peerId, peerName) + ' 的私信');
  }
  // 连接建立后刷新所有私聊，把离线期间的消息拉回来
  function refreshDMs() {
    Object.keys(S.dms || {}).forEach(function (peer) {
      if (peer === LOCAL_PEER) return;      // 本地用户不向服务器登记
      if (peer === AI_PEER) return;         // AI 助手是本机的，不该让服务器去找这个「用户」
      wsSend({ t: 'pm_open', with: peer, withName: S.dms[peer].name || '' });
    });
  }
  function closeRoom() {
    var ch = $('#chat');
    if (ch && !ch.classList.contains('hidden') && !document.documentElement.classList.contains('no-motion')) {
      ch.classList.add('chat-close');
      setTimeout(function () { try { ch.classList.remove('chat-close'); ch.classList.add('hidden'); } catch (e) {} }, 215);
    } else {
      ch.classList.add('hidden');
    }
    S.cur = null;
    try { syncAiModelUi(); } catch (e) {}
    renderRooms();
    showTab(S.tab || 'chats');
    // 底栏是被接回来的，硬切会「啪」一下冒出来：轻轻推上来
    var barEl = $('#tabbar');
    if (barEl && !barEl.classList.contains('hidden')) {
      barEl.classList.remove('bar-in');
      void barEl.offsetWidth;
      barEl.classList.add('bar-in');
      setTimeout(function () { try { barEl.classList.remove('bar-in'); } catch (e) {} }, 380);
    }
  }

  /* ---------------- 发送 ---------------- */
  function autoGrow() {
    var t = $('#text');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 110) + 'px';
  }
  function send() {
    var el = $('#text');
    var text = el.value.replace(/\s+$/, '');
    if (!text || !S.cur) return;
    el.value = ''; autoGrow();
    var tid = 't' + Date.now() + Math.random().toString(36).slice(2, 6);
    var quote = replyTarget ? { id: replyTarget.id, from: replyTarget.from, name: replyTarget.name, text: replyTarget.text } : null;
    var mentions = S.members.filter(function (member) { return member && member.id && text.indexOf('@' + member.name) >= 0; }).map(function (member) { return member.id; });
    var payload = { text: text, tempId: tid, replyTo: quote, mentions: mentions };
    var m = {
      id: tid, tempId: tid, from: S.deviceId || S.me || 'me', name: S.nick || '我',
      text: text, ts: Date.now(), pending: true, replyTo: quote,
      mentions: S.members.filter(function (member) { return mentions.indexOf(member.id) >= 0; })
    };
    addMsg(S.cur, m);
    S.last[S.cur] = { id: tid, text: text, name: '', ts: m.ts }; save();
    clearReply(); renderMentionBox();
    renderMsgs(true); renderRooms();
    // 房间号为空/认不出来时绝不能发：服务器会把它当大厅消息（用户遇到过"发到公共大厅"）
    if (!S.cur || (!isDM(S.cur) && !isGroup(S.cur) && !roomExists(S.cur))) {
      try { aiNormalize(); } catch (e) {}
      toast('这个会话的房间号不对，已自动修复，请重新打开会话再发');
      renderMsgs(false);
      return;
    }
    lastSendPath = (S.cur === AI_RID || aiIsRoom(S.cur)) ? 'ai' : (S.cur === LOCAL_RID ? 'local' : 'server');
    noteSend(lastSendPath, 'cur=' + S.cur, text);
    if (S.cur === AI_RID || aiIsRoom(S.cur)) {
      // 自带 AI 助手：不走服务器，也不占用「本地用户」的 Agent 通道
      var mineAi = null, listA = loadHist(AI_RID);
      for (var ai2 = listA.length - 1; ai2 >= 0; ai2--) if (listA[ai2].id === tid) { mineAi = listA[ai2]; break; }
      if (mineAi) { mineAi.pending = false; saveHist(AI_RID); }
      if (!S.ai || !S.ai.on) { toast('先在「我的 → AI 助手」里开启'); renderMsgs(false); return; }
      renderMsgs(false);
      askAi(text, tid);
      return;
    }
    if (S.cur === LOCAL_RID) {
      // 本地用户：只交给本机 Agent，不走服务器
      var sent = false;
      try { if (window.PaperNative && window.PaperNative.agentSend) { window.PaperNative.agentSend(text); sent = true; } } catch (e) {}
      var list0 = loadHist(LOCAL_RID);
      var mine0 = null;
      for (var li = list0.length - 1; li >= 0; li--) if (list0[li].id === tid) { mine0 = list0[li]; break; }
      if (mine0) { mine0.pending = false; saveHist(LOCAL_RID); }
      if (!sent) toast(S.localAgent.on ? 'Agent 还没连上，先启动你的 astrbot' : '本地用户没有开启');
      renderMsgs(false);
      return;
    }
    var dmPeer = isDM(S.cur) ? dmPeerOf(S.cur) : null;
    var grp = isGroup(S.cur) ? groupOf(S.cur) : null;
    var outPayload = dmPeer ? { t: 'pm', to: dmPeer, text: text, tempId: tid, replyTo: quote }
      : grp ? { t: 'group_msg', id: grp.id, text: text, tempId: tid, replyTo: quote, mentions: mentions }
      : Object.assign({ t: 'msg', room: S.cur }, payload);
    if (!wsSend(outPayload)) {
      queue.push(dmPeer ? { pm: true, to: dmPeer, text: text, tempId: tid, replyTo: quote } : payload);
      toast('没连上服务器，恢复后会自动发出');
    }
  }

  /* ---------------- 提示 ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1900);
  }

  /* ---------------- 主题 ---------------- */
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('paperlite.theme', t || ''); } catch (e) {}
    try { applyChatBg(); } catch (e) {}
    try { renderBeautyPanel(); } catch (e) {}
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  }

  /* ---------------- 皮肤：安卓 16（Material 3 Expressive）/ 小清新 ---------------- */
  function applySkin(k) {
    if (k) S.skin = (k === 'classic') ? 'classic' : 'm3e';
    var v = S.skin || 'm3e';
    document.documentElement.setAttribute('data-skin', v);
    try { localStorage.setItem('paperlite.skin', v); } catch (e) {}
    try { var el = $('#skinState'); if (el) el.textContent = (v === 'm3e') ? '开' : '关'; } catch (e) {}
    try { setTimeout(function () { moveNavPill(false); }, 60); } catch (e) {}
  }
  function toggleSkin() {
    applySkin((S.skin || 'm3e') === 'm3e' ? 'classic' : 'm3e');
    save();
    toast((S.skin === 'm3e') ? '已切到安卓 16 风格' : '已切回小清新');
  }

  /* ---------------- 聊天背景 / 液态玻璃 ---------------- */
  var BG_PRESETS = [
    { key: 'mist',   name: '晨雾', css: 'linear-gradient(165deg,#e9e7ff 0%,#f7e9f6 52%,#e2f4ef 100%)' },
    { key: 'peach',  name: '蜜桃', css: 'linear-gradient(165deg,#ffe6d6 0%,#ffdbe8 55%,#eee0ff 100%)' },
    { key: 'mint',   name: '薄荷', css: 'linear-gradient(165deg,#ddf7ee 0%,#dfedff 55%,#f0e6ff 100%)' },
    { key: 'sakura', name: '樱花', css: 'radial-gradient(120% 90% at 18% 0%,#ffd7e8 0%,transparent 62%), linear-gradient(165deg,#fff0f6 0%,#eee7ff 100%)' },
    { key: 'cream',  name: '奶油', css: 'linear-gradient(165deg,#fff3dd 0%,#ffe6cc 55%,#f2e8ff 100%)' },
    { key: 'dusk',   name: '暮色', dark: true, css: 'linear-gradient(165deg,#1e2130 0%,#241f33 55%,#1b2430 100%)' }
  ];
  function bgPreset(key) {
    for (var i = 0; i < BG_PRESETS.length; i++) if (BG_PRESETS[i].key === key) return BG_PRESETS[i];
    return null;
  }
  function normalizeBg(raw) {
    var defChat = { key: 'mist', image: '', dim: 0.18, blur: 0, imageDark: false };
    var defList = { key: 'none', image: '', dim: 0.12, blur: 0, imageDark: false };
    var b = raw || {};
    if (b.chat || b.list) {
      return { scope: b.scope === 'list' ? 'list' : 'chat',
               chat: Object.assign({}, defChat, b.chat || {}),
               list: Object.assign({}, defList, b.list || {}) };
    }
    // 旧版是扁平的 { key, image, dim } —— 当成聊天页背景迁移过来
    var legacy = (b.key || b.image) ? Object.assign({}, defChat, b) : defChat;
    return { scope: 'chat', chat: legacy, list: Object.assign({}, defList) };
  }
  function bgOf(scope) {
    if (!S.bg) S.bg = normalizeBg(null);
    var key = scope || S.bg.scope || 'chat';
    if (!S.bg.chat || !S.bg.list) S.bg = normalizeBg(S.bg);
    return key === 'list' ? S.bg.list : S.bg.chat;
  }
  function wallFor(cfg) {
    if (!cfg) return { wall: 'none', dark: false, image: false };
    if (cfg.key === 'custom' && cfg.image) return { wall: 'url("' + cfg.image + '")', dark: !!cfg.imageDark, image: true };
    if (cfg.key && cfg.key !== 'none') {
      var p = bgPreset(cfg.key);
      if (p) return { wall: p.css, dark: !!p.dark, image: false };
    }
    return { wall: 'none', dark: false, image: false };
  }
  /* ---------------- M3 角色 → CSS 变量 ---------------- */
  function hexRgba(hex, a) {
    if (!hex || hex.charAt(0) !== '#') return hex;
    var h = hex.slice(1);
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  var M3_VARS = ['--bg','--bg-soft','--chat-bg','--card','--card-2','--in','--text','--in-text','--sub',
    '--line','--stroke','--ring','--accent','--accent-ink','--accent-2','--accent-3',
    '--out-a','--out-b','--out','--out-text','--out-meta','--out-who',
    '--badge-bg','--badge-text','--chip-bg','--chip-text','--danger',
    /* 12.0 安卓 16 皮肤用的角色 */
    '--m3e-primary','--m3e-on-primary','--m3e-primary-container','--m3e-on-primary-container',
    '--m3e-secondary-container','--m3e-on-secondary-container',
    '--m3e-surface','--m3e-surface-1','--m3e-surface-2','--m3e-surface-3',
    '--m3e-on-surface','--m3e-on-variant','--m3e-outline'];
  function isM3Accent(key) { return String(key || '').indexOf('m3-') === 0; }
  function clearM3Vars() {
    var st = document.documentElement.style;
    M3_VARS.forEach(function (n) { st.removeProperty(n); });
  }
  function applyM3Scheme() {
    var key = S.accent || 'periwinkle';
    // 经典主题色：交给 CSS 里的预设，不覆盖
    if (!isM3Accent(key)) { clearM3Vars(); return false; }
    var all = window.M3;
    if (!all) return false;
    var base = key.slice(3);
    var set = all[base] || all.periwinkle;
    if (!set) return false;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var m = set[dark ? 'dark' : 'light'];
    if (!m) return false;
    var r = document.documentElement.style;
    var put = function (name, v) { if (v) r.setProperty(name, v); };

    put('--bg', m.surface);
    put('--bg-soft', m.surfaceContainerLow);
    put('--chat-bg', m.surfaceContainerLow);
    put('--card', m.surfaceContainerLow);
    put('--card-2', m.surfaceContainer);
    put('--in', m.surfaceContainerLow);
    put('--text', m.onSurface);
    put('--in-text', m.onSurface);
    put('--sub', m.onSurfaceVariant);
    put('--line', hexRgba(m.outlineVariant, dark ? 0.55 : 0.75));
    put('--stroke', hexRgba(m.outlineVariant, dark ? 0.5 : 0.7));
    put('--ring', hexRgba(m.primary, 0.28));
    put('--accent', m.primary);
    put('--accent-ink', m.primary);
    put('--accent-2', m.tertiary);
    put('--accent-3', m.tertiaryContainer);
    put('--out-a', m.outA);
    put('--out-b', m.outB);
    put('--out', m.outA);
    put('--out-text', m.onPrimary);
    put('--out-meta', hexRgba(m.onPrimary, 0.8));
    put('--out-who', hexRgba(m.onPrimary, 0.92));
    put('--badge-bg', m.tertiaryContainer);
    put('--badge-text', m.onTertiaryContainer);
    put('--chip-bg', m.secondaryContainer);
    put('--chip-text', m.onSecondaryContainer);
    put('--danger', m.error);

    /* 12.0 皮肤：直接给真实的 M3 角色，层次最准 */
    put('--m3e-primary', m.primary);
    put('--m3e-on-primary', m.onPrimary);
    put('--m3e-primary-container', m.primaryContainer);
    put('--m3e-on-primary-container', m.onPrimaryContainer);
    put('--m3e-secondary-container', m.secondaryContainer);
    put('--m3e-on-secondary-container', m.onSecondaryContainer);
    put('--m3e-surface', m.surface);
    put('--m3e-surface-1', m.surfaceContainerLow);
    put('--m3e-surface-2', m.surfaceContainer);
    put('--m3e-surface-3', m.surfaceContainerHigh);
    put('--m3e-on-surface', m.onSurface);
    put('--m3e-on-variant', m.onSurfaceVariant);
    put('--m3e-outline', hexRgba(m.outlineVariant, dark ? 0.5 : 0.72));
    return true;
  }

  function applyChatBg() {
    try { applyM3Scheme(); } catch (e) {}
    S.bg = normalizeBg(S.bg);
    var root = document.documentElement;

    // 聊天页
    var chat = S.bg.chat, cw = wallFor(chat);
    root.style.setProperty('--chat-wall', cw.wall);
    var cd = Number(chat.dim); if (isNaN(cd)) cd = 0.18;
    var cDark = root.getAttribute('data-theme') === 'dark';
    if (cDark && cw.image) cd = Math.min(0.9, cd + 0.16);
    root.style.setProperty('--chat-wall-dim', 'rgba(' + (cDark ? '12,14,24' : '255,255,255') + ',' + cd.toFixed(2) + ')');
    var cblur = cw.image ? Math.min(40, Number(chat.blur) || 0) : 0;
    root.style.setProperty('--chat-wall-blur', cblur + 'px');
    root.classList.toggle('wall-blur', cblur > 0);

    // 主界面
    var list = S.bg.list, lw = wallFor(list);
    root.style.setProperty('--list-wall', lw.wall);
    var ld = Number(list.dim); if (isNaN(ld)) ld = 0.12;
    if (cDark && lw.image) ld = Math.min(0.9, ld + 0.16);
    root.style.setProperty('--list-wall-dim', 'rgba(' + (cDark ? '12,14,24' : '255,255,255') + ',' + ld.toFixed(2) + ')');

    // 顶栏文字：auto 跟背景走，也可以手动钉死成黑/白
    var mode = S.topbarText || 'auto';
    var wallDark = cw.dark || lw.dark;
    if (mode === 'light') root.setAttribute('data-wall', 'dark');
    else if (mode === 'dark') root.setAttribute('data-wall', 'light');
    else if (cw.wall !== 'none' || lw.wall !== 'none') root.setAttribute('data-wall', wallDark ? 'dark' : 'light');
    else root.removeAttribute('data-wall');

    // 玻璃强度：0–100 → 模糊 4–44px、透明度 .18–.86、色渗 .02–.16
    var lv = (typeof S.glassLevel === 'number') ? S.glassLevel : 55;
    var blur = 4 + lv * 0.40;
    var alpha = 0.18 + lv * 0.0068;
    var tint = 0.02 + lv * 0.0014;
    var sat = 150 + lv * 0.9;              // 150% – 240%
    root.style.setProperty('--row-blur', blur.toFixed(1) + 'px');
    root.style.setProperty('--row-sat', sat.toFixed(0) + '%');
    root.style.setProperty('--row-alpha', alpha.toFixed(3));
    root.style.setProperty('--row-tint', tint.toFixed(3));
    var gl = $('#glassLevel');
    if (gl && Number(gl.value) !== lv) gl.value = String(lv);

    root.classList.toggle('no-glass', !S.glass);
    if (isM3Accent(S.accent)) root.removeAttribute('data-accent');
    else if (S.accent && S.accent !== 'periwinkle') root.setAttribute('data-accent', S.accent);
    else root.removeAttribute('data-accent');
  }

  function setChatBg(key, image, scope) {
    var cfg = bgOf(scope);
    cfg.key = key;
    cfg.image = image || '';
    if (!image) cfg.imageDark = false;
    applyChatBg();
    save();
    renderBeautyPanel();
  }
  function renderBeautyPanel() {
    S.bg = normalizeBg(S.bg);
    var scope = S.bg.scope || 'chat';
    var cfg = bgOf(scope);
    var cur = cfg.key || (scope === 'chat' ? 'mist' : 'none');

    var grid = $('#bgGrid');
    if (grid) {
      var html = BG_PRESETS.map(function (p) {
        return '<button class="bg-chip' + (cur === p.key ? ' on' : '') + '" type="button" data-bg="' + p.key +
               '" style="background-image:' + p.css + '"><span>' + p.name + '</span></button>';
      }).join('');
      if (cfg.image) {
        html += '<button class="bg-chip' + (cur === 'custom' ? ' on' : '') + '" type="button" data-bg="custom" ' +
                'style="background-image:url(\'' + cfg.image + '\')"><span>相册</span></button>';
      }
      html += '<button class="bg-chip' + (cur === 'none' ? ' on' : '') + '" type="button" data-bg="none" ' +
              'style="background:var(--card-2)"><span>纯色</span></button>';
      grid.innerHTML = html;
    }

    var dim = $('#bgDim');
    if (dim) dim.value = String(Math.round((Number(cfg.dim) || (scope === 'chat' ? 0.18 : 0.12)) * 100));
    var bl = $('#bgBlur');
    if (bl) bl.value = String(Number(cfg.blur) || 0);

    var segs = document.querySelectorAll('#bgScope .seg-item');
    Array.prototype.forEach.call(segs, function (b) {
      b.classList.toggle('on', b.getAttribute('data-scope') === scope);
    });

    renderAccentGrid();
    var ts = $('#topbarTextState');
    if (ts) ts.textContent = ({ auto: '自动', light: '白字', dark: '黑字' })[S.topbarText || 'auto'];
    var gs = $('#glassState');
    if (gs) gs.textContent = S.glass ? '开' : '关';
  }
  function renderAccentGrid() {
    var box = $('#accentGrid');
    if (!box) return;
    var cur = S.accent || 'periwinkle';
    function chip(a) {
      return '<button class="accent-chip' + (cur === a.key ? ' on' : '') + '" type="button" data-accent="' + a.key +
             '" style="background-image:' + a.css + '" aria-label="' + a.name + '" title="' + a.name + '"></button>';
    }
    var classic = ACCENTS.filter(function (a) { return !a.m3; });
    var m3 = ACCENTS.filter(function (a) { return a.m3; });
    box.innerHTML =
      '<div class="accent-label">经典</div><div class="accent-row">' + classic.map(chip).join('') + '</div>' +
      '<div class="accent-label">Material 3</div><div class="accent-row">' + m3.map(chip).join('') + '</div>';
  }
  function toggleBeautyPanel(force) {
    var panel = $('#beautyPanel'), arrow = $('#beautyArrow'), btn = $('#btnBeauty');
    if (!panel) return;
    var open = (typeof force === 'boolean') ? force : !panel.classList.contains('open');
    if (open) {
      panel.classList.add('open');
      panel.style.maxHeight = panel.scrollHeight + 40 + 'px';
      renderBeautyPanel();
      setTimeout(function () { try { panel.style.maxHeight = 'none'; } catch (e) {} }, 420);
    } else {
      panel.style.maxHeight = panel.scrollHeight + 'px';
      // 强制一次回流，保证从固定高度过渡到 0
      void panel.offsetHeight;
      panel.classList.remove('open');
      panel.style.maxHeight = '0px';
    }
    if (arrow) arrow.classList.toggle('open', open);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function pickBgImage() {
    var el = $('#bgInput');
    if (el) { el.value = ''; el.click(); }
  }

  var ACCENTS = [
    { key: 'periwinkle', name: '长春花', css: 'linear-gradient(135deg,#6478e8,#7a6ae6)' },
    { key: 'lavender',   name: '薰衣草', css: 'linear-gradient(135deg,#8b6ff0,#a67cf2)' },
    { key: 'sakura',     name: '樱花',   css: 'linear-gradient(135deg,#ef6f97,#f58fb0)' },
    { key: 'peach',      name: '蜜桃',   css: 'linear-gradient(135deg,#f08a5d,#f5a06f)' },
    { key: 'mint',       name: '薄荷',   css: 'linear-gradient(135deg,#3fb39a,#57c9b3)' },
    { key: 'cream',      name: '奶油',   css: 'linear-gradient(135deg,#d9a544,#e8bd6d)' },
    { key: 'm3-periwinkle', name: 'M3 长春花', m3: true, css: 'linear-gradient(135deg,#515b92,#dee0ff)' },
    { key: 'm3-lavender',   name: 'M3 薰衣草', m3: true, css: 'linear-gradient(135deg,#625690,#e7deff)' },
    { key: 'm3-sakura',     name: 'M3 樱花',   m3: true, css: 'linear-gradient(135deg,#8c4a5d,#ffd9e1)' },
    { key: 'm3-peach',      name: 'M3 蜜桃',   m3: true, css: 'linear-gradient(135deg,#8e4d30,#ffdbcd)' },
    { key: 'm3-mint',       name: 'M3 薄荷',   m3: true, css: 'linear-gradient(135deg,#0a6b59,#a1f2dc)' },
    { key: 'm3-cream',      name: 'M3 奶油',   m3: true, css: 'linear-gradient(135deg,#7b580d,#ffdeaa)' }
  ];
  function setAccent(key) {
    S.accent = key || 'periwinkle';
    applyChatBg();
    save();
    renderAccentGrid();
  }

  /* ---------------- 事件绑定 ---------------- */
  // ---------- 头像交互：点击弹菜单，长按快速 @ ----------
  var peerTarget = null;
  function peerInfoFromRow(row) {
    var uid = row.getAttribute('data-uid');
    if (!uid || uid === S.deviceId) return null;
    var id = row.getAttribute('data-id');
    var m = loadHist(S.cur || 'lobby').find(function (x) { return x.id === id; });
    var person = S.people.filter(function (p) { return p.id === uid; })[0];
    return {
      id: uid,
      name: (m && m.name) || (person && person.name) || '对方',
      online: !!person
    };
  }
  function showPeerActions(info) {
    if (!info) return;
    peerTarget = { info: info, remark: S.remarks[info.id] || '' };
    $('#peerAva').textContent = (nameOf(info.id, info.name) || '?').slice(0, 1);
    $('#peerAva').style.background = colorOf(info.id);
    $('#peerName').textContent = nameOf(info.id, info.name);
    $('#peerSub').textContent = S.remarks[info.id]
      ? ('备注：' + S.remarks[info.id] + (info.online ? ' · 在线' : ' · 离线'))
      : (info.online ? '在线' : '离线');
    $('#peerActions').classList.remove('hidden');
    requestAnimationFrame(function () { $('#peerActions').classList.add('open'); });
  }
  function hidePeerActions() {
    $('#peerActions').classList.remove('open');
    setTimeout(function () { $('#peerActions').classList.add('hidden'); }, 200);
  }
  function quickMention(info) {
    if (!info) return;
    var input = $('#text');
    var caret = input.selectionStart == null ? input.value.length : input.selectionStart;
    var name = nameOf(info.id, info.name);
    var needSpace = input.value && !/\s$/.test(input.value.slice(0, caret));
    var insert = (needSpace ? ' ' : '') + '@' + name + ' ';
    input.value = input.value.slice(0, caret) + insert + input.value.slice(input.selectionStart == null ? input.value.length : input.selectionStart);
    var pos = caret + insert.length;
    input.focus(); input.setSelectionRange(pos, pos); autoGrow();
    toast('已 @' + name);
  }

  function bind() {
    // ---------- 登录 / 注册 / 找回 ----------

    function showPane(which) {
      ['Login', 'Register', 'Forgot'].forEach(function (k) {
        $('#pane' + k).classList.toggle('hidden', k !== which);
      });
      $('#tabLogin').classList.toggle('on', which === 'Login');
      $('#tabRegister').classList.toggle('on', which === 'Register');
    }
    on('#tabLogin', 'click', function () { showPane('Login'); });
    on('#tabRegister', 'click', function () { showPane('Register'); });
    on('#btnForgot', 'click', function () {
      showPane('Forgot');
      $('#forgotResult').textContent = '';
    });
    on('#btnForgotBack', 'click', function () { showPane('Login'); });
    on('#forgotMode', 'change', function () {
      var m = $('#forgotMode').value;
      $('#forgotUserWrap').classList.toggle('hidden', m !== 'reset');
      $('#forgotNewPassWrap').classList.toggle('hidden', m !== 'reset');
    });

    on('#btnLogin', 'click', function () {
      var server = normServer($('#inServer').value);
      var user = ($('#inUser').value || '').trim();
      var pass = $('#inPass').value || '';
      if (!user) return toast('填一下用户名');
      if (!pass) return toast('填一下密码');
      if (useServer(server)) toast('已切换到 ' + server);
      else { S.server = server; save(); }
      $('#loginError').classList.add('hidden');
      S.pendingAuth = { kind: 'login', user: user, pass: pass };
      if (!sendAuth(S.pendingAuth)) { /* 连接建立后会补发 */ }
      toast('正在登录…');
    });

    on('#btnRegister', 'click', function () {
      var server = normServer($('#regServer').value);
      var user = ($('#regUser').value || '').trim();
      var nick = ($('#regNick').value || '').trim() || user;
      var pass = $('#regPass').value || '';
      var q = ($('#regQ').value || '').trim();
      var a = ($('#regA').value || '').trim();
      if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,16}$/.test(user)) return toast('用户名要 2–16 位，中文/字母/数字/下划线');
      if (pass.length < 4) return toast('密码至少 4 位');
      if (!q || !a) return toast('密保问题和答案都要填');
      if (useServer(server)) toast('已切换到 ' + server);
      else { S.server = server; save(); }
      $('#regError').classList.add('hidden');
      S.pendingAuth = { kind: 'register', user: user, pass: pass, nick: nick, question: q, answer: a };
      if (!sendAuth(S.pendingAuth)) { /* 连接建立后会补发 */ }
      toast('正在注册…');
    });

    on('#btnForgotGo', 'click', function () {
      var mode = $('#forgotMode').value;
      var answer = ($('#forgotAnswer').value || '').trim();
      if (!answer) return toast('请填写密保答案');
      if (mode === 'reset') {
        var u = ($('#forgotUser').value || '').trim();
        var np = $('#forgotNewPass').value || '';
        if (!u) return toast('请填写用户名');
        if (np.length < 4) return toast('新密码至少 4 位');
        var server = normServer($('#inServer').value);
        if (useServer(server)) { S.server = server; save(); }
        else { S.server = server; save(); }
        S.pendingAuth = { kind: 'resetpass', user: u, answer: answer, pass: np };
        sendAuth(S.pendingAuth);
        return;
      }
      // 忘记用户名：需要先连上服务器，再查询本机绑定过哪些账号
      var server2 = normServer($('#inServer').value);
      if (useServer(server2)) { S.server = server2; save(); }
      else { S.server = server2; save(); }
      if (!connected) { connect(); }
      var tries = 0;
      (function attempt() {
        if (connected) {
          wsSend({ t: 'recover', answer: answer });
        } else if (tries++ < 40) {
          setTimeout(attempt, 200);
        } else {
          toast('连不上服务器');
        }
      })();
    });

    on('#roomList', 'click', function (e) {
      // 点「更多」按钮时交给捕获阶段的处理器，这里直接忽略，别又把聊天打开
      if (e.target.closest && e.target.closest('[data-more]')) { e.stopImmediatePropagation(); return; }
      var li = e.target.closest ? e.target.closest('.room') : null;
      if (!li) return;
      var rid = li.getAttribute('data-room');
      if (rid && rid.indexOf('g:') === 0) openGroup(rid.slice(2));
      else openRoom(rid);
    });

    on('#btnBack', 'click', closeRoom);
    on('#composer', 'submit', function (e) { e.preventDefault(); send(); });

    var ta = $('#text');
    ta.addEventListener('input', function () { autoGrow(); updateMentionQuery(); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { clearReply(); mentionState = null; $('#mentionBox').classList.add('hidden'); }
      if (e.key === 'Enter' && !e.shiftKey) {
        var options = $('#mentionBox').querySelectorAll('.mention-option');
        if (!$('#mentionBox').classList.contains('hidden') && options.length) { e.preventDefault(); options[0].click(); return; }
        e.preventDefault(); send();
      }
    });

    on('#btnMention', 'click', function () {
      var input = $('#text');
      var others = S.members.filter(function (m) { return m && m.id !== S.me && m.id !== S.deviceId; });
      if (!others.length) { toast('这个房间里还没有别的人'); return; }
      var caret = input.selectionStart == null ? input.value.length : input.selectionStart;
      if (input.value.slice(0, caret).slice(-1) !== '@') {
        input.value = input.value.slice(0, caret) + '@' + input.value.slice(caret);
        caret += 1;
      }
      input.focus();
      input.setSelectionRange(caret, caret);
      mentionState = { start: caret - 1, query: '' };
      renderMentionBox();
      autoGrow();
    });
    on('#btnCancelReply', 'click', clearReply);
    on('#mentionBox', 'click', function (e) {
      var option = e.target.closest ? e.target.closest('.mention-option') : null;
      if (option) {
        var member = S.members.find(function (m) { return m.id === option.getAttribute('data-member'); });
        chooseMention(member);
      }
    });

    // 长按消息弹出引用/@/撤回/复制菜单，桌面端双击等同长按
    function openMessageAction(e) {
      var row = e.target.closest ? e.target.closest('.msg') : null;
      if (!row) return;
      var id = row.getAttribute('data-id');
      var m = loadHist(S.cur || 'lobby').find(function (x) { return x.id === id; });
      if (m) showActions(m);
    }
    var pressTimer = null, pressX = 0, pressY = 0, pressTarget = null;
    on('#msgs', 'pointerdown', function (e) {
      var row = e.target.closest ? e.target.closest('.msg') : null;
      if (!row) return;
      // 按在头像上时不弹消息菜单，交给头像自己的手势处理
      if (e.target.closest('.mini-ava')) return;
      pressTarget = e;
      pressX = e.clientX || 0; pressY = e.clientY || 0;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(function () {
        if (pressTarget) openMessageAction(pressTarget);
        pressTarget = null;
      }, 420);
    });
    // 只有明显移动（>12px）才取消，手指轻抖不算
    document.addEventListener('pointermove', function (e) {
      if (!pressTarget) return;
      if (Math.hypot((e.clientX || 0) - pressX, (e.clientY || 0) - pressY) > 12) {
        clearTimeout(pressTimer); pressTarget = null;
      }
    }, true);
    ['pointerup', 'pointercancel', 'scroll'].forEach(function (ev) {
      document.addEventListener(ev, function () { clearTimeout(pressTimer); pressTarget = null; }, true);
    });
    // 语音播放
    var audioEl = null;
    on('#msgs', 'click', function (e) {
      var card = e.target.closest ? e.target.closest('.voice-card') : null;
      if (!card) return;
      var id = card.getAttribute('data-voice');
      var m = loadHist(S.cur || 'lobby').find(function (x) { return x.file === id && x.voice; });
      var src = m ? (String(m.file).indexOf('data:') === 0 ? m.file : httpBase() + m.file) : (id.indexOf('data:') === 0 ? id : httpBase() + id);
      if (!audioEl) audioEl = new Audio();
      if (!audioEl.paused && audioEl.src === src) { audioEl.pause(); card.querySelector('.voice-play').textContent = '▶'; return; }
      audioEl.src = src;
      audioEl.play().then(function () {
        card.querySelector('.voice-play').textContent = '⏸';
      }).catch(function () { toast('这个语音播放不了'); });
      audioEl.ontimeupdate = function () {
        if (!audioEl.duration) return;
        var pct = Math.min(100, (audioEl.currentTime / audioEl.duration) * 100);
        var bar = card.querySelector('.voice-bar i');
        if (bar) bar.style.width = pct + '%';
      };
      audioEl.onended = function () {
        card.querySelector('.voice-play').textContent = '▶';
        var bar = card.querySelector('.voice-bar i');
        if (bar) bar.style.width = '0';
      };
    });

    on('#msgs', 'dblclick', openMessageAction);
    // 点图片放大查看
    on('#msgs', 'click', function (e) {
      var img = e.target.closest ? e.target.closest('.msg-img, .sticker-img') : null;
      if (img && img.getAttribute('src')) openViewer(img.getAttribute('src'));
    });
    // 头像：点击弹菜单（私信/备注/@），长按直接 @
    var avaPressTimer = null, avaPressPoint = null, avaRow = null;
    on('#msgs', 'pointerdown', function (e) {
      var ava = e.target.closest ? e.target.closest('.mini-ava') : null;
      if (!ava) return;
      avaRow = ava.closest('.msg');
      avaPressPoint = { x: e.clientX || 0, y: e.clientY || 0 };
      clearTimeout(avaPressTimer);
      avaPressTimer = setTimeout(function () {
        var info = avaRow && peerInfoFromRow(avaRow);
        if (info) quickMention(info);
        avaRow = null;
        avaLongPressed = true;
      }, 400);
    });
    var avaLongPressed = false;
    document.addEventListener('pointermove', function (e) {
      if (!avaRow || !avaPressPoint) return;
      if (Math.hypot((e.clientX || 0) - avaPressPoint.x, (e.clientY || 0) - avaPressPoint.y) > 12) {
        clearTimeout(avaPressTimer); avaRow = null;
      }
    }, true);
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        clearTimeout(avaPressTimer);
        // 长按已经 @ 过了就不再弹菜单
        if (!avaLongPressed && avaRow && avaPressPoint) {
          var info = peerInfoFromRow(avaRow);
          if (info) showPeerActions(info);
        }
        avaRow = null; avaPressPoint = null;
        setTimeout(function () { avaLongPressed = false; }, 0);
      }, true);
    });
    on('#msgs', 'contextmenu', function (e) { e.preventDefault(); });

    on('#peerCancel', 'click', hidePeerActions);
    on('#peerActions', 'click', function (e) {
      if (e.target === $('.action-scrim') || e.target === $('#peerCancel')) { hidePeerActions(); return; }
      if (!peerTarget) return;
      var info = peerTarget.info;
      if (e.target.closest('#peerDm')) { hidePeerActions(); openDM(info.id, info.name); }
      else if (e.target.closest('#peerMention')) { hidePeerActions(); quickMention(info); }
      else if (e.target.closest('#peerRemark')) { hidePeerActions(); openRemark(info); }
    });
    on('#remarkCancel', 'click', closeRemark);
    on('#remarkSheet', 'click', function (e) {
      if (e.target === $('.action-scrim') || e.target === $('#remarkCancel')) closeRemark();
    });
    on('#remarkSave', 'click', function () {
      if (!peerTarget) return;
      var v = ($('#remarkInput').value || '').trim();
      if (v) S.remarks[peerTarget.info.id] = v.slice(0, 16);
      else delete S.remarks[peerTarget.info.id];
      saveRemarks(); closeRemark();
      renderMsgs(false); renderRooms();
      toast(v ? '备注已更新' : '备注已清除');
    });
    on('#remarkClear', 'click', function () {
      if (!peerTarget) return;
      delete S.remarks[peerTarget.info.id];
      saveRemarks(); closeRemark(); renderMsgs(false); renderRooms();
      toast('备注已清除');
    });
    on('#msgActions', 'click', function (e) {
      if (e.target === $('.action-scrim') || e.target === $('#actionCancel')) { hideActions(); return; }
      if (!selectedMessage) return;
      if (e.target.closest('#actionReply')) { if (!selectedMessage.retracted) setReply(selectedMessage); hideActions(); }
      else if (e.target.closest('#actionMention')) {
        if (!selectedMessage.retracted) {
          var value = $('#text').value;
          $('#text').value = value + (value && !/\s$/.test(value) ? ' ' : '') + '@' + selectedMessage.name + ' ';
          $('#text').focus(); autoGrow();
        }
        hideActions();
      } else if (e.target.closest('#actionRetract')) {
        wsSend({ t: 'retract', id: selectedMessage.id }); hideActions();
      } else if (e.target.closest('#actionSticker')) {
        var sm = selectedMessage;
        if (sm && sm.image) {
          var item = { ref: sm.image, w: sm.w || 0, h: sm.h || 0 };
          var exists = S.stickers.some(function (s) { return s.ref === item.ref; });
          if (!exists) { S.stickers.unshift(item); S.stickers = S.stickers.slice(0, 60); saveStickers(); toast('已加入我的表情'); }
          else toast('这个表情已经收藏过了');
        }
        hideActions();
      } else if (e.target.closest('#actionCopy')) {
        if (!selectedMessage.retracted) copyText(selectedMessage.text); hideActions();
      }
    });

    function openMe() {
      if ($('#meName')) $('#meName').textContent = S.nick || '未登录';
      if ($('#meUser')) $('#meUser').textContent = S.user ? ('账号：' + S.user) : '未登录';
      if ($('#setNick')) $('#setNick').value = S.nick || '';
      if ($('#setServer')) $('#setServer').value = S.server || '';
      if ($('#verLine')) $('#verLine').textContent = '纸鸢 ' + (window.APP_VERSION || '') + ' · ' + (S.user ? ('账号 ' + S.user) : '未登录');
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      $('#mePage').classList.remove('hidden');
    }
    function backToTab() {
      var t = (S.tab && S.tab !== 'me') ? S.tab : 'chats';
      showTab(t);
    }
    function closeMe() { $('#mePage').classList.add('hidden'); backToTab(); }
    function closeMeIfOpen() { $('#mePage').classList.add('hidden'); backToTab(); }
    window.__meOpen = function () { return !$('#mePage').classList.contains('hidden'); };
    on('#btnMe', 'click', function (e) { e.preventDefault(); openMe(); });
    on('#meBack', 'click', closeMe);


    on('#btnSave', 'click', function () {
      var nick = ($('#setNick').value || '').trim();
      var s = normServer($('#setServer').value);
      var switched = useServer(s);
      if (nick) S.nick = nick;
      S.server = s;
      save();
      closeMeIfOpen();
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      connect();
      toast(switched ? '已切换服务器，请登录' : '已保存');
    });
    on('#btnImage', 'click', function () { pickImage(false); });
    on('#btnFile', 'click', pickFile);
    on('#btnVoice', 'click', function () {
      if (recorder) stopVoice(); else startVoice();
    });
    on('#btnSticker', 'click', toggleStickers);
    on('#stickerAdd', 'click', function () { pickImage(true); });
    on('#stickerPanel', 'click', function (e) {
      var tab = e.target.closest ? e.target.closest('.sticker-tab') : null;
      if (tab && tab.id !== 'stickerAdd') {
        Array.prototype.forEach.call(document.querySelectorAll('.sticker-tab:not(.add)'), function (t) { t.classList.toggle('on', t === tab); });
        renderStickerGrid(tab.getAttribute('data-tab'));
        return;
      }
      var emo = e.target.closest ? e.target.closest('[data-emoji]') : null;
      if (emo) { sendEmoji(emo.getAttribute('data-emoji')); return; }
      var st = e.target.closest ? e.target.closest('[data-sticker]') : null;
      if (st) {
        var item = S.stickers[Number(st.getAttribute('data-sticker'))];
        if (item) sendImage(null, item.w || 0, item.h || 0, true, item.ref);
      }
    });
    on('#btnLocalAgent', 'click', function () {
      if ($('#agentOn')) {
        $('#agentOn').checked = !!S.localAgent.on;
        $('#agentPort').value = S.localAgent.port || 6721;
        $('#agentLan').checked = !!S.localAgent.lan;
        if ($('#agentName')) $('#agentName').value = localAgentName();
        renderAgentAvatarPreview();
        refreshAgentStatus();
      }
      $('#agentSheet').classList.remove('hidden');
      requestAnimationFrame(function () { $('#agentSheet').classList.add('open'); });
    });
    /* 滚动跟随动画：滚动时列表轻微斜移 + 纵向拉伸，停下弹性回落。
       只改列表容器上的两个 CSS 变量，不逐行操作，滚动不掉帧。 */
    (function bindScrollAnim() {
      ['#roomList', '#friendList'].forEach(function (sel) {
        var list = $(sel);
        if (!list || list.__scrollAnim) return;
        list.__scrollAnim = true;
        var lastTop = list.scrollTop, lastT = 0, idleTimer = null, raf = 0;
        list.addEventListener('scroll', function () {
          var now = performance.now();
          var top = list.scrollTop;
          var dt = lastT ? Math.max(8, now - lastT) : 16;
          var v = (top - lastTop) / dt;          // px/ms，正=往下滚
          lastTop = top; lastT = now;
          if (raf) return;
          raf = requestAnimationFrame(function () {
            raf = 0;
            var lean = Math.max(-12, Math.min(12, -v * 26));       // 反向斜移感
            var sy = 1 + Math.min(0.035, Math.abs(v) * 0.012);     // 纵向轻微拉伸
            list.classList.add('lean-live');
            list.style.setProperty('--lean-ty', lean.toFixed(2) + 'px');
            list.style.setProperty('--lean-sy', sy.toFixed(4));
          });
          clearTimeout(idleTimer);
          idleTimer = setTimeout(function () {
            list.classList.remove('lean-live');
            list.style.setProperty('--lean-ty', '0px');
            list.style.setProperty('--lean-sy', '1');
          }, 110);
        }, { passive: true });
      });
    })();

    /* 聊天页：消息区滑动动画
       ① 滑动时消息区跟着手指拉伸（scaleY 跟手，停手带回弹），只拉不压——
          压缩会让消息边缘露出底色条，拉伸是从顶部往外长，不会有缝
       ② 已经到顶 / 到底还继续拖：橡皮筋跟着手指走，松手弹回
       ③ 往下翻过 64px 顶栏收起（头像缩、副标题淡出），回到 40px 以内再展开
          ——两个阈值分开，来回翻时不会抖 */
    (function bindChatScrollAnim() {
      var box = $('#msgs');
      if (!box || box.__chatAnim) return;
      box.__chatAnim = true;

      var topBar = document.querySelector('.chat-top');
      var lastTop = box.scrollTop, lastT = 0, idleTimer = null, raf = 0;
      // 打开会话时有一次「落到底部」的程序滚动，那不是用户在翻页：
      // 既不该把顶栏收起，也不该触发跟手位移。第一次真实触摸/滚动之后才算武装。
      var armed = false;
      var MAX_LEAN = 22, MAX_BAND = 120;
      var band = { active: false, dir: 0, startY: 0, edgeY: 0 };

      // 位移一律取整像素：带小数的 translate 会让文字在亚像素上重新栅格化，看着发虚
      function setTy(v) { box.style.setProperty('--flow-ty', Math.round(v) + 'px'); }
      function setLean(v) { box.style.setProperty('--flow-lean', Math.round(v) + 'px'); }
      function live(on) {
        if (on) box.classList.add('flow-live');
        else box.classList.remove('flow-live');
      }
      // 停手：交给 CSS 过渡弹回原位
      function settle() { live(false); setTy(0); setLean(0); }

      // 顶栏：位置滞回，收起和展开各一个阈值
      function syncTopBar() {
        if (!topBar) return;
        var t = box.scrollTop;
        var compact = topBar.classList.contains('compact');
        if (!compact && t > 64) topBar.classList.add('compact');
        else if (compact && t < 40) topBar.classList.remove('compact');
      }

      // 跟手位移：顺着滚动方向甩一下，停手弹回。纯位移，不动缩放，文字始终是清晰的
      function leanOf(v) {
        var k = Math.max(-1, Math.min(1, v / 1.9));
        return -k * MAX_LEAN;
      }

      box.addEventListener('scroll', function () {
        var now = performance.now();
        var t = box.scrollTop;
        var dt = lastT ? Math.max(8, now - lastT) : 16;
        var v = (t - lastTop) / dt;          // px/ms，正=往下翻
        lastTop = t; lastT = now;
        if (!armed) { armed = true; return; }
        syncTopBar();
        if (band.dir) return;                // 橡皮筋期间由手势接管
        if (raf) return;
        raf = requestAnimationFrame(function () {
          raf = 0;
          live(true);
          setTy(0);
          setLean(leanOf(v));
        });
        clearTimeout(idleTimer);
        idleTimer = setTimeout(settle, 130);
      }, { passive: true });

      /* ---- 到顶 / 到底继续拖：橡皮筋 ---- */
      function atTop() { return box.scrollTop <= 2; }
      function atBottom() {
        return box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
      }

      box.addEventListener('touchstart', function (e) {
        armed = true;
        if (!e.touches || e.touches.length !== 1) { band.dir = 0; return; }
        band.active = true; band.dir = 0;
        band.startY = e.touches[0].clientY;
      }, { passive: true });

      box.addEventListener('touchmove', function (e) {
        if (!band.active || !e.touches || e.touches.length !== 1) return;
        var y = e.touches[0].clientY;
        if (!band.dir) {
          var d0 = y - band.startY;
          // 起手方向 + 已经在边上，才接管；否则交给原生滚动。
          // 起点用 touchstart 的位置，接管的这一下就有反馈（不会先空跳一次）
          if (d0 > 0 && atTop()) { band.dir = 1; band.edgeY = band.startY; }
          else if (d0 < 0 && atBottom()) { band.dir = -1; band.edgeY = band.startY; }
          else return;
        }
        var d = (y - band.edgeY) * band.dir;  // 越过边界多远，正数=还在往外拽
        if (d <= 0) {                         // 推回去了：立刻交回正常滚动
          band.dir = 0;
          clearTimeout(idleTimer);
          settle();
          return;
        }
        clearTimeout(idleTimer);
        var pull = Math.min(MAX_BAND, Math.pow(d, 0.82) * 2.4) * band.dir;
        live(true);
        setLean(0);
        setTy(pull);
      }, { passive: true });

      function endBand() {
        band.active = false;
        if (!band.dir) return;
        band.dir = 0;
        clearTimeout(idleTimer);
        // 先留着当前位移，下一帧再归零，才看得到弹回
        requestAnimationFrame(function () {
          live(false);
          setTy(0);
          setLean(0);
        });
      }
      box.addEventListener('touchend', endBand, { passive: true });
      box.addEventListener('touchcancel', endBand, { passive: true });

      // 每次打开聊天页都回到常态（换会话时顶栏要是展开的）
      box.__chatReset = function () {
        band.active = false; band.dir = 0;
        armed = false;
        clearTimeout(idleTimer);
        live(false); setTy(0); setLean(0);
        if (topBar) topBar.classList.remove('compact');
        lastTop = box.scrollTop; lastT = 0;
      };
    })();

    (function bindPullToRefresh() {
      var list = $('#roomList');
      if (!list) return;
      var startY = 0, pulling = false, dy = 0, pullRefreshAt = 0;
      list.addEventListener('touchstart', function (e) {
        // 真机上 scrollTop 常是 0.5 / 1.2 这种小数，卡死 >0 会导致下拉很难触发
        if (list.scrollTop > 4 || !e.touches || !e.touches[0]) return;
        startY = e.touches[0].clientY; pulling = true; dy = 0;
        list.style.transition = 'none';
      }, { passive: true });
      list.addEventListener('touchmove', function (e) {
        if (!pulling || !e.touches || !e.touches[0]) return;
        dy = e.touches[0].clientY - startY;
        if (dy <= 0) {
          dy = 0;
          list.style.setProperty('--pull-ty', '0px');
          list.classList.remove('pulling');
          list.style.setProperty('--pull', '0');
          return;
        }
        // 橡皮筋：起手就有反馈，越拉越沉，上限 120px
        var pull = Math.min(120, Math.pow(dy, 0.78) * 2.6);
        list.style.setProperty('--pull-ty', pull.toFixed(1) + 'px');
        list.classList.add('pulling');
        list.style.setProperty('--pull', pull.toFixed(1));
        // 卡片随拉动整体轻微下沉，越靠下越明显（被往下拽开的感觉）
        var rows = list.querySelectorAll('.room');
        for (var i = 0; i < rows.length; i++) {
          var k = Math.min(i, 8);
          rows[i].style.setProperty('--pull-y', (pull * (1 - k * 0.055)).toFixed(1) + 'px');
        }
      }, { passive: true });
      list.addEventListener('touchend', function () {
        if (!pulling) return;
        pulling = false;
        list.style.setProperty('--pull-ty', '0px');
        // 卡片先弹回原状，再撤掉拉伸状态
        list.style.setProperty('--pull', '0');
        Array.prototype.forEach.call(list.querySelectorAll('.room'), function (r) {
          r.style.setProperty('--pull-y', '0px');
        });
        setTimeout(function () {
          list.classList.remove('pulling');
          list.style.setProperty('--pull', '0');
        }, 340);
        if (dy > 130 && Date.now() - pullRefreshAt > 4000) {
          pullRefreshAt = Date.now();
          toast('正在重新连接…');
          try { if (ws) ws.close(); } catch (e) {}
          try { ws = null; } catch (e) {}
          setTimeout(function () { try { connect(); } catch (e) {} }, 120);
        }
        dy = 0;
      }, { passive: true });
    })();

    on('#btnBeauty', 'click', function () { toggleBeautyPanel(); });
    on('#bgScope', 'click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-scope]') : null;
      if (!b) return;
      S.bg = normalizeBg(S.bg);
      S.bg.scope = b.getAttribute('data-scope') === 'list' ? 'list' : 'chat';
      save();
      renderBeautyPanel();
    });
    on('#bgGrid', 'click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-bg]') : null;
      if (!b) return;
      var key = b.getAttribute('data-bg');
      if (key === 'custom') { pickBgImage(); return; }
      setChatBg(key, '');
    });
    on('#bgPick', 'click', pickBgImage);
    on('#bgInput', 'change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var img = new Image(), url = URL.createObjectURL(f);
      img.onload = function () {
        var max = 1080, w = img.width, h = img.height;
        if (w > max || h > max) { var sc = max / Math.max(w, h); w = Math.round(w * sc); h = Math.round(h * sc); }
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        var dark = false;
        try {
          var ctx = c.getContext('2d');
          var sample = ctx.getImageData(0, 0, w, Math.max(1, Math.round(h * 0.3))).data;
          var sum = 0, n = 0;
          for (var i = 0; i < sample.length; i += 4 * 7) {
            sum += (0.2126 * sample[i] + 0.7152 * sample[i + 1] + 0.0722 * sample[i + 2]) / 255;
            n++;
          }
          dark = n > 0 && (sum / n) < 0.56;
        } catch (err) { dark = false; }
        var q = 0.82, data = c.toDataURL('image/jpeg', q);
        while (data.length > 600000 && q > 0.4) { q -= 0.1; data = c.toDataURL('image/jpeg', q); }
        try { URL.revokeObjectURL(url); } catch (e2) {}
        var cfg = bgOf();
        cfg.imageDark = dark;
        setChatBg('custom', data);
        toast('背景已更新');
      };
      img.onerror = function () { toast('这张图打不开'); };
      img.src = url;
    });
    on('#bgDim', 'input', function (e) {
      var cfg = bgOf();
      cfg.dim = Math.max(0, Math.min(0.9, Number(e.target.value) / 100));
      applyChatBg();
    });
    on('#bgDim', 'change', function () { save(); });
    on('#bgBlur', 'input', function (e) {
      var cfg = bgOf();
      cfg.blur = Math.min(40, Number(e.target.value) || 0);
      applyChatBg();
    });
    on('#bgBlur', 'change', function () { save(); });
    on('#bgReset', 'click', function () {
      var scope = (S.bg && S.bg.scope) || 'chat';
      S.bg = normalizeBg(S.bg);
      if (scope === 'list') S.bg.list = { key: 'none', image: '', dim: 0.12, blur: 0, imageDark: false };
      else S.bg.chat = { key: 'mist', image: '', dim: 0.18, blur: 0, imageDark: false };
      applyChatBg(); save(); renderBeautyPanel();
      toast('已恢复默认背景');
    });
    // 深色 / 浅色：自动 → 深色 → 浅色 循环（这一行之前没绑事件，点了没反应）
    on('#btnTheme', 'click', function () {
      var cur = document.documentElement.getAttribute('data-theme') || '';
      var next = cur === '' ? 'dark' : (cur === 'dark' ? 'light' : '');
      applyTheme(next);
      save();
      var names = { '': '跟随系统', dark: '深色', light: '浅色' };
      toast('主题：' + names[next]);
      try { renderBeautyPanel(); } catch (e) {}
    });
    on('#btnTopbarText', 'click', function () {
      var order = ['auto', 'light', 'dark'];
      var names = { auto: '自动', light: '白字', dark: '黑字' };
      var i = order.indexOf(S.topbarText || 'auto');
      S.topbarText = order[(i + 1) % order.length];
      applyChatBg();
      save();
      var el = $('#topbarTextState');
      if (el) el.textContent = names[S.topbarText];
      toast('顶栏文字：' + names[S.topbarText]);
    });
    on('#glassLevel', 'input', function (e) {
      S.glassLevel = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      applyChatBg();
    });
    on('#glassLevel', 'change', function () { save(); });
    on('#btnGlass', 'click', function () {
      S.glass = !S.glass;
      applyChatBg();
      save();
      var el = $('#glassState');
      if (el) el.textContent = S.glass ? '开' : '关';
      toast(S.glass ? '液态玻璃已开启' : '液态玻璃已关闭（更省电）');
    });
    on('#btnSkin', 'click', function () { toggleSkin(); });
    on('#accentGrid', 'click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-accent]') : null;
      if (!b) return;
      setAccent(b.getAttribute('data-accent'));
      toast('主题色已切换');
    });

    on('#btnAgentUser', 'click', function () {
      renderAgentUserPanel();
      if (window.PaperNative && window.PaperNative.agentUserStatus) {
        try { refreshAgentUserStatus(JSON.parse(window.PaperNative.agentUserStatus() || '{}')); } catch (e) {}
      }
      $('#agentUserSheet').classList.remove('hidden');
      requestAnimationFrame(function () { $('#agentUserSheet').classList.add('open'); });
    });
    on('#agentUserClose', 'click', function () {
      var el = $('#agentUserSheet');
      el.classList.remove('open');
      setTimeout(function () { el.classList.add('hidden'); }, 200);
    });
    on('#agentUserApply', 'click', agentUserApplyFromPanel);
    on('#agentUserRand', 'click', function () {
      var chars = 'abcdefghijkmnpqrstuvwxyz23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      var out = '';
      for (var i = 0; i < 12; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
      if ($('#agentUserPass')) $('#agentUserPass').value = out;
    });
    on('#agentUserAvatarBtn', 'click', function () {
      var el = $('#agentUserAvatarInput');
      if (el) { el.value = ''; el.click(); }
    });
    on('#agentUserAvatarInput', 'change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var img = new Image(), url = URL.createObjectURL(f);
      img.onload = function () {
        var size = 256, c = document.createElement('canvas');
        c.width = size; c.height = size;
        var side = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        try { S.agentUser.avatar = c.toDataURL('image/jpeg', 0.82); } catch (err) { toast('图片处理失败'); }
        try { URL.revokeObjectURL(url); } catch (e2) {}
        renderAgentUserPanel();
        save();
        if (S.agentUser.on) agentUserApplyFromPanel();   // 已开启就直接把新头像推上去
      };
      img.onerror = function () { toast('这张图打不开'); };
      img.src = url;
    });
    on('#agentAvatarBtn', 'click', function () {
      var el = $('#agentAvatarInput');
      if (el) { el.value = ''; el.click(); }
    });
    on('#agentAvatarInput', 'change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var img = new Image(), url = URL.createObjectURL(f);
      img.onload = function () {
        var size = 128, c = document.createElement('canvas');
        c.width = size; c.height = size;
        var side = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        try { S.localAgent.avatar = c.toDataURL('image/jpeg', 0.82); } catch (err) { toast('图片处理失败'); }
        try { URL.revokeObjectURL(url); } catch (e2) {}
        renderAgentAvatarPreview();
        applyAgentProfile();
        save();
        toast('头像已更新');
      };
      img.onerror = function () { toast('这张图打不开'); };
      img.src = url;
    });
    on('#btnAi', 'click', function () {
      aiNormalize();
      renderAiPanel();
      syncAiModelUi();
      var el = $('#aiSheet');
      el.classList.remove('hidden');
      requestAnimationFrame(function () { el.classList.add('open'); });
    });
    on('#aiApply', 'click', function () { aiApply($('#aiOn').checked); });
    on('#aiFetchModels', 'click', function (e) { e.preventDefault(); aiFetchModels(); });
    on('#aiTest', 'click', function (e) { e.preventDefault(); aiTest(); });
    on('#aiDiag', 'click', function (e) { e.preventDefault(); aiDiag(); });
    (function () {
      var box = $('#aiEffort');
      if (!box) return;
      box.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-eff]') : null;
        if (!b) return;
        e.preventDefault();
        if (!S.ai) S.ai = {};
        S.ai.effort = b.getAttribute('data-eff');
        save();
        renderAiPanel();
        var names = { none: '关', low: '低', medium: '中', high: '高' };
        toast('思考强度：' + (names[S.ai.effort] || S.ai.effort));
      });
    })();
    on('#aiRepair', 'click', function (e) { e.preventDefault(); aiRepair(); });
    on('#aiAvatarBtn', 'click', function (e) {
      e.preventDefault();
      var el = $('#aiAvatarInput');
      if (el) { el.value = ''; el.click(); }
    });
    on('#aiAvatarInput', 'change', function (e) {
      var f = e.target.files && e.target.files[0];
      aiPickAvatar(f);
    });
    on('#aiModelFilter', 'input', function () { renderAiModelList(); });
    (function () {
      var box = document.querySelector('#aiSheet .ai-presets');
      if (!box) return;
      box.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-base]') : null;
        if (!b) return;
        e.preventDefault();
        if ($('#aiBase')) $('#aiBase').value = b.getAttribute('data-base');
        var m = b.getAttribute('data-model');
        if (m && $('#aiModel') && !$('#aiModel').value) $('#aiModel').value = m;
        if (S.ai) { S.ai.base = b.getAttribute('data-base'); if (m) S.ai.model = m; }
        renderAiModelList(); syncAiModelUi();
        toast('已填入 ' + b.textContent + ' 的地址');
      });
    })();
    (function () {
      var mlist = $('#aiModelList');
      if (mlist) mlist.addEventListener('click', function (e) {
        var use = e.target.closest ? e.target.closest('[data-cur]') : null;
        if (use) { e.preventDefault(); aiSetCurrent(use.getAttribute('data-cur')); return; }
        var b = e.target.closest ? e.target.closest('[data-model]') : null;
        if (b) { e.preventDefault(); aiToggleModel(b.getAttribute('data-model')); }
      });
      var chip = $('#aiModelChip');
      if (chip) chip.addEventListener('click', function (e) {
        e.preventDefault();
        renderAiPanel(); syncAiModelUi();
        var el = $('#aiSheet');
        if (el) { el.classList.remove('hidden'); requestAnimationFrame(function () { el.classList.add('open'); }); }
      });
    })();
    ['aiBase', 'aiModel', 'aiKey', 'aiName'].forEach(function (fid) {
      var el = $('#' + fid);
      if (el) on('#' + fid, 'click', function (e) { e.preventDefault(); try { el.blur(); } catch (err) {} aiOpenExpand(fid); });
    });
    on('#aiExpandOk', 'click', function () { aiCloseExpand(true); });
    on('#aiExpandCancel', 'click', function () { aiCloseExpand(false); });
    (function () {
      var box = $('#aiExpand');
      if (!box) return;
      var scrim = box.querySelector('.action-scrim');
      if (scrim) scrim.addEventListener('click', function () { aiCloseExpand(false); });
      var wrap = box.querySelector('.ai-inputwrap');
      if (wrap) wrap.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-expand]') : null;
        if (b) aiOpenExpand(b.getAttribute('data-expand'));
      });
    })();
    on('#aiClose', 'click', function () {
      var el = $('#aiSheet');
      el.classList.remove('open');
      setTimeout(function () { el.classList.add('hidden'); }, 200);
    });
    (function () {
      var sheet = $('#aiSheet');
      if (!sheet) return;
      sheet.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-expand]') : null;
        if (b) { e.preventDefault(); aiOpenExpand(b.getAttribute('data-expand')); }
      });
    })();
    on('#agentApply', 'click', function () {
      agentApply($('#agentOn').checked, Number($('#agentPort').value) || 6721, $('#agentLan').checked);
    });
    on('#agentClose', 'click', function () {
      var el = $('#agentSheet');
      el.classList.remove('open');
      setTimeout(function () { el.classList.add('hidden'); }, 200);
    });
    on('#btnStorage', 'click', function () { closeMeIfOpen(); openStorage(); });
    on('#storageBack', 'click', closeStorage);
    on('#storagePage', 'click', function (e) {
      var delChat = e.target.closest ? e.target.closest('[data-del-chat]') : null;
      if (delChat) {
        var id = delChat.getAttribute('data-del-chat');
        try { localStorage.removeItem(histKey(id)); } catch (err) {}
        delete S.msgs[id]; delete S.last[id]; delete S.unread[id];
        save(); renderStorage(); renderRooms();
        if (S.cur === id) renderMsgs(true);
        toast('已清空这个会话');
        return;
      }
      var delOther = e.target.closest ? e.target.closest('[data-del-other]') : null;
      if (delOther) {
        var kind = delOther.getAttribute('data-del-other');
        if (kind === 'stickers') { S.stickers = []; saveStickers(); }
        if (kind === 'remarks') { S.remarks = {}; saveRemarks(); renderMsgs(false); renderRooms(); }
        if (kind === 'config') {
          S.nick = ''; S.server = ''; S.dms = {}; S.last = {}; S.unread = {};
          try { localStorage.removeItem(LK('dms')); localStorage.removeItem(LK('v1')); } catch (err) {}
          save(); renderRooms();
        }
        renderStorage();
        toast('已清理');
      }
    });
    on('#storageAll', 'click', function () {
      conversations().forEach(function (c) { try { localStorage.removeItem(c.key); } catch (e) {} });
      S.msgs = {}; S.last = {}; S.unread = {};
      S.stickers = []; saveStickers();
      S.remarks = {}; saveRemarks();
      S.dms = {}; try { localStorage.removeItem(LK('dms')); } catch (e) {}
      save(); renderStorage(); renderRooms();
      if (S.cur) renderMsgs(true);
      toast('本机数据已全部清空');
    });
    on('#chatAva', 'click', function () {
      if (isGroup(S.cur)) openGroupPanel(S.cur.slice(2));
    });
    on('#gpBack', 'click', closeGroupPanel);
    on('#gpInvite', 'click', openGroupInvite);
    on('#gpList', 'click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-kick]') : null;
      if (!btn || !gpGid) return;
      var who = btn.getAttribute('data-kick');
      if (!wsSend({ t: 'group_kick', id: gpGid, member: who })) { toast('没连上服务器'); return; }
      var g0 = S.groups[gpGid];
      if (g0 && g0.members) g0.members = g0.members.filter(function (id) { return id !== who; });
      renderRooms();
      toast('已移出 ' + nameOf(who, '该成员'));
      setTimeout(function () { if (gpGid) openGroupPanel(gpGid); }, 350);
    });

    on('#btnNewGroup', 'click', function () {
      closeMeIfOpen();
      if (!ws || ws.readyState !== 1) { toast('先连上服务器'); return; }
      wsSend({ t: 'people' });
      openGroupSheet();
    });
    on('#groupCancel', 'click', closeGroupSheet);
    on('#groupSheet', 'click', function (e) {
      if (e.target === $('.action-scrim') || e.target === $('#groupCancel')) { closeGroupSheet(); return; }
      var row = e.target.closest ? e.target.closest('.pick-row') : null;
      if (row) row.classList.toggle('on');
    });
    on('#groupCreate', 'click', createGroup);

    on('#btnLogout', 'click', function () {
      S.auth = false; S.user = ''; S.pendingAuth = null;
      save();
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      connected = false;
      closeMeIfOpen();
      $('#chat').classList.add('hidden');
      S.cur = null;
      $('#loginError').classList.add('hidden');
      if ($('#inUser')) $('#inUser').value = '';
      if ($('#inPass')) $('#inPass').value = '';
      $('#inServer').value = S.server || guessServer();
      $('#setup').classList.remove('hidden');
      showPane && showPane('Login');
      toast('已退出登录，聊天记录还在本机');
    });

    // 单击顶部标题：切换顶栏文字颜色（自动 → 白字 → 黑字）
    try {
      var brandEl = document.querySelector('.brand');
      if (brandEl) {
        brandEl.style.cursor = 'pointer';
        brandEl.addEventListener('click', function () {
          var order = ['auto', 'light', 'dark'];
          var names = { auto: '自动', light: '白字', dark: '黑字' };
          var i = order.indexOf(S.topbarText || 'auto');
          S.topbarText = order[(i + 1) % order.length];
          applyChatBg();
          save();
          try { var el = $('#topbarTextState'); if (el) el.textContent = names[S.topbarText]; } catch (e) {}
          toast('顶栏文字：' + names[S.topbarText]);
        });
      }
    } catch (e) {}
  }

  function setReply(m) {
    replyTarget = { id: m.id, from: m.from, name: m.name || '消息', text: m.text || '' };
    $('#replyName').textContent = replyTarget.name;
    $('#replyText').textContent = replyTarget.text || '消息';
    $('#replyBar').classList.remove('hidden');
    $('#text').focus();
    toast('已引用此消息');
  }
  function clearReply() {
    replyTarget = null;
    $('#replyBar').classList.add('hidden');
  }
  function showActions(m) {
    selectedMessage = m;
    var own = m.from === S.deviceId || m.from === S.me || m.from === 'me' || (!!m.deviceId && m.deviceId === S.deviceId);
    var canRetract = own && !m.retracted && (Date.now() - Number(m.ts || 0) <= 5 * 60 * 1000);
    $('#actionPreview').textContent = m.retracted ? '消息已撤回' : ((m.name ? m.name + '：' : '') + m.text);
    $('#actionReply').disabled = !!m.retracted;
    $('#actionMention').disabled = own || !!m.retracted;
    $('#actionRetract').classList.toggle('hidden', !canRetract);
    $('#actionSticker').classList.toggle('hidden', !(m.image && !m.retracted));
    $('#actionCopy').disabled = !!m.retracted;
    $('#msgActions').classList.remove('hidden');
    requestAnimationFrame(function () { $('#msgActions').classList.add('open'); });
  }
  function hideActions() {
    var layer = $('#msgActions');
    layer.classList.remove('open');
    setTimeout(function () { layer.classList.add('hidden'); }, 220);
  }
  function openRemark(info) {
    if (!peerTarget || !peerTarget.info) peerTarget = { info: info };
    $('#remarkInput').value = S.remarks[info.id] || '';
    $('#remarkSheet').classList.remove('hidden');
    requestAnimationFrame(function () {
      $('#remarkSheet').classList.add('open');
      $('#remarkInput').focus();
    });
  }
  function closeRemark() {
    $('#remarkSheet').classList.remove('open');
    setTimeout(function () { $('#remarkSheet').classList.add('hidden'); }, 200);
  }

  function chooseMention(member) {
    if (!mentionState || !member) return;
    var input = $('#text');
    var before = input.value.slice(0, mentionState.start);
    var after = input.value.slice(input.selectionStart);
    input.value = before + '@' + member.name + ' ' + after;
    var pos = before.length + member.name.length + 2;
    input.focus(); input.setSelectionRange(pos, pos);
    mentionState = null; $('#mentionBox').classList.add('hidden'); autoGrow();
  }
  function renderMentionBox() {
    var box = $('#mentionBox');
    if (!mentionState || !S.cur) { box.classList.add('hidden'); return; }
    var query = mentionState.query.toLowerCase();
    var members = S.members.filter(function (m) {
      return m && m.id !== S.me && m.id !== S.deviceId && (!query || m.name.toLowerCase().indexOf(query) >= 0);
    }).slice(0, 6);
    if (!members.length) {
      box.innerHTML = '<div class="mention-empty">房间里还没有别的人，等有人进来再 @</div>';
      box.classList.remove('hidden');
      return;
    }
    box.innerHTML = members.map(function (m) {
      return '<button type="button" class="mention-option" data-member="' + esc(m.id) + '"><span class="mention-avatar" style="background:' + colorOf(m.id) + '">' + esc((m.name || '?').slice(0, 1)) + '</span><span>' + esc(m.name) + '</span><small>提及</small></button>';
    }).join('');
    box.classList.remove('hidden');
  }
  function updateMentionQuery() {
    var input = $('#text'), caret = input.selectionStart || 0;
    var left = input.value.slice(0, caret), match = /(?:^|\s)@([^\s@]*)$/.exec(left);
    if (!match) { mentionState = null; $('#mentionBox').classList.add('hidden'); return; }
    mentionState = { start: caret - match[1].length - 1, query: match[1] };
    renderMentionBox();
  }

  /* ---------------- 图片与表情 ---------------- */
  var EMOJIS = ['😀','😂','🥲','😊','😍','😘','😎','🤔','😅','😭','😡','🥳',
                '😴','🤯','🤗','😏','🙃','😇','🤤','😬','👍','👏','🙏','💪',
                '🔥','🎉','❤️','💔','✨','🌚','🐱','🐶','🍜','☕','🎮','🚀'];
  function httpBase() {
    var s = S.server || '';
    return s.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/+$/, '');
  }
  function imgSrc(m) {
    if (!m || !m.image) return '';
    if (/^data:/.test(m.image)) return m.image;
    if (/^https?:/.test(m.image)) return m.image;
    return httpBase() + m.image;
  }
  function loadStickers() {
    try { S.stickers = JSON.parse(localStorage.getItem('paperlite.stickers') || '[]') || []; }
    catch (e) { S.stickers = []; }
  }
  function saveStickers() {
    try { localStorage.setItem('paperlite.stickers', JSON.stringify(S.stickers)); } catch (e) {}
  }
  function sendImage(dataUrl, w, h, asSticker, ref) {
    if (!S.cur) return;
    var tid = 'i' + Date.now() + Math.random().toString(36).slice(2, 6);
    var dmPeer = isDM(S.cur) ? dmPeerOf(S.cur) : null;
    var grpImg = isGroup(S.cur) ? groupOf(S.cur) : null;
    var m = {
      id: tid, tempId: tid, from: S.deviceId, name: S.nick || '我', ts: Date.now(),
      pending: true, image: dataUrl || ref, w: w, h: h, sticker: !!asSticker, text: ''
    };
    addMsg(S.cur, m);
    S.last[S.cur] = { id: tid, text: asSticker ? '[表情]' : '[图片]', name: '', ts: m.ts };
    save(); renderMsgs(true); renderRooms();
    var payload = { t: 'img', tempId: tid, w: w, h: h, sticker: !!asSticker };
    if (ref) payload.ref = ref; else payload.data = dataUrl;
    if (dmPeer) payload.to = dmPeer;
    if (grpImg) { payload.gid = grpImg.id; }
    if (!wsSend(payload)) toast('没连上服务器，图片没发出去');
  }
  function pickImage(asSticker) {
    var input = $('#fileInput');
    if (!input) return;
    input.value = '';
    input.setAttribute('accept', 'image/*');
    input.onchange = function () {
      var f = input.files && input.files[0];
      if (f) compressImage(f, asSticker);
    };
    input.click();
  }
  function compressImage(file, asSticker) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var max = asSticker ? 512 : 1280;
      var w = img.width, h = img.height;
      if (w > max || h > max) { var s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      var q = 0.72, data = cv.toDataURL('image/jpeg', q);
      while (data.length > 330000 && q > 0.35) { q -= 0.1; data = cv.toDataURL('image/jpeg', q); }
      try { URL.revokeObjectURL(url); } catch (e) {}
      sendImage(data, w, h, asSticker);
    };
    img.onerror = function () { toast('这张图读不了'); };
    img.src = url;
  }
  function sendEmoji(emoji) {
    if (!S.cur) return;
    var tid = 'e' + Date.now() + Math.random().toString(36).slice(2, 6);
    var dmPeer = isDM(S.cur) ? dmPeerOf(S.cur) : null;
    var m = { id: tid, tempId: tid, from: S.deviceId, name: S.nick || '我', text: emoji, ts: Date.now(), pending: true, big: true };
    addMsg(S.cur, m);
    S.last[S.cur] = { id: tid, text: emoji, name: '', ts: m.ts }; save();
    renderMsgs(true); renderRooms();
    var payload = { text: emoji, tempId: tid, big: true };
    wsSend(dmPeer ? Object.assign({ t: 'pm', to: dmPeer }, payload) : Object.assign({ t: 'msg' }, payload));
  }
  function renderStickerGrid(tab) {
    var grid = $('#stickerGrid');
    if (!grid) return;
    if (tab === 'mine') {
      if (!S.stickers.length) {
        grid.innerHTML = '<div class="sticker-empty">还没有收藏。长按别人发的图片可以存成表情。</div>';
        return;
      }
      grid.innerHTML = S.stickers.map(function (st, i) {
        return '<button class="sticker-cell" type="button" data-sticker="' + i + '"><img src="' + esc(httpBase() + st.ref) + '" alt=""></button>';
      }).join('');
      return;
    }
    grid.innerHTML = EMOJIS.map(function (e) {
      return '<button class="sticker-cell" type="button" data-emoji="' + esc(e) + '">' + e + '</button>';
    }).join('');
  }
  function toggleStickers() {
    var p = $('#stickerPanel');
    var show = p.classList.contains('hidden');
    p.classList.toggle('hidden', !show);
    if (show) renderStickerGrid('emoji');
    $('#btnSticker').classList.toggle('on', show);
  }

  /* ---------------- 存储管理 ---------------- */
  function keySize(key) {
    try {
      var v = localStorage.getItem(key);
      return v ? (key.length + v.length) * 2 : 0;
    } catch (e) { return 0; }
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function conversations() {
    var list = [];
    S.rooms.forEach(function (r) { list.push({ key: histKey(r.id), id: r.id, name: r.name, emoji: r.emoji }); });
    Object.keys(S.dms).forEach(function (peerId) {
      var d = S.dms[peerId];
      list.push({ key: histKey(d.roomId), id: d.roomId, name: nameOf(peerId, d.name || '私信'), emoji: '👤' });
    });
    return list;
  }
  function countMsgs(key) {
    try { return (JSON.parse(localStorage.getItem(key) || '[]') || []).length; } catch (e) { return 0; }
  }
  function renderStorage() {
    var chats = conversations();
    var chatTotal = 0;
    chats.forEach(function (c) { chatTotal += keySize(c.key); });
    var stickerSize = keySize('paperlite.stickers');
    var remarkSize = keySize(LK('remarks'));
    var confSize = keySize(LK('v1')) + keySize(LK('dms'));
    var all = chatTotal + stickerSize + remarkSize + confSize;

    $('#storageSummary').innerHTML =
      '<div class="storage-card"><b>' + fmtBytes(all) + '</b><span>本机占用</span></div>' +
      '<div class="storage-card"><b>' + fmtBytes(chatTotal) + '</b><span>聊天记录</span></div>' +
      '<div class="storage-card"><b>' + fmtBytes(stickerSize) + '</b><span>表情收藏</span></div>';

    $('#storageChats').innerHTML = chats.map(function (c) {
      var size = keySize(c.key), n = countMsgs(c.key);
      return '<div class="storage-row"><div class="s-main"><div class="s-name">' + esc(c.emoji + ' ' + c.name) + '</div>' +
        '<div class="s-meta">' + n + ' 条 · ' + fmtBytes(size) + '</div></div>' +
        '<button class="s-del" type="button" data-del-chat="' + esc(c.id) + '"' + (n ? '' : ' disabled') + '>清空</button></div>';
    }).join('') || '<div class="storage-row"><div class="s-main"><div class="s-meta">还没有聊天记录</div></div></div>';

    $('#storageOthers').innerHTML =
      '<div class="storage-row"><div class="s-main"><div class="s-name">表情收藏</div><div class="s-meta">' +
        S.stickers.length + ' 个 · ' + fmtBytes(stickerSize) + '</div></div>' +
        '<button class="s-del" type="button" data-del-other="stickers"' + (S.stickers.length ? '' : ' disabled') + '>清空</button></div>' +
      '<div class="storage-row"><div class="s-main"><div class="s-name">备注</div><div class="s-meta">' +
        Object.keys(S.remarks).length + ' 人 · ' + fmtBytes(remarkSize) + '</div></div>' +
        '<button class="s-del" type="button" data-del-other="remarks"' + (Object.keys(S.remarks).length ? '' : ' disabled') + '>清空</button></div>' +
      '<div class="storage-row"><div class="s-main"><div class="s-name">昵称与服务器设置</div><div class="s-meta">' + fmtBytes(confSize) + '</div></div>' +
        '<button class="s-del" type="button" data-del-other="config">重置</button></div>';
  }
  function openStorage() {
    renderStorage();
    $('#storagePage').classList.remove('hidden');
  }
  function closeStorage() { $('#storagePage').classList.add('hidden'); }

  /* ---------------- 群聊 ---------------- */
  function isGroup(rid) { return !!rid && rid.indexOf('g:') === 0; }
  function groupOf(rid) { return S.groups[(rid || '').replace(/^g:/, '')] || null; }
  function groupRoom(g) {
    return { id: 'g:' + g.id, name: g.name || '群聊', emoji: '👥', color: '#7c5cff', isGroup: true, gid: g.id };
  }
  function mergeGroups(list) {
    (list || []).forEach(function (g) {
      S.groups[g.id] = g;
    });
    // 已不在的群要清掉
    var alive = {};
    (list || []).forEach(function (g) { alive[g.id] = 1; });
    Object.keys(S.groups).forEach(function (id) {
      if (!alive[id] && S.groups[id] && S.groups[id].owner !== S.deviceId) delete S.groups[id];
    });
    renderRooms();
  }
  function openGroup(gid) {
    var g = S.groups[gid];
    if (!g) return;
    var rid = 'g:' + gid;
    S.cur = rid;
    S.unread[rid] = 0; save(); renderRooms();
    showJumpButton(rid);
    paintChatAva(rid);
    $('#chatAva').setAttribute('data-group-open', gid);
    $('#chatName').textContent = g.name;
    $('#chatSub').textContent = (g.members ? g.members.length : 0) + ' 人';
    $('#chat').classList.remove('hidden');
    $('#tabbar').classList.add('hidden');
    syncPinBtn();
    syncComposer();
    renderMsgs(true);
    wsSend({ t: 'group_open', id: gid });
  }
  function openGroupSheet() {
    // 好友优先：用 uid: 账号身份，离线也能拉进群；再补在线但非好友的人
    var rows = [], seen = {};
    (S.friends || []).forEach(function (f) {
      if (!f || !f.uid) return;
      var key = 'uid:' + f.uid;
      if (key === S.myId || seen[key]) return;
      seen[key] = 1;
      rows.push({ id: key, name: f.name || ('用户' + f.uid), tag: f.online ? '好友 · 在线' : '好友 · 离线' });
    });
    (S.people || []).forEach(function (p) {
      if (!p || p.id === S.deviceId || seen[p.id]) return;
      var nm = nameOf(p.id, p.name);
      if (rows.some(function (r) { return r.name === nm; })) return;
      seen[p.id] = 1;
      rows.push({ id: p.id, name: nm, tag: '在线' });
    });
    var box = $('#groupMembers');
    if (!rows.length) {
      box.innerHTML = '<div class="pick-empty">还没有可拉的人：先把对方加成好友，或等 TA 上线</div>';
    } else {
      box.innerHTML = rows.map(function (r) {
        return '<div class="pick-row" data-pick="' + esc(r.id) + '">' +
          '<div class="pick-ava" style="background:' + colorOf(r.id) + '">' + esc(r.name.slice(0, 1)) + '</div>' +
          '<div class="pick-name">' + esc(r.name) + (r.tag ? '<span class="pick-tag">' + r.tag + '</span>' : '') + '</div>' +
          '<div class="pick-check">✓</div></div>';
      }).join('');
    }
    $('#groupName').value = '';
    $('#groupSheet').classList.remove('hidden');
    requestAnimationFrame(function () { $('#groupSheet').classList.add('open'); });
  }
  function closeGroupSheet() {
    $('#groupSheet').classList.remove('open');
    setTimeout(function () { $('#groupSheet').classList.add('hidden'); }, 180);
  }
  function createGroup() {
    var inviteMode = $('#groupSheet').classList.contains('invite-mode');
    if (inviteMode && gpGid) {
      var picked2 = [];
      Array.prototype.forEach.call($('#groupMembers').querySelectorAll('.pick-row.on'), function (row) {
        picked2.push(row.getAttribute('data-pick'));
      });
      if (!picked2.length) { toast('先勾选要拉的人'); return; }
      if (!wsSend({ t: 'group_invite', id: gpGid, members: picked2 })) { toast('没连上服务器'); return; }
      $('#groupSheet').classList.remove('invite-mode');
      closeGroupSheet();
      toast('已发出邀请');
      setTimeout(function () { if (gpGid) openGroupPanel(gpGid); }, 400);
      return;
    }
    var name = ($('#groupName').value || '').trim();
    if (!name) { toast('给群起个名字'); return; }
    var picked = [];
    Array.prototype.forEach.call($('#groupMembers').querySelectorAll('.pick-row.on'), function (row) {
      picked.push(row.getAttribute('data-pick'));
    });
    if (!wsSend({ t: 'group_create', name: name, members: picked })) { toast('没连上服务器'); return; }
    closeGroupSheet();
    toast('群已创建');
  }

  // 群成员管理（群主可拉人 / 踢人）
  var gpGid = null;
  function openGroupPanel(gid) {
    var g = S.groups[gid];
    if (!g) return;
    gpGid = gid;
    var isOwner = g.owner === S.deviceId;
    $('#gpTitle').textContent = g.name + '（' + g.members.length + ' 人）';
    $('#gpInvite').classList.toggle('hidden', !isOwner);
    $('#gpHint').textContent = isOwner ? '你是群主：可以拉人、踢人' : '只有群主能拉人和踢人';
    var rows = (g.members || []).map(function (id) {
      var person = (S.people || []).filter(function (p) { return p.id === id; })[0];
      var nm = nameOf(id, person ? person.name : (id === S.deviceId ? S.nick : '成员'));
      var tag = id === g.owner ? '<span class="gp-tag">群主</span>' : '';
      var kick = (isOwner && id !== g.owner)
        ? '<button class="s-del" type="button" data-kick="' + esc(id) + '">移出</button>' : '';
      return '<div class="storage-row"><div class="pick-ava" style="background:' + colorOf(id) + '">' +
        esc(nm.slice(0, 1)) + '</div><div class="s-main"><div class="s-name">' + esc(nm) + tag +
        '</div><div class="s-meta">' + (person ? '在线' : '离线') + '</div></div>' + kick + '</div>';
    }).join('');
    $('#gpList').innerHTML = rows || '<p class="hint">还没有成员</p>';
    $('#groupPanel').classList.remove('hidden');
  }
  function closeGroupPanel() { $('#groupPanel').classList.add('hidden'); gpGid = null; }
  window.__gpOpen = function () { return !$('#groupPanel').classList.contains('hidden'); };
  function openGroupInvite() {
    var g = S.groups[gpGid];
    if (!g) return;
    if (g.owner !== S.deviceId) { toast('只有群主可以拉人'); return; }
    var others = (S.people || []).filter(function (p) {
      return p && p.id !== S.deviceId && g.members.indexOf(p.id) < 0;
    });
    if (!others.length) { toast('没有可拉的人了'); return; }
    $('#groupMembers').innerHTML = others.map(function (p) {
      return '<div class="pick-row" data-pick="' + esc(p.id) + '">' +
        '<div class="pick-ava" style="background:' + colorOf(p.id) + '">' + esc(nameOf(p.id, p.name).slice(0, 1)) + '</div>' +
        '<div class="pick-name">' + esc(nameOf(p.id, p.name)) + '</div>' +
        '<div class="pick-check">✓</div></div>';
    }).join('');
    $('#groupName').value = g.name;
    $('#groupSheet').classList.remove('hidden');
    $('#groupSheet').classList.add('open', 'invite-mode');
    requestAnimationFrame(function () { $('#groupSheet').classList.add('open'); });
  }

  /* ---------------- 图片放大查看 ---------------- */
  var viewScale = 1, viewX = 0, viewY = 0, pinch = null, dragStart = null, lastTap = 0;
  function applyView(animated) {
    var img = $('#viewerImg');
    img.classList.toggle('zooming', !!animated);
    img.style.transform = 'translate(' + viewX + 'px,' + viewY + 'px) scale(' + viewScale + ')';
  }
  function openViewer(src) {
    if (!src) return;
    viewScale = 1; viewX = 0; viewY = 0;
    $('#viewerImg').src = src;
    $('#imgViewer').classList.remove('hidden');
    applyView(false);
    $('#viewerHint').textContent = '双指缩放 · 双击放大';
  }
  function closeViewer() {
    $('#imgViewer').classList.add('hidden');
    $('#viewerImg').src = '';
  }
  function zoomTo(s) {
    var max = 5, min = 1;
    var clamped = Math.max(min, Math.min(max, s));
    if (clamped === 1) { viewX = 0; viewY = 0; }
    viewScale = clamped;
    applyView(true);
    $('#viewerHint').textContent = viewScale > 1 ? '可拖动查看 · 双击还原' : '双指缩放 · 双击放大';
  }
  function bindViewer() {
    var viewer = $('#imgViewer');
    on('#viewerClose', 'click', closeViewer);
    viewer.addEventListener('click', function (e) {
      if (e.target === viewer) closeViewer();
    });
    // 双击放大 / 还原
    on('#viewerImg', 'click', function (e) {
      e.stopPropagation();
      var now = Date.now();
      if (now - lastTap < 300) { zoomTo(viewScale > 1 ? 1 : 2.4); lastTap = 0; }
      else lastTap = now;
    });
    // 双指缩放 + 单指拖动
    viewer.addEventListener('pointerdown', function (e) {
      viewer.setPointerCapture && viewer.setPointerCapture(e.pointerId);
      if (pinch && pinch.id1 !== e.pointerId) {
        pinch.id2 = e.pointerId; pinch.d0 = pinch.d1 = Math.hypot(pinch.x1 - pinch.x2, pinch.y1 - pinch.y2);
        pinch.s0 = viewScale;
      } else if (!pinch) {
        pinch = { id1: e.pointerId, x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY };
        dragStart = viewScale > 1 ? { x: e.clientX - viewX, y: e.clientY - viewY } : null;
      }
    });
    viewer.addEventListener('pointermove', function (e) {
      if (!pinch) return;
      if (e.pointerId === pinch.id1) { pinch.x1 = e.clientX; pinch.y1 = e.clientY; }
      if (e.pointerId === pinch.id2) { pinch.x2 = e.clientX; pinch.y2 = e.clientY; }
      if (pinch.id2) {
        var d = Math.hypot(pinch.x1 - pinch.x2, pinch.y1 - pinch.y2);
        if (pinch.d0 > 0) zoomTo(pinch.s0 * (d / pinch.d0));
      } else if (dragStart && viewScale > 1) {
        viewX = e.clientX - dragStart.x;
        viewY = e.clientY - dragStart.y;
        applyView(false);
      }
    });
    function endPointer(e) {
      if (!pinch) return;
      if (pinch.id2 && e.pointerId === pinch.id2) { pinch.id2 = null; pinch.d0 = 0; return; }
      if (e.pointerId === pinch.id1) { pinch = null; dragStart = null; }
    }
    viewer.addEventListener('pointerup', endPointer);
    viewer.addEventListener('pointercancel', endPointer);
    // 桌面滚轮
    viewer.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomTo(viewScale * (e.deltaY > 0 ? 0.9 : 1.1));
    }, { passive: false });
  }

  /* ---------------- 文件与语音 ---------------- */
  function fileKind(name, mime) {
    var n = (name || '').toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp)$/.test(n) || /^image\//.test(mime || '')) return { icon: '🖼', tip: '图片' };
    if (/\.(pdf)$/.test(n)) return { icon: '📕', tip: 'PDF' };
    if (/\.(zip|rar|7z|tar|gz)$/.test(n)) return { icon: '🗜', tip: '压缩包' };
    if (/\.(mp4|mov|mkv|avi)$/.test(n)) return { icon: '🎬', tip: '视频' };
    if (/\.(mp3|wav|m4a|ogg|aac)$/.test(n)) return { icon: '🎵', tip: '音频' };
    if (/\.(docx?)$/.test(n)) return { icon: '📄', tip: '文档' };
    if (/\.(xlsx?|csv)$/.test(n)) return { icon: '📊', tip: '表格' };
    if (/\.(apk)$/.test(n)) return { icon: '📦', tip: '安装包' };
    if (/\.(txt|md|json|js|css|html)$/.test(n)) return { icon: '📝', tip: '文本' };
    return { icon: '📎', tip: '文件' };
  }
  function fmtBytes2(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function downloadUrl(m) {
    if (!m.file) return '#';
    if (String(m.file).indexOf('data:') === 0) return m.file;
    if (/^https?:/.test(m.file)) return m.file;
    return httpBase() + m.file + '?name=' + encodeURIComponent(m.fileName || 'file') + '&dl=1';
  }
  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }
  function pickFile() {
    var input = $('#docInput');
    if (!input) return;
    input.value = '';
    input.onchange = function () {
      var f = input.files && input.files[0];
      if (f) sendFile(f);
    };
    input.click();
  }
  var UPLOAD_LIMIT = 50 * 1024 * 1024;
  var PART_BYTES = 400 * 1024;      // 每片原始字节，base64 后约 540KB，不超单帧上限
  function uploadInParts(file, extra) {
    return readAsDataURL(file).then(function (dataUrl) {
      // 去掉 data URL 里的编解码参数（audio/webm;codecs=opus），服务端只认纯 mime
      dataUrl = String(dataUrl).replace(/^data:([^;,]+)(;[^,]*)?;base64,/, 'data:$1;base64,');
      var base64 = String(dataUrl).split(',')[1] || '';
      if (base64.length <= 600 * 1024) return dataUrl;   // 小文件直接一次发
      var id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      return new Promise(function (resolve, reject) {
        var seq = 0, offset = 0;
        var totalParts = Math.ceil(base64.length / (PART_BYTES * 1.34));
        var sendNext = function () {
          if (offset >= base64.length) {
            wsSend(Object.assign({ t: 'file_end', id: id }, extra));
            resolve(null);
            return;
          }
          var slice = base64.slice(offset, offset + Math.round(PART_BYTES * 1.34));
          offset += slice.length;
          var m = Object.assign({ t: 'file_part', id: id, seq: seq++, data: slice }, extra);
          if (!wsSend(m)) { reject(new Error('disconnected')); return; }
          setTimeout(sendNext, 30);
        };
        if (!wsSend(Object.assign({ t: 'file_start', id: id, size: file.size }, extra))) {
          reject(new Error('disconnected'));
          return;
        }
        setTimeout(sendNext, 60);
      });
    });
  }
  // 统一发送：小文件一次发，大文件走分片
  function deliverFile(file, meta) {
    var tid = meta.tid;
    var dmPeer = isDM(S.cur) ? dmPeerOf(S.cur) : null;
    var extra = { name: meta.name, size: file.size, mime: meta.mime, tempId: tid };
    if (meta.voice) { extra.voice = true; extra.duration = meta.duration; }
    if (dmPeer) extra.to = dmPeer;
    var grpFile = isGroup(S.cur) ? groupOf(S.cur) : null;
    if (grpFile) extra.gid = grpFile.id;

    var m = {
      id: tid, tempId: tid, from: S.deviceId, name: S.nick || '我', text: '', ts: Date.now(),
      pending: true, file: meta.preview, fileName: meta.name, fileSize: file.size,
      mime: meta.mime, voice: !!meta.voice, duration: meta.duration || 0
    };
    addMsg(S.cur, m);
    S.last[S.cur] = { id: tid, text: meta.voice ? '[语音]' : '[文件] ' + meta.name, name: '', ts: m.ts };
    save(); renderMsgs(true); renderRooms();

    uploadInParts(file, extra).then(function (dataUrl) {
      if (dataUrl) {
        // 小文件：直接一次发出去
        var payload = Object.assign({ t: 'file', data: dataUrl }, extra);
        if (!wsSend(payload)) toast('没连上服务器，发送失败');
      }
    }).catch(function () { toast('发送中断，检查网络'); });
  }
  function sendFile(file) {
    if (!S.cur) return;
    if (file.size > UPLOAD_LIMIT) { toast('文件超过 50 MB'); return; }
    toast('正在发送 ' + file.name);
    var tid = 'f' + Date.now() + Math.random().toString(36).slice(2, 6);
    var mime = file.type || '';
    deliverFile(file, {
      tid: tid, name: file.name || '文件', mime: mime,
      preview: '', voice: false
    });
  }

  /* ---------------- 语音：自己采 PCM 生成 WAV，不依赖编码器 ---------------- */
  var recCtx = null, recStream = null, recProc = null, recGain = null;
  var recChunks = [], recStart = 0, recTimer = null, recRate = 16000;

  function voiceSupported() {
    return !!(window.AudioContext || window.webkitAudioContext) && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  }

  // 浮点采样 -> 16k 单声道 16bit PCM 的 WAV
  function encodeWav(chunks, inRate, outRate) {
    var total = 0, i, j;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var merged = new Float32Array(total);
    var o = 0;
    for (i = 0; i < chunks.length; i++) { merged.set(chunks[i], o); o += chunks[i].length; }

    // 重采样到 outRate
    var ratio = inRate / outRate;
    var outLen = Math.max(1, Math.floor(merged.length / ratio));
    var res = new Int16Array(outLen);
    for (i = 0; i < outLen; i++) {
      var pos = i * ratio;
      var idx = Math.floor(pos);
      var frac = pos - idx;
      var a = merged[idx] || 0;
      var b = merged[idx + 1] !== undefined ? merged[idx + 1] : a;
      var v = a + (b - a) * frac;
      v = Math.max(-1, Math.min(1, v));
      res[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }

    var dataSize = outLen * 2;
    var buf = new ArrayBuffer(44 + dataSize);
    var dv = new DataView(buf);
    function wstr(off, str) { for (var k = 0; k < str.length; k++) dv.setUint8(off + k, str.charCodeAt(k)); }
    wstr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, outRate, true); dv.setUint32(28, outRate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    wstr(36, 'data'); dv.setUint32(40, dataSize, true);
    var off = 44;
    for (i = 0; i < outLen; i++) { dv.setInt16(off, res[i], true); off += 2; }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function startVoice() {
    if (!voiceSupported()) { toast('这个系统不支持录音'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      recStream = stream;
      var AC = window.AudioContext || window.webkitAudioContext;
      recCtx = new AC();
      recRate = recCtx.sampleRate;
      recChunks = [];
      var source = recCtx.createMediaStreamSource(stream);
      recProc = recCtx.createScriptProcessor(4096, 1, 1);
      recGain = recCtx.createGain();
      recGain.gain.value = 0;              // 静音，避免回授
      recProc.onaudioprocess = function (e) {
        recChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(recProc);
      recProc.connect(recGain);
      recGain.connect(recCtx.destination);

      recStart = Date.now();
      $('#recordingBar').classList.remove('hidden');
      $('#btnVoice').classList.add('on');
      var tick = function () {
        var s = Math.round((Date.now() - recStart) / 1000);
        $('#recTime').textContent = '录音中 ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
        if (s >= 60) { stopVoice(); return; }
        recTimer = setTimeout(tick, 500);
      };
      tick();
    }).catch(function (err) {
      var nm = err && err.name ? err.name : '';
      if (nm === 'NotAllowedError') toast('麦克风被拒绝：去系统设置给纸鸢开麦克风权限');
      else if (nm === 'NotFoundError') toast('没找到麦克风设备');
      else toast('录音启动失败：' + (nm || '未知错误'));
    });
  }

  function stopVoice() {
    clearTimeout(recTimer);
    $('#recordingBar').classList.add('hidden');
    $('#btnVoice').classList.remove('on');
    if (!recCtx) return;
    var ctx = recCtx, rate = recRate, chunks = recChunks;
    recCtx = null; recChunks = [];
    try { if (recProc) recProc.disconnect(); } catch (e) {}
    try { if (recGain) recGain.disconnect(); } catch (e) {}
    try { if (recStream) recStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { ctx.close(); } catch (e) {}
    var secs = Math.max(1, Math.round((Date.now() - recStart) / 1000));
    if (!chunks.length) { toast('没录到声音'); return; }
    var blob = encodeWav(chunks, rate, 16000);
    sendVoice(blob, secs);
  }

  function sendVoice(blob, secs) {
    if (!S.cur) return;
    var tid = 'v' + Date.now() + Math.random().toString(36).slice(2, 6);
    var preview = URL.createObjectURL ? URL.createObjectURL(blob) : '';
    deliverFile(blob, {
      tid: tid, name: '语音-' + secs + 's.wav', mime: 'audio/wav',
      preview: preview, voice: true, duration: secs
    });
  }

  // 统一发送：小文件一次发，大文件走分片
  function deliverFile(file, meta) {
    var tid = meta.tid;
    var dmPeer = isDM(S.cur) ? dmPeerOf(S.cur) : null;
    var extra = { name: meta.name, size: file.size, mime: meta.mime, tempId: tid };
    if (meta.voice) { extra.voice = true; extra.duration = meta.duration; }
    if (dmPeer) extra.to = dmPeer;
    var grpFile = isGroup(S.cur) ? groupOf(S.cur) : null;
    if (grpFile) extra.gid = grpFile.id;

    var m = {
      id: tid, tempId: tid, from: S.deviceId, name: S.nick || '我', text: '', ts: Date.now(),
      pending: true, file: meta.preview, fileName: meta.name, fileSize: file.size,
      mime: meta.mime, voice: !!meta.voice, duration: meta.duration || 0
    };
    addMsg(S.cur, m);
    S.last[S.cur] = { id: tid, text: meta.voice ? '[语音]' : '[文件] ' + meta.name, name: '', ts: m.ts };
    save(); renderMsgs(true); renderRooms();

    uploadInParts(file, extra).then(function (dataUrl) {
      if (dataUrl) {
        // 小文件：直接一次发出去
        var payload = Object.assign({ t: 'file', data: dataUrl }, extra);
        if (!wsSend(payload)) toast('没连上服务器，发送失败');
      }
    }).catch(function () { toast('发送中断，检查网络'); });
  }
  function sendFile(file) {
    if (!S.cur) return;
    if (file.size > UPLOAD_LIMIT) { toast('文件超过 50 MB'); return; }
    toast('正在发送 ' + file.name);
    var tid = 'f' + Date.now() + Math.random().toString(36).slice(2, 6);
    var mime = file.type || '';
    deliverFile(file, {
      tid: tid, name: file.name || '文件', mime: mime,
      preview: '', voice: false
    });
  }

  /* ---------------- 语音 ---------------- */
  var recorder = null, recChunks = [], recStart = 0, recTimer = null;
  function voiceSupported() {
    return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  function startVoice() {
    if (!voiceSupported()) { toast('这个系统不支持录音'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      recChunks = [];
      var mime = '';
      try {
        if (typeof MediaRecorder.isTypeSupported === 'function') {
          if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
          else if (MediaRecorder.isTypeSupported('audio/webm')) mime = 'audio/webm';
          else if (MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4';
          else if (MediaRecorder.isTypeSupported('audio/aac')) mime = 'audio/aac';
        }
      } catch (e) { mime = ''; }
      try { recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) {
        try { recorder = new MediaRecorder(stream); }
        catch (e2) { toast('这台设备不支持录音编码'); stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      }
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        // stopVoice() 会把全局 recorder 置空，这里必须用局部引用，否则读 mimeType 会抛错
        var rec = recorder;
        recorder = null;
        var secs = Math.max(1, Math.round((Date.now() - recStart) / 1000));
        var chunks = (recChunks && recChunks.length) ? recChunks : [];
        if (!chunks.length) { toast('没录到声音，请重试'); return; }
        var type = (rec && rec.mimeType) || (chunks[0] && chunks[0].type) || 'audio/webm';
        var blob = new Blob(chunks, { type: type });
        sendVoice(blob, secs);
      };
      recStart = Date.now();
      recorder.start();
      $('#recordingBar').classList.remove('hidden');
      $('#btnVoice').classList.add('on');
      var tick = function () {
        var s = Math.round((Date.now() - recStart) / 1000);
        $('#recTime').textContent = '录音中 ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
        if (s >= 60) { stopVoice(); return; }
        recTimer = setTimeout(tick, 500);
      };
      tick();
    }).catch(function (err) {
      var nm = err && err.name ? err.name : '';
      if (nm === 'NotAllowedError') toast('麦克风被拒绝：去系统设置给纸鸢开麦克风权限');
      else if (nm === 'NotFoundError') toast('没找到麦克风设备');
      else toast('录音启动失败：' + (nm || '未知错误'));
    });
  }
  function stopVoice() {
    clearTimeout(recTimer);
    $('#recordingBar').classList.add('hidden');
    $('#btnVoice').classList.remove('on');
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (e) { recorder = null; }
    }
  }
  function sendVoice(blob, secs) {
    if (!S.cur) return;
    var tid = 'v' + Date.now() + Math.random().toString(36).slice(2, 6);
    var bt = blob.type || '';
    var ext = bt.indexOf('mp4') >= 0 ? 'm4a' : (bt.indexOf('aac') >= 0 ? 'aac' : 'webm');
    var preview = URL.createObjectURL ? URL.createObjectURL(blob) : '';
    deliverFile(blob, {
      tid: tid, name: '语音-' + secs + 's.' + ext, mime: blob.type || 'audio/webm',
      preview: preview, voice: true, duration: secs
    });
  }

  function copyText(txt) {
    if (!txt) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('已复制'); }, function () { fallbackCopy(txt); });
    } else fallbackCopy(txt);
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败'); }
    document.body.removeChild(ta);
  }

  // 交给原生返回键用
  window.PaperBack = function () {
    if (!$('#imgViewer').classList.contains('hidden')) { closeViewer(); return true; }
    if (!$('#storagePage').classList.contains('hidden')) { closeStorage(); return true; }
    if (window.__meOpen && window.__meOpen()) { closeMeIfOpen(); return true; }
    if (!$('#msgActions').classList.contains('hidden')) { hideActions(); return true; }
    if (!$('#peerActions').classList.contains('hidden')) { hidePeerActions(); return true; }
    if (!$('#chat').classList.contains('hidden')) { closeRoom(); return true; }
    return false;
  };

  /* ---------------- 启动 ---------------- */
  /* ---------------- 新建对话 ---------------- */
  var roomTarget = null;
  // 对方账号 ID：会话键可能是设备号，尽量换算出 uid
  function uidOfPeer(peer, rid) {
    if (!peer) return 0;
    if (peer.indexOf('uid:') === 0) return Number(peer.slice(4)) || 0;
    var d = S.dms[peer];
    if (d && d.uid) return Number(d.uid) || 0;
    var f = (S.friends || []).filter(function (x) { return x && (x.pm === peer || x.dev === peer || ('uid:' + x.uid) === peer); })[0];
    if (f && f.uid) return Number(f.uid) || 0;
    var nm = (d && d.name) || (rid ? room(rid).name : '');
    if (nm) {
      var g = (S.friends || []).filter(function (x) { return x && x.name === nm; })[0];
      if (g && g.uid) return Number(g.uid) || 0;
    }
    return 0;
  }
  function friendByPeer(peer) {
    var uid = uidOfPeer(peer);
    if (uid) return friendOf(uid) || null;
    return null;
  }
  // 删除：好友私聊=移除会话并解除好友；群聊=退群
  function removeRoom(rid) {
    if (rid === LOCAL_RID) {
      try { localStorage.removeItem(histKey(rid)); } catch (e) {}
      delete S.last[rid]; delete S.unread[rid];
      if (S.pins[rid]) delete S.pins[rid];
      S.cur = null; $('#chat').classList.add('hidden');
      save(); renderRooms(); showTab('chats');
      toast('已清空本地聊天记录（会话保留）');
      return;
    }
    var peer = isDM(rid) ? dmPeerOf(rid) : null;
    var gid = rid.indexOf('g:') === 0 ? rid.slice(2) : null;
    var msg = '已删除';
    if (gid && S.groups[gid]) {
      wsSend({ t: 'group_leave', id: gid });
      delete S.groups[gid];
      msg = '已退出群聊';
    } else if (peer) {
      var frm = friendByPeer(peer);
      if (frm && frm.uid) { wsSend({ t: 'contact_remove', uid: Number(frm.uid) }); msg = '已删除会话并移除好友'; }
      delete S.dms[peer];
      try { localStorage.removeItem(LK('dms')); localStorage.setItem(LK('dms'), JSON.stringify(S.dms)); } catch (e) {}
    }
    if (S.pins[rid]) delete S.pins[rid];
    delete S.last[rid]; delete S.unread[rid]; delete S.unreadAt[rid]; delete S.mentionAt[rid];
    try { localStorage.removeItem(histKey(rid)); } catch (e) {}
    S.cur = null;
    $('#chat').classList.add('hidden');
    save(); renderRooms(); showTab('chats');
    toast(msg);
  }
  // 拉黑：好友→contact_block；群→group_block
  function blockRoom(rid) {
    var peer = isDM(rid) ? dmPeerOf(rid) : null;
    var gid = rid.indexOf('g:') === 0 ? rid.slice(2) : null;
    if (gid) {
      wsSend({ t: 'group_block', id: gid });
      delete S.groups[gid];
      delete S.pins[rid];
      S.cur = null; $('#chat').classList.add('hidden');
      renderRooms(); showTab('chats');
      toast('已拉黑该群');
      return;
    }
    if (!peer) {
      // 会话键可能对不上（换过设备/迁移过），退一步按 uid: 前缀匹配
      var keys = Object.keys(S.dms || {});
      for (var i = 0; i < keys.length; i++) {
        if (S.dms[keys[i]].roomId === rid) { peer = keys[i]; break; }
      }
    }
    if (!peer) { toast('这个会话不能拉黑'); return; }
    var uid = uidOfPeer(peer, rid);
    if (!uid) { toast('没有对方的账号 ID，无法拉黑（对方可能是临时会话）'); return; }
    wsSend({ t: 'contact_block', uid: uid });
    delete S.dms[peer];
    delete S.pins[rid];
    S.cur = null; $('#chat').classList.add('hidden');
    save(); renderRooms(); showTab('chats');
    toast('已拉黑，对方不能再加你或给你发消息');
  }
  // 允许 ws:// wss:// http:// https:// 或裸地址；自动补协议与默认端口
  function normServer(v) {
    var s = (v || '').trim();
    if (!s) return DEFAULT_SERVER || '';
    s = s.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
    if (!/^wss?:\/\//i.test(s)) s = 'ws://' + s;
    s = s.replace(/\/+$/, '');
    var m = /^(ws:\/\/)([^\/:]+)(:\d+)?/i.exec(s);
    if (m && !m[3]) s = m[1] + m[2] + ':8080' + s.slice(m[1].length + m[2].length);
    return s;
  }

  // 切换服务器：把当前这套存好，切命名空间，然后按新服务器重新读状态
  function useServer(server) {
    var target = server || DEFAULT_SERVER;
    if (srvTagOf(target) === srvTag) { S.server = target; save(); return false; }
    try { save(); } catch (e) {}
    try { localStorage.setItem(LK('dms'), JSON.stringify(S.dms || {})); } catch (e) {}
    setCurrentServer(target);
    S.auth = false; S.token = ''; S.uid = 0; S.user = ''; S.nick = '';
    S.dms = {}; S.groups = {}; S.rooms = ROOMS_DEFAULT.slice(); S.last = {}; S.unread = {};
    S.pins = {}; S.friends = []; S.avatars = {}; S.myAvatar = ''; S.remarks = {}; S.cur = null;
    S.server = target;
    load(); loadRemarks();
    try { S.dms = JSON.parse(localStorage.getItem(LK('dms')) || '{}') || {}; } catch (e) { S.dms = {}; }
    S.server = target;
    renderRooms();
    try { if ($('#setup')) $('#setup').classList.toggle('hidden', !!S.auth); } catch (e) {}
    return true;
  }

  function openBlockPage() {
    wsSend({ t: 'blocked_list' });
    $('#mePage').classList.add('hidden');
    $('#blockPage').classList.remove('hidden');
  }
  function openRoomSheet(rid) {
    if (!rid) return;
    roomTarget = rid;
    var r = room(rid);
    var gid = rid.indexOf('g:') === 0;
    var dm = isDM(rid);
    var fixed = (S.rooms || []).some(function (x) { return x && x.id === rid; });
    $('#roomSheetTitle').textContent = r.name || '会话';
    $('#roomPin').innerHTML = '<span>📌</span>' + (S.pins[rid] ? '取消置顶' : '置顶');
    syncMuteBtn();
    var rm = $('#roomRemove'), bk = $('#roomBlock');
    if (rm) {
      rm.classList.toggle('hidden', fixed);
      rm.innerHTML = gid ? '<span>🗑</span>退出群聊' : '<span>🗑</span>删除会话';
    }
    var isLocalConv = (rid === LOCAL_RID);
    if (bk) {
      bk.classList.toggle('hidden', fixed || isLocalConv || (!dm && !gid));
      bk.innerHTML = gid ? '<span>🚫</span>拉黑该群' : '<span>🚫</span>拉黑对方';
    }
    $('#roomSheet').classList.remove('hidden');
    requestAnimationFrame(function () { $('#roomSheet').classList.add('open'); });
  }
  function closeRoomSheet() {
    var el = $('#roomSheet');
    el.classList.remove('open');
    setTimeout(function () { el.classList.add('hidden'); }, 200);
    roomTarget = null;
  }

  function openDmSheet() {
    var others = (S.people || []).filter(function (p) {
      return p && p.id !== S.deviceId && p.id !== S.me;
    });
    $('#dmList').innerHTML = others.length ? others.map(function (p) {
      return '<div class="pick-row" data-dm="' + esc(p.id) + '">' +
        '<div class="pick-ava" style="background:' + colorOf(p.id) + '">' + esc(nameOf(p.id, p.name).slice(0, 1)) + '</div>' +
        '<div class="pick-name">' + esc(nameOf(p.id, p.name)) + '</div></div>';
    }).join('') : '<p class="hint">还没有其他人上线过</p>';
    $('#dmSheet').classList.remove('hidden');
    requestAnimationFrame(function () { $('#dmSheet').classList.add('open'); });
  }
  function closeDmSheet() {
    var el = $('#dmSheet');
    el.classList.remove('open');
    setTimeout(function () { el.classList.add('hidden'); }, 200);
  }
  function syncComposer() {
    var has = !!($('#text').value || '').trim();
    var v = $('#btnVoice'), snd = $('#btnSend');
    if (v) v.classList.toggle('hidden', has);
    if (snd) snd.classList.toggle('hidden', !has);
  }

  /* ---------------- 版本检查 / 线上更新 ---------------- */
  var MY_CODE = 36;
  function nativeCode() {
    try { if (window.PaperNative && window.PaperNative.versionCode) return Number(window.PaperNative.versionCode()) || MY_CODE; } catch (e) {}
    return MY_CODE;
  }
  function checkVersion() {
    wsSend({ t: 'version_check', code: nativeCode() });
    webVersionCheck();
  }
  // 登录页还没连 WS，也能查版本：直接打 HTTP /version
  // ws(s):// / http(s):// / 裸地址 都能转成 http(s) 基地址
  function toHttpBase(s) {
    var t = String(s || '').trim().replace(/\/+$/, '');
    if (!t) return '';
    t = t.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
    if (!/^wss?:\/\//i.test(t)) t = 'ws://' + t;
    var m = /^(wss?):\/\/([^\/:]+)(?::(\d+))?/i.exec(t);
    if (!m) return '';
    return (m[1].toLowerCase() === 'wss:' ? 'https://' : 'http://') + m[2] + (m[3] ? ':' + m[3] : '');
  }
  function serverHttpBase() {
    return toHttpBase(OFFICIAL_SERVER) || toHttpBase(S.server) || toHttpBase(guessServer());
  }
  // 原生回调（空串表示原生失败，转网页 fetch 兜底）
  window.__updateResult = function (json) {
    if (!json) { webVersionCheck(); return; }
    window.__updateInfo(json);
  };

  // 原生直接 HTTP 查版本（不受 WebView 跨域限制），结果回传到这里
  window.__updateInfo = function (json) {
    try {
      if (typeof json === 'string') json = json.replace(/^"|"$/g, '').replace(/\\"/g, '"');
      var v = typeof json === 'string' ? JSON.parse(json) : json;
      if (!v || !v.code) return;
      checkDone = checkSeq;
      blog('版本检查(原生): 服务器 ' + v.name + ' / 本机 ' + nativeCode());
      var nowManual = !!window.__manualCheck;
      if (Number(v.code) > nativeCode()) {
        var info = { name: v.name, notes: v.notes, code: v.code, url: v.url || (serverHttpBase() + '/download/apk') };
        if (nowManual) { showUpdate(info); toast('发现新版本 ' + (v.name || '')); }
        else { remindUpdate(info); }
      } else {
        clearUpdateBadge();
        var ub = $('#updateSheet');
        if (ub && ub.classList.contains('open')) closeUpdate();
        if (nowManual) toast('已是最新版本 ' + (v.name || nativeCode()));
      }
      window.__manualCheck = false;
      if (window.__checkFinish) { try { window.__checkFinish(); } catch (e) {} }
    } catch (e) { blog('更新信息解析失败'); }
  };

  var checkSeq = 0, checkDone = 0, checkJob = null;
  function runVersionCheck(manual) {
    var base = serverHttpBase();
    if (!base) { if (manual) toast('这台设备没有配置更新服务器'); return; }
    if (manual) toast('正在检查更新…');
    window.__manualCheck = !!manual;
    var my = ++checkSeq;
    var job = { done: false, manual: !!manual, seq: my };
    checkJob = job;
    function finish(ok, via) {
      if (job.done) return;
      job.done = true;
      if (checkJob === job) checkJob = null;
      window.__manualCheck = false;
      if (ok) { blog('版本检查完成: ' + (via || '')); return; }
      blog('版本检查失败: ' + (via || '超时'));
      if (job.manual) toast('检查失败，请检查网络或服务器');
    }
    // 原生或网页任一路拿到结果都算成功，不再重复报错
    window.__checkFinish = function () { if (checkJob === job) finish(true, 'result'); };
    try {
      if (window.PaperNative && window.PaperNative.checkUpdate) {
        window.PaperNative.checkUpdate(base);
        // 原生慢的话 3 秒后补一次网页查询（两条路谁先回来算谁）
        setTimeout(function () { if (!job.done) webVersionCheck(); }, 3000);
        // 9 秒内两条路都没结果，才算失败
        setTimeout(function () { finish(false, 'timeout'); }, 9000);
        return;
      }
    } catch (e) {}
    webVersionCheck();
    setTimeout(function () { finish(false, 'timeout'); }, 7000);
  }

  function webVersionCheck() {
    var base = serverHttpBase();
    if (!base || !window.fetch) return;
    fetch(base + '/version', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) {
      checkDone = checkSeq;
      if (window.__checkFinish) { try { window.__checkFinish(); } catch (e) {} }
      if (!v || !v.code) return;
      if (Number(v.code) > nativeCode()) {
        var info2 = { name: v.name, notes: v.notes, code: v.code, url: v.url || (base + '/download/apk') };
        if (window.__manualCheck) showUpdate(info2); else remindUpdate(info2);
      } else {
        clearUpdateBadge();
        var ub2 = $('#updateSheet');
        if (ub2 && ub2.classList.contains('open')) closeUpdate();
      }
    }).catch(function () {
      // 网页这条被跨域拦下不算失败：等原生那条，实在都没有才由超时兜底
      blog('网页查版本失败（file:// 跨域属正常）');
    });
  }
  var updAutoKey = '';      // 本次启动已经提醒过的版本
  var updDismissedKey = ''; // 本次启动用户点了「以后再说」的版本
  function updKey(info) { return String((info && (info.code || info.name)) || ''); }
  function showUpdate(info) {
    var box = $('#updateSheet');
    if (!box) return;
    var cur = window.APP_VERSION || '';
    $('#updTitle').textContent = '发现新版本 ' + (info.name || '');
    $('#updNotes').textContent = (info.notes || '修复了一些问题，建议更新。') +
      (cur ? '（你当前是 ' + cur + '）' : '');
    if ($('#updHint')) $('#updHint').textContent = '';
    box.classList.remove('hidden');
    requestAnimationFrame(function () { box.classList.add('open'); });
    window.__upd = info;
    markUpdateSeen(info);
  }
  // 自动提醒（登录/连上服务器/回到前台时）：可关闭，且本次启动不重复弹
  function remindUpdate(info) {
    if (!info) return;
    var k = updKey(info);
    if (!k) return;
    if (updDismissedKey === k) return;
    if (updAutoKey === k) return;
    updAutoKey = k;
    showUpdate(info);
  }
  // 「我的」里把「检查更新」标出来，没弹窗也看得见
  function markUpdateSeen(info) {
    try {
      var btn = $('#btnCheckUpdate');
      if (!btn) return;
      var k = updKey(info);
      if (!k) return;
      var exists = btn.querySelector('.me-badge');
      if (!exists) {
        var b = document.createElement('span');
        b.className = 'me-badge';
        btn.insertBefore(b, btn.querySelector('.me-arrow') || null);
        exists = b;
      }
      exists.textContent = '有新版本 ' + (info.name || '');
    } catch (e) {}
  }
  function clearUpdateBadge() {
    try { var b = $('#btnCheckUpdate'); var e = b && b.querySelector('.me-badge'); if (e) e.parentNode.removeChild(e); } catch (err) {}
  }
  function closeUpdate() {
    var b = $('#updateSheet');
    if (!b) return;
    var k = updKey(window.__upd);
    if (k) updDismissedKey = k;
    b.classList.remove('open');
    setTimeout(function () { b.classList.add('hidden'); }, 200);
  }
  function updateLater() { closeUpdate(); }
  function doUpdate() {
    var info = window.__upd || {};
    var url = info.url || '';
    if (!url) { toast('服务器没给下载地址'); return; }
    // 有原生桥就交给系统下载器（下完点通知即可安装），否则浏览器打开
    try {
      if (window.PaperNative && window.PaperNative.downloadApk) {
        window.PaperNative.downloadApk(url);
        toast('开始下载，下完点通知安装');
        closeUpdate();
        return;
      }
    } catch (e) {}
    try { window.open(url, '_blank'); } catch (e) { toast('打开下载页失败'); }
  }

  /* ---------------- 通知 / 未读跳转 ---------------- */
  function nativeOn() { return !!(window.PaperNative && window.PaperNative.notify); }
  function webNotifOn() {
    return !nativeOn() && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  }
  function appVisible() { return !document.hidden; }
  // 我会被 @ 的所有写法
  function isMentioned(m) {
    var me = (S.nick || '').trim();
    var myUser = (S.user || '').trim();
    var mentions = m.mentions || [];
    for (var i = 0; i < mentions.length; i++) {
      var t = mentions[i] && mentions[i].name ? mentions[i].name : mentions[i];
      if (t && (t === me || t === myUser)) return true;
    }
    var text = String(m.text || '');
    if (me && text.indexOf('@' + me) >= 0) return true;
    if (myUser && text.indexOf('@' + myUser) >= 0) return true;
    return false;
  }
  function roomTitle(rid) {
    if (isDM(rid)) return room(rid).name || '私信';
    return room(rid).name || '聊天';
  }
  // 免打扰：这个会话被静音时，不弹通知、不响铃，但未读照常累计
  function isMuted(rid) { return !!(S.mutes && S.mutes[rid]); }
  function setMuted(rid, on) {
    if (!rid) return;
    if (on) S.mutes[rid] = Date.now(); else delete S.mutes[rid];
    save(); renderRooms();
    if (S.cur === rid) syncMuteBtn();
  }
  function syncMuteBtn() {
    var b = $('#roomMute');
    if (b) b.innerHTML = '<span>🔕</span>' + (S.mutes[roomTarget] ? '取消免打扰' : '免打扰');
  }
  // 好友申请通知
  var seenPending = null;
  function checkFriendRequests(pendingIn) {
    var list = pendingIn || [];
    if (seenPending === null) { seenPending = list.length; return; }   // 首次同步不提醒
    var prev = seenPending;
    seenPending = list.length;
    if (list.length <= prev) return;
    var newest = list[list.length - 1] || list[0];
    var who = (newest && (newest.name || ('用户' + newest.uid))) || '有人';
    if (appVisible()) { toast(who + ' 请求加你为好友'); return; }
    if (!nativeOn()) return;
    try {
      if (window.PaperNative.notifyEx) window.PaperNative.notifyEx('好友申请', who + ' 请求加你为好友', 'friend', 'contacts', 'friend');
      else window.PaperNative.notify('好友申请', who + ' 请求加你为好友', 'friend', 'contacts');
    } catch (e) {}
  }
  function notifyMessage(rid, m) {
    var at = isMentioned(m);
    var from = m.name || (m.deviceId ? '有人' : roomTitle(rid));
    var title = isDM(rid) ? from : roomTitle(rid);
    var body = (at ? from + ' @了你：' : (isDM(rid) ? '' : from + '：')) + (m.text || '[消息]');
    var jump = (at ? 'at:' : 'unread:') + rid + (m.id ? ('#' + m.id) : '');
    var kind = at ? 'mention' : 'msg';

    if (isMuted(rid)) {
      // 免打扰：只累未读，不打扰
      if (appVisible() && (S.cur !== rid || $('#chat').classList.contains('hidden'))) { /* 静默 */ }
      return;
    }

    if (!appVisible() && nativeOn()) {
      try {
        if (window.PaperNative.notifyEx) window.PaperNative.notifyEx(title, body, 'room-' + rid, jump, kind);
        else window.PaperNative.notify(title, body, 'room-' + rid, jump);
      } catch (e) {}
      if (at && window.PaperNative.vibrate) { try { window.PaperNative.vibrate(180); } catch (e) {} }
      return;
    }
    if (!appVisible() && webNotifOn()) {
      try {
        var n = new Notification(title, { body: body, tag: 'room-' + rid });
        n.onclick = function () { window.focus(); jumpToMessage(rid, at ? S.mentionAt[rid] : S.unreadAt[rid]); };
      } catch (e) {}
      return;
    }
    // 网页在前台但不在这个会话里：App 内提示
    if (S.cur !== rid || $('#chat').classList.contains('hidden')) {
      toast(at ? (from + ' @了你') : (title + '：' + (m.text || '[消息]')));
    }
  }
  // 记录“第一条未读”和“最近的 @ 位置”，供跳转使用
  function markUnread(rid, m) {
    if (!S.unreadAt[rid]) S.unreadAt[rid] = m.id || null;
    if (isMentioned(m)) S.mentionAt[rid] = m.id || null;
  }
  // 跳到某个会话里的某条消息，并高亮
  function jumpToMessage(rid, msgId) {
    if (!rid) return;
    if (isDM(rid)) {
      var peer = dmPeerOf(rid);
      S.dms[peer] = S.dms[peer] || dmRoomMap(peer, room(rid).name);
    }
    openRoom(rid);
    setTimeout(function () {
      var box = $('#msgs');
      var el = msgId ? box.querySelector('.msg[data-id="' + String(msgId).replace(/"/g, '') + '"]') : null;
      if (!el) { renderMsgs(true); box.scrollTop = box.scrollHeight; return; }
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(function () { el.classList.remove('flash'); }, 1600);
    }, 60);
  }
  // 会话里的“跳到未读/@”按钮
  function showJumpButton(rid) {
    var btn = $('#jumpBtn');
    if (!btn) return;
    var hasUnread = S.unreadAt[rid] || S.mentionAt[rid] || (S.unread[rid] || 0) > 0;
    btn.classList.toggle('hidden', !hasUnread);
    btn.classList.toggle('at', !!S.mentionAt[rid]);
    btn.textContent = S.mentionAt[rid] ? '@ 有人提到你' : ('↓ ' + (S.unread[rid] || '新') + ' 条新消息');
  }
  // 原生通知被点击后回传的跳转指令
  window.PaperOnJump = function () {
    var raw = '';
    try { raw = window.PaperNative.takeJump() || ''; } catch (e) { raw = ''; }
    if (!raw) return false;
    var kind = raw.indexOf('at:') === 0 ? 'at' : 'unread';
    var rest = raw.slice(raw.indexOf(':') + 1);
    var idPart = '';
    var hash = rest.indexOf('#');
    if (hash >= 0) { idPart = rest.slice(hash + 1); rest = rest.slice(0, hash); }
    var rid = rest;
    var target = kind === 'at' ? (idPart || S.mentionAt[rid]) : (idPart || S.unreadAt[rid]);
    jumpToMessage(rid, target);
    return true;
  };

  /* ---------------- 底部导航 ---------------- */
  /* 果冻药丸：底栏里有一个会滑动的胶囊，选中项变了它就弹过去 */
  var navBootAt = Date.now();   // 启动 400ms 内的切换不弹，免得一进 App 就抖
  function moveNavPill(animate) {
    var bar = $('#tabbar'), pill = $('#navPill');
    if (!bar || !pill) return;
    if (bar.classList.contains('hidden')) {
      pill.style.display = 'none';
      return;
    }
    pill.style.display = '';
    var on = bar.querySelector('.tab-item.on');
    if (!on) return;
    var br = bar.getBoundingClientRect(), ir = on.getBoundingClientRect();
    if (!ir.width) return;
    // 流体铺满整个按钮（略内缩一点，留出按钮之间的缝）
    var inset = 8;
    var w = Math.max(48, Math.round(ir.width - inset));
    var h = Math.max(30, Math.round(ir.height - inset));
    var x = (ir.left - br.left) + (ir.width - w) / 2;
    var y = (ir.top - br.top) + (ir.height - h) / 2;
    var prev = pill.__x;
    pill.style.width = w + 'px';
    pill.style.height = h + 'px';
    pill.style.top = (y + bar.scrollTop) + 'px';
    pill.style.transform = 'translateX(' + x + 'px)';
    pill.__x = x;
    if (animate && typeof prev === 'number' && Math.abs(prev - x) > 1) runJelly(pill, prev, x);
  }

  /* 果冻：按滑行距离算拉伸量，带过冲与二次回弹，方向朝哪边就往哪边抻 */
  function runJelly(pill, fromX, toX) {
    var dist = toX - fromX;
    var dir = dist > 0 ? 1 : -1;
    var far = Math.abs(dist);
    var stretch = Math.min(1.34, 1 + far / 300);        // 块变大了，拉伸幅度相应收一点
    var squash = Math.max(0.82, 1 - (stretch - 1) * 0.34);
    var over = Math.min(14, far * 0.14);                // 过冲像素
    pill.style.transformOrigin = dir > 0 ? 'left center' : 'right center';
    try { if (pill.__anim) pill.__anim.cancel(); } catch (e) {}
    var frames = [
      { transform: 'translateX(' + fromX + 'px) scaleX(1) scaleY(1)', offset: 0 },
      { transform: 'translateX(' + (fromX + dist * 0.28) + 'px) scaleX(' + stretch + ') scaleY(' + squash + ')', offset: 0.2 },
      { transform: 'translateX(' + (toX + dir * over) + 'px) scaleX(' + (1 - (stretch - 1) * 0.42) + ') scaleY(' + (1 + (stretch - 1) * 0.24) + ')', offset: 0.58 },
      { transform: 'translateX(' + (toX - dir * over * 0.42) + 'px) scaleX(' + (1 + (stretch - 1) * 0.22) + ') scaleY(' + (1 - (stretch - 1) * 0.12) + ')', offset: 0.78 },
      { transform: 'translateX(' + (toX + dir * over * 0.12) + 'px) scaleX(' + (1 - (stretch - 1) * 0.06) + ') scaleY(1)', offset: 0.91 },
      { transform: 'translateX(' + toX + 'px) scaleX(1) scaleY(1)', offset: 1 }
    ];
    try {
      pill.__anim = pill.animate(frames, { duration: 520, easing: 'linear', fill: 'none' });
    } catch (e) { pill.style.transform = 'translateX(' + toX + 'px)'; }
    // 玻璃里扫过一道光
    pill.classList.remove('sheen');
    void pill.offsetWidth;
    pill.classList.add('sheen');
    clearTimeout(pill.__st);
    pill.__st = setTimeout(function () { pill.classList.remove('sheen'); }, 640);
  }

  function showTab(name, opts) {
    var byUser = !!(opts && opts.user);
    var prevTab = S.tab;
    S.tab = name;
    $('#chats').classList.toggle('hidden', name !== 'chats');
    $('#contacts').classList.toggle('hidden', name !== 'contacts');
    $('#mePage').classList.toggle('hidden', name !== 'me');
    // 其他全屏页也要收起来，否则会盖在导航上面挡住点击
    ['#storagePage', '#groupPanel', '#imgViewer', '#dmSheet', '#msgActions', '#peerActions',
     '#groupSheet', '#remarkSheet'].forEach(function (sel) {
      var el = $(sel); if (el) el.classList.add('hidden');
    });
    var animate = byUser && (Date.now() - navBootAt) > 200;
    var items = document.querySelectorAll('#tabbar .tab-item');
    Array.prototype.forEach.call(items, function (b) {
      var on = b.getAttribute('data-tab') === name;
      b.classList.toggle('on', on);
      b.classList.remove('pop');
      if (on && animate) {
        void b.offsetWidth;
        b.classList.add('pop');
        setTimeout(function () { b.classList.remove('pop'); }, 560);
      }
    });
    // 聊天页正在退场（chat-close）时也算已关闭：否则退场这 190ms 里底栏会被一起藏掉，
    // 等 hidden 加上以后又没人把它打开，看起来就是「底栏莫名其妙消失了」
    var chatEl = $('#chat');
    var chatOpen = !!chatEl && !chatEl.classList.contains('hidden') && !chatEl.classList.contains('chat-close');
    $('#tabbar').classList.toggle('hidden', chatOpen);
    markPainted($('#chats'), 400);
    markPainted($('#contacts'), 400);
    markPainted($('#mePage'), 400);
    try {
      requestAnimationFrame(function () { moveNavPill(animate); });
    } catch (e) { moveNavPill(animate); }
    if (animate) {
      var barEl = $('#tabbar');
      if (barEl) {
        barEl.classList.remove('bar-pop');
        void barEl.offsetWidth;
        barEl.classList.add('bar-pop');
        setTimeout(function () { barEl.classList.remove('bar-pop'); }, 480);
      }
      var page = name === 'me' ? $('#mePage') : (name === 'contacts' ? $('#contacts') : $('#chats'));
      if (page) {
        var order = { chats: 0, contacts: 1, me: 2 };
        var dir = (order[name] || 0) >= (order[prevTab] || 0) ? 'slide-right' : 'slide-left';
        page.classList.remove('tab-switch', 'slide-right', 'slide-left');
        void page.offsetWidth;
        page.classList.add('tab-switch', dir);
        setTimeout(function () { page.classList.remove('tab-switch', 'slide-right', 'slide-left'); }, 460);
      }
    }

    if (name === 'me') fillMe();
    if (name === 'contacts') renderContacts();
  }
  // 头像：缩到 256px 再上传，省流量也省服务器
  function sendAvatar(file) {
    if (!S.auth) { toast('先登录再换头像'); return; }
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      var size = 256;
      var c = document.createElement('canvas');
      c.width = size; c.height = size;
      var ctx = c.getContext('2d');
      var sSide = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - sSide) / 2, (img.height - sSide) / 2, sSide, sSide, 0, 0, size, size);
      var data = '';
      try { data = c.toDataURL('image/jpeg', 0.82); } catch (err) { toast('图片处理失败'); return; }
      URL.revokeObjectURL(url);
      if (!wsSend({ t: 'avatar_set', data: data })) { toast('没连上服务器'); return; }
      toast('正在上传头像…');
    };
    img.onerror = function () { toast('这张图打不开'); };
    img.src = url;
  }

  function syncPinBtn() {
    var b = $('#btnPinRoom');
    if (!b) return;
    var rid = S.cur || '';
    b.classList.toggle('off', !S.pins[rid]);
    b.textContent = S.pins[rid] ? '📌' : '📍';
  }

  function renderMeAvatar() {
    var el = $('#meAvatar');
    if (!el) return;
    if (S.myAvatar) {
      var u = /^(data:|https?:)/.test(S.myAvatar) ? S.myAvatar : httpBase() + S.myAvatar;
      el.classList.add('has-img');
      el.innerHTML = '<img src="' + esc(u) + '" alt="">';
    } else {
      el.classList.remove('has-img');
      el.innerHTML = '🪁';
    }
  }

  function updateDiag() {
    try {
      var l = localStorage.getItem(LK('v1'));
      lastDiag.local = l ? ('本地 ' + new Date((JSON.parse(l).ts) || 0).toLocaleString() + (JSON.parse(l).auth ? ' 已登录' : ' 未登录')) : '本地空';
    } catch (e) { lastDiag.local = '读不出'; }
    try {
      if (window.PaperNative && window.PaperNative.loadState) {
        var n = window.PaperNative.loadState();
        if (!n) lastDiag.native = '镜像空';
        else {
          var o = JSON.parse(n);
          lastDiag.native = '镜像 ' + new Date(o.ts || 0).toLocaleString() + (o.auth ? ' 已登录' : ' 未登录');
        }
      } else lastDiag.native = '无原生桥';
    } catch (e) { lastDiag.native = '读镜像失败'; }
    try { lastDiag.code = (window.PaperNative && window.PaperNative.versionCode) ? String(window.PaperNative.versionCode()) : '网页版'; } catch (e) { lastDiag.code = '?'; }
  }

  function fillMe() {
    updateDiag();
    renderMeAvatar();
    if ($('#meDiag')) {
      var lines = '版本号 ' + esc(lastDiag.code) + '<br>' + esc(lastDiag.local) + '<br>' + esc(lastDiag.native);
      if (bootLog.length) {
        lines += '<br><b>启动日志</b><br>' + bootLog.map(function (x) { return esc(x); }).join('<br>');
      }
      $('#meDiag').innerHTML = lines;
    }
    if ($('#meName')) $('#meName').textContent = S.nick || '未登录';
    if ($('#meUser')) $('#meUser').textContent = S.user ? ('账号：' + S.user) : '未登录';
    if ($('#meUid')) $('#meUid').textContent = S.uid ? ('我的 ID：' + S.uid) : '我的 ID：未分配';
    if ($('#setNick')) $('#setNick').value = S.nick || '';
    if ($('#setServer')) $('#setServer').value = S.server || '';
    if ($('#verLine')) $('#verLine').textContent = '纸鸢 ' + (window.APP_VERSION || '') + ' · ' + (S.user ? ('账号 ' + S.user) : '未登录');
  }

  /* ---------------- 联系人 / 好友 ---------------- */
  function friendOf(uid) {
    return (S.friends || []).filter(function (f) { return String(f.uid) === String(uid); })[0];
  }
  function renderContacts() {
    var box = $('#friendList');
    if (!box) return;
    markPainted(box, 600);
    var list = S.friends || [];
    box.innerHTML = list.length ? list.map(function (f) {
      var nm = nameOf('uid:' + f.uid, f.name || ('用户' + f.uid));
      return '<li class="room friend-row" data-uid="' + esc(f.uid) + '">' +
        avaBox(peerAvatarUrl(['uid:' + f.uid, f.name, nm]), nm.slice(0, 1), colorOf('uid:' + f.uid)) +
        '<div class="room-main"><div class="room-line1"><div class="room-name">' + esc(nm) + '</div></div>' +
        '<div class="room-line2"><div class="room-last">ID ' + esc(f.uid) + (f.online ? ' · 在线' : '') + '</div></div></div></li>';
    }).join('') : '<li class="empty-hint">还没有好友，点右上角 ＋ 按 ID 添加</li>';

    // 待处理请求
    var pin = S.pendingIn || [], pout = S.pendingOut || [];
    var pbox = $('#pendingBox');
    if (pbox) {
      if (!pin.length && !pout.length) { pbox.classList.add('hidden'); pbox.innerHTML = ''; }
      else {
        pbox.classList.remove('hidden');
        pbox.innerHTML = '<h3 class="pending-title">好友申请</h3>' + pin.map(function (p) {
          return '<div class="pending-row" data-pin="' + esc(p.uid) + '">' +
            '<div class="pick-ava" style="background:' + colorOf('uid:' + p.uid) + '">' + esc((p.name || '?').slice(0, 1)) + '</div>' +
            '<div class="pending-main"><b>' + esc(p.name || ('用户' + p.uid)) + '</b><span>ID ' + esc(p.uid) + ' 请求加你为好友</span></div>' +
            '<button class="mini-btn ok" type="button" data-accept="' + esc(p.uid) + '">接受</button>' +
            '<button class="mini-btn" type="button" data-decline="' + esc(p.uid) + '">拒绝</button></div>';
        }).join('') + pout.map(function (p) {
          return '<div class="pending-row out"><div class="pick-ava" style="background:' + colorOf('uid:' + p.uid) + '">' + esc((p.name || '?').slice(0, 1)) + '</div>' +
            '<div class="pending-main"><b>' + esc(p.name || ('用户' + p.uid)) + '</b><span>已发送申请，等待对方通过</span></div></div>';
        }).join('');
      }
    }
    var hint = $('#contactHint');
    if (hint) hint.classList.toggle('hidden', !!(S.friends || []).length);
  }
  function showSearchResult(hit, uid) {
    var box = $('#searchResult');
    if (!box) return;
    box.classList.remove('hidden');
    if (!hit) {
      box.innerHTML = '<div class="search-empty">没有找到 ID 为 <b>' + esc(uid) + '</b> 的用户</div>';
      return;
    }
    var isFriend = !!friendOf(hit.uid);
    box.innerHTML = '<div class="search-card">' +
      '<div class="ava" style="background:' + colorOf('uid:' + hit.uid) + '">' + esc((hit.name || '?').slice(0, 1)) + '</div>' +
      '<div class="search-meta"><b>' + esc(hit.name || ('用户' + hit.uid)) + '</b><span>ID ' + esc(hit.uid) + '</span></div>' +
      (isFriend ? '<span class="mini-btn done">已是好友</span>'
                : '<button class="mini-btn ok" type="button" data-add="' + esc(hit.uid) + '">加好友</button>') +
      '</div>';
  }
  function searchByUid() {
    var raw = ($('#searchUid').value || '').replace(/\D/g, '');
    if (!raw) { toast('请输入数字 ID'); return; }
    S.searchHit = null;
    $('#searchResult').classList.add('hidden');
    if (!wsSend({ t: 'contact_search', uid: Number(raw) })) { toast('没连上服务器'); return; }
    // 服务器没实现好友接口时，别让人一直等
    clearTimeout(window.__searchTimer);
    window.__searchTimer = setTimeout(function () {
      if (!S.searchHit) showSearchResult(null, raw);
    }, 6000);
  }
  function addFriend(uid) {
    if (!wsSend({ t: 'contact_add', uid: Number(uid) })) { toast('没连上服务器'); return; }
    toast('好友申请已发送');
  }

  function needRelogin(reason) {
    S.auth = false; S.token = ''; S.pendingAuth = null;
    try { save(); } catch (e) {}
    blog('需要重新登录: ' + reason);
    $('#setup').classList.remove('hidden');
    if ($('#loginError')) {
      $('#loginError').textContent = reason;
      $('#loginError').classList.remove('hidden');
    }
  }

  function boot() {
    try { applyTheme(localStorage.getItem('paperlite.theme') || ''); } catch (e) {}
    setCurrentServer(currentServer() || DEFAULT_SERVER);
    migrateLegacy();
    load();
    if (S.server && srvTagOf(S.server) !== srvTag) { setCurrentServer(S.server); load(); }
    loadRemarks();
    loadStickers();
    try { applySkin(); } catch (e) {}
    try { setTimeout(watchLists, 120); } catch (e) {}
    try {
      // 三个主页面：首屏动画播完就不再重播
      setTimeout(function () {
        ['#chats', '#contacts', '#mePage'].forEach(function (sel) { markPainted($(sel), 0); });
      }, 700);
    } catch (e) {}
    try {
      setTimeout(function () { moveNavPill(false); }, 80);
      window.addEventListener('resize', function () { moveNavPill(false); });
      window.addEventListener('orientationchange', function () { setTimeout(function () { moveNavPill(false); }, 260); });
    } catch (e) {}
    try {
      var ver = window.APP_VERSION || '1.0';
      var line = $('#verLine');
      if (line) line.textContent = '纸鸢 ' + ver + ' · 账号版';
    } catch (e) {}
    try { S.dms = JSON.parse(localStorage.getItem(LK('dms')) || '{}') || {}; } catch (e) { S.dms = {}; }
    try { if (S.localAgent && S.localAgent.on) ensureLocalConv(true); } catch (e) {}
    bind();
    try { applyAgentProfile(); } catch (e) {}
    try { renderAgentUserPanel(); } catch (e) {}
    try { applyChatBg(); } catch (e) {}
    try { var gs = $('#glassState'); if (gs) gs.textContent = S.glass ? '开' : '关'; } catch (e) {}
    try {
      var ts = $('#topbarTextState');
      var nm = { auto: '自动', light: '白字', dark: '黑字' };
      if (ts) ts.textContent = nm[S.topbarText || 'auto'];
    } catch (e) {}
    // 上次开着「用户接入」的话，让原生把它拉起来（服务重启/更新后也能自动回来）
    try {
      if (S.agentUser && S.agentUser.on && S.agentUser.user && window.PaperNative && window.PaperNative.agentUserApply) {
        window.PaperNative.agentUserApply(true, S.agentUser.user, S.agentUser.pass || '',
                S.agentUser.nick || S.agentUser.user, S.agentUser.avatar || '',
                S.agentUser.port || 6722, !!S.agentUser.lan);
      }
    } catch (e) {}
    bindViewer();

    on('#btnPinRoom', 'click', function () {
      var rid = S.cur;
      if (!rid) return;
      if (S.pins[rid]) { delete S.pins[rid]; toast('已取消置顶'); }
      else { S.pins[rid] = Date.now(); toast('已置顶'); }
      save(); renderRooms(); syncPinBtn();
    });
    on('#roomList', 'click', function (e) {
      var more = e.target.closest('[data-more]');
      if (more) { e.stopImmediatePropagation(); openRoomSheet(more.getAttribute('data-more')); return; }
    }, true);
    on('#roomRemove', 'click', function () {
      var rid = roomTarget;
      if (!rid) return;
      closeRoomSheet();
      removeRoom(rid);
    });
    on('#roomBlock', 'click', function () {
      var rid = roomTarget;
      if (!rid) return;
      closeRoomSheet();
      blockRoom(rid);
    });
    on('#btnBlocked', 'click', function () { openBlockPage(); });
    on('#blockBack', 'click', function () { $('#blockPage').classList.add('hidden'); showTab('me'); });
    on('#blockedUsers', 'click', function (e) {
      var b = e.target.closest('[data-unblock]');
      if (b) { wsSend({ t: 'contact_unblock', uid: Number(b.getAttribute('data-unblock')) }); toast('已解除'); }
    });
    on('#blockedGroups', 'click', function (e) {
      var g = e.target.closest('[data-unblockg]');
      if (g) { wsSend({ t: 'group_unblock', id: g.getAttribute('data-unblockg') }); toast('已解除'); }
    });
    on('#roomMute', 'click', function () {
      var rid = roomTarget;
      if (!rid) return;
      var on = !isMuted(rid);
      setMuted(rid, on);
      closeRoomSheet();
      toast(on ? '已开启免打扰' : '已关闭免打扰');
    });
    on('#roomPin', 'click', function () {
      var rid = roomTarget;
      if (!rid) return;
      if (S.pins[rid]) delete S.pins[rid]; else S.pins[rid] = Date.now();
      save(); renderRooms(); closeRoomSheet();
      toast(S.pins[rid] ? '已置顶' : '已取消置顶');
    });
    on('#roomCancel', 'click', closeRoomSheet);
    on('#roomSheet', 'click', function (e) {
      if (e.target === $('.action-scrim') || e.target === $('#roomCancel')) closeRoomSheet();
    });
    on('#fabNew', 'click', openDmSheet);
    on('#dmGame', 'click', function () {
      closeDmSheet();
      if (window.WW) window.WW.open(); else toast('游戏模块没加载');
    });
    Array.prototype.forEach.call(document.querySelectorAll('#tabbar .tab-item'), function (b) {
      b.addEventListener('click', function () { showTab(b.getAttribute('data-tab'), { user: true }); });
    });
    on('#btnFlush', 'click', function () {
      save();
      try { if (window.PaperNative && window.PaperNative.saveState) window.PaperNative.saveState(JSON.stringify({ nick: S.nick, server: S.server, last: S.last, unread: S.unread, user: S.user, auth: S.auth, ts: Date.now() })); } catch (e) {}
      toast('已写入本机存储');
      updateDiag();
      if ($('#meDiag')) $('#meDiag').innerHTML = '版本号 ' + esc(lastDiag.code) + '<br>' + esc(lastDiag.local) + '<br>' + esc(lastDiag.native);
    });
    on('#btnAvatar', 'click', function () {
      var el = $('#avatarInput');
      if (el) { el.value = ''; el.click(); }
    });
    on('#avatarInput', 'change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      sendAvatar(f);
    });
    on('#btnCheckUpdate', 'click', function () { runVersionCheck(true); });
    on('#updGo', 'click', doUpdate);
    on('#updLater', 'click', updateLater);
    on('#updClose', 'click', closeUpdate);
    on('#jumpBtn', 'click', function () {
      var rid = S.cur;
      if (!rid) return;
      var target = S.mentionAt[rid] || S.unreadAt[rid] || null;
      S.mentionAt[rid] = null; S.unreadAt[rid] = null; S.unread[rid] = 0;
      save(); renderRooms(); showJumpButton(rid);
      jumpToMessage(rid, target);
    });
    on('#btnSearchUid', 'click', searchByUid);
    on('#searchUid', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); searchByUid(); } });
    on('#btnAddFriend', 'click', function () {
      showTab('contacts');
      var el = $('#searchUid'); if (el) el.focus();
    });
    on('#searchResult', 'click', function (e) {
      var b = e.target.closest('[data-add]');
      if (b) { addFriend(b.getAttribute('data-add')); }
    });
    on('#pendingBox', 'click', function (e) {
      var ok = e.target.closest('[data-accept]');
      var no = e.target.closest('[data-decline]');
      if (ok) wsSend({ t: 'contact_accept', uid: Number(ok.getAttribute('data-accept')) });
      if (no) wsSend({ t: 'contact_decline', uid: Number(no.getAttribute('data-decline')) });
    });
    on('#friendList', 'click', function (e) {
      var row = e.target.closest('[data-uid]');
      if (!row) return;
      var uid = row.getAttribute('data-uid');
      var f = friendOf(uid);
      var nm = f ? f.name : ('用户' + uid);
      openDM((f && f.pm) ? f.pm : ('uid:' + uid), nm);
    });
    on('#btnNewChatRow', 'click', openDmSheet);
    on('#dmCancel', 'click', closeDmSheet);
    on('#dmSheet', 'click', function (e) {
      if (e.target === $('.action-scrim') || e.target === $('#dmCancel')) closeDmSheet();
    });
    on('#dmList', 'click', function (e) {
      var row = e.target.closest('[data-dm]');
      if (!row) return;
      var id = row.getAttribute('data-dm');
      var p = (S.people || []).filter(function (x) { return x.id === id; })[0];
      closeDmSheet();
      openDM(id, p ? p.name : '私聊');
    });
    on('#dmNewGroup', 'click', function () {
      closeDmSheet();
      if (typeof openGroupSheet === 'function') openGroupSheet();
    });
    on('#text', 'input', syncComposer);
    syncComposer();
    renderRooms();

    // 旧版本保存的状态里没有令牌：服务端认不出身份，会一直卡在连接中
    if (S.auth && !S.token) needRelogin('需要重新登录一次（本次更新新增了登录凭证）');
    if (!S.auth) {
      // 没登录过：停在登录页，服务器地址给个默认值
      $('#inServer').value = S.server || guessServer();
      $('#regServer').value = S.server || guessServer();
      $('#tabLogin').classList.add('on');
      $('#tabRegister').classList.remove('on');
    } else {
      $('#setup').classList.add('hidden');
      connect();
      // 回到上次那个会话：记录先在本地渲染出来，连上后再由服务端历史补齐
      if (S.cur) { try { openRoom(S.cur); } catch (e) {} }
    }
    setConn(false);
    setTimeout(function () {
      var base = serverHttpBase();
      try {
        if (window.PaperNative && window.PaperNative.checkUpdate && base) {
          window.PaperNative.checkUpdate(base);
        } else {
          webVersionCheck();
        }
      } catch (e) { webVersionCheck(); }
    }, 800);
    setInterval(watchdog, 10000);
    // 每 5 秒落盘一次：进程被强杀时最多丢 5 秒内的状态
    setInterval(function () { if (S.auth) { try { save(); } catch (e) {} } }, 5000);
    // 网页版（无原生桥）才走浏览器通知权限；App 内由原生壳申请
    try {
      if (!nativeOn() && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch (e) {}
    // 从通知点进来的跳转
    if (window.PaperOnJump) setTimeout(function () { window.PaperOnJump(); }, 400);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        try { save(); } catch (e) {}          // 切后台先落盘，别等 5 秒定时器
        return;
      }
      // 回到前台：先按本地存储重画一次（WebView 被回收/列表没刷新时，这一步能救回来）
      try {
        if (S.auth) {
          renderRooms();
          if (S.cur) { renderMsgs(true); showJumpButton(S.cur); }
        }
      } catch (e) {}
      if (!connected) { connect(); return; }
      // 回到前台顺手确认是否有新版本（自动提醒，可关闭；正在检查就不重复）
      if (!checkJob) setTimeout(function () { if (!checkJob) runVersionCheck(false); }, 600);
      // 回到前台：连接看起来在、但很久没动静，直接重连
      if (lastRx && Date.now() - lastRx > PONG_TIMEOUT) {
        try { ws.close(); } catch (e) {}
        try { ws = null; } catch (e) {}
        setConn(false);
        scheduleRetry();
      }
    });
  }
  // 默认服务器：在 app/config.js 里配；留空则要求用户自己填
  var DEFAULT_SERVER = String(CFG.server || '').replace(/\/+$/, '');

  function guessServer() {
    try {
      var h = location.hostname;
      // 用浏览器打开时，直接连当前页面所在的主机
      if (h && h !== 'localhost' && h !== '127.0.0.1') {
        return (location.protocol === 'https:' ? 'wss://' : 'ws://') + h + ':8080';
      }
    } catch (e) {}
    return DEFAULT_SERVER;
  }

  // 视口高度跟随系统栏/键盘变化，布局按真实可视高度裁切
  function syncViewport() {
    try {
      var vv = window.visualViewport;
      var h = (vv && vv.height) || window.innerHeight || 0;
      if (h > 0) document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
    } catch (e) {}
  }
  window.addEventListener('resize', syncViewport);
  window.addEventListener('orientationchange', function () { setTimeout(syncViewport, 260); });
  try { if (window.visualViewport) window.visualViewport.addEventListener('resize', syncViewport); } catch (e) {}

  document.addEventListener('DOMContentLoaded', function () { syncViewport(); boot(); });
})();
