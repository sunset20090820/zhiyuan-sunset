/* 纸鸢 · 角色卡 / 世界包 / RP 会话映射
 * ---------------------------------------------------------------
 * 这一层的所有数据都用「全局前缀」GK()，与服务器地址无关：
 *   换服务器、断网、服务器挂了，角色和剧情都还在。
 * 主存放在原生（SharedPreferences 文件位），localStorage 只作为缓存/兜底。
 * 写入顺序固定：先 kvPut（原生落盘），再写 localStorage，最后才更新内存。
 */
(function (global) {
  'use strict';

  var MAX_CARDS = 100;
  var MAX_WORLDS = 20;
  var MAX_FIELD = 2000;
  var RP = {};

  RP.MAX = { cards: MAX_CARDS, worlds: MAX_WORLDS, field: MAX_FIELD };

  function GK(name) { return 'pl.global.' + name; }
  RP.GK = GK;

  /* ---------- 存储：原生优先，localStorage 兜底 ---------- */
  function kvPut(key, val) {
    try {
      if (global.PaperNative && global.PaperNative.kvPut) global.PaperNative.kvPut(key, val);
    } catch (e) {}
  }
  function kvGet(key) {
    try {
      if (global.PaperNative && global.PaperNative.kvGet) return global.PaperNative.kvGet(key) || '';
    } catch (e) {}
    return '';
  }
  function lsGet(key) {
    try { return global.localStorage.getItem(GK(key)) || ''; } catch (e) { return ''; }
  }
  function lsPut(key, val) {
    try { global.localStorage.setItem(GK(key), val); } catch (e) {}
  }

  // 同一份数据在两处，取 ts 更新的那份（原生被系统保住了、localStorage 被清过也行）
  function readList(key) {
    var a = null, b = null;
    var raw1 = kvGet(key);
    var raw2 = lsGet(key);
    try { a = raw1 ? JSON.parse(raw1) : null; } catch (e) { a = null; }
    try { b = raw2 ? JSON.parse(raw2) : null; } catch (e) { b = null; }
    if (!a && !b) return { items: [], ts: 0, from: 'empty' };
    if (!a) return { items: (b && b.items) || [], ts: (b && b.ts) || 0, from: 'local' };
    if (!b) return { items: (a && a.items) || [], ts: (a && a.ts) || 0, from: 'native' };
    var pick = ((a.ts || 0) >= (b.ts || 0)) ? a : b;
    return { items: pick.items || [], ts: pick.ts || 0, from: ((a.ts || 0) >= (b.ts || 0)) ? 'native' : 'local' };
  }

  function writeList(key, items) {
    var blob = JSON.stringify({ ts: Date.now(), items: items });
    kvPut(key, blob);
    lsPut(key, blob);
  }

  function s(v, max) { return String(v == null ? '' : v).slice(0, max || MAX_FIELD); }
  function num(v, def, lo, hi) {
    var n = Number(v);
    if (!isFinite(n)) n = def;
    if (typeof lo === 'number' && n < lo) n = lo;
    if (typeof hi === 'number' && n > hi) n = hi;
    return n;
  }
  function newId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  RP.newId = newId;

  /* ---------- 归一化（编辑器、导入都走这里） ---------- */
  function normCard(raw) {
    var r = raw || {};
    var style = r.style || {};
    var ex = [];
    if (Array.isArray(r.mesExample)) {
      r.mesExample.slice(0, 12).forEach(function (x) {
        if (!x) return;
        var u = s(x.u || x.user, 600), a = s(x.a || x.assistant, 600);
        if (u || a) ex.push({ u: u, a: a });
      });
    }
    return {
      id: s(r.id, 60) || newId('c_'),
      name: s(r.name, 40) || '未命名角色',
      avatar: /^data:image\//.test(String(r.avatar || '')) ? String(r.avatar) : '',
      worldId: s(r.worldId, 60),
      desc: s(r.desc, MAX_FIELD),
      personality: s(r.personality, MAX_FIELD),
      scenario: s(r.scenario, MAX_FIELD),
      firstMes: s(r.firstMes, MAX_FIELD),
      mesExample: ex,
      rules: s(r.rules, MAX_FIELD),
      style: {
        len: /^(short|mid|long)$/.test(String(style.len || '')) ? style.len : 'short',
        person: /^(first|third)$/.test(String(style.person || '')) ? style.person : 'first',
        banned: Array.isArray(style.banned) ? style.banned.slice(0, 20).map(function (x) { return s(x, 20); }) : []
      },
      model: s(r.model, 80),
      temp: num(r.temp, 0.85, 0, 2),
      // 人设扩展 + 情感滑杆（0–100，50 左右是「中性」）
      callUser: s(r.callUser, 40),
      relation: s(r.relation, 200),
      tic: s(r.tic, 160),
      likes: s(r.likes, 200),
      dislikes: s(r.dislikes, 200),
      secret: s(r.secret, 500),
      look: s(r.look, 200),
      limits: s(r.limits, 500),
      pace: s(r.pace, 160),
      mood: /^(daily|sweet|angst|mystery|comedy)$/.test(String(r.mood || '')) ? r.mood : 'daily',
      dials: (function () {
        var d = r.dials || {};
        return {
          emotion: num(d.emotion, 55, 0, 100),
          intimacy: num(d.intimacy, 40, 0, 100),
          initiative: num(d.initiative, 45, 0, 100),
          action: num(d.action, 50, 0, 100),
          drama: num(d.drama, 40, 0, 100)
        };
      })(),
      builtin: !!r.builtin,
      v: 2
    };
  }

  function normWorld(raw) {
    var r = raw || {};
    var lore = [];
    (Array.isArray(r.lore) ? r.lore : []).slice(0, 200).forEach(function (x) {
      if (!x) return;
      var text = s(x.text, 1200);
      var keys = (Array.isArray(x.keys) ? x.keys : String(x.keys || '').split(/[,，、\s]+/))
        .map(function (k) { return s(k, 20).trim(); })
        .filter(Boolean).slice(0, 6);
      if (text) lore.push({ keys: keys, text: text });
    });
    var rules = (Array.isArray(r.rules) ? r.rules : [])
      .map(function (x) { return s(x, 120); }).filter(Boolean).slice(0, 20);
    return {
      id: s(r.id, 60) || newId('w_'),
      name: s(r.name, 40) || '未命名世界',
      desc: s(r.desc, 1500),
      lore: lore,
      rules: rules,
      builtin: !!r.builtin,
      v: 1
    };
  }
  RP.normCard = normCard;
  RP.normWorld = normWorld;

  /* ---------- 内存态 ---------- */
  var _cards = [], _worlds = [], _rooms = {}, _loaded = false, _lastErr = '';
  RP.loaded = function () { return _loaded; };
  RP.lastErr = function () { return _lastErr; };

  RP.load = function () {
    var c = readList('cards.v1'), w = readList('worlds.v1'), m = readList('rp.v1');
    _cards = (c.items || []).map(normCard);
    _worlds = (w.items || []).map(normWorld);
    _rooms = {};
    (m.items || []).forEach(function (x) {
      if (x && x.roomId) _rooms[x.roomId] = { cardId: s(x.cardId, 60), vol: num(x.vol, 1, 1, 999), ts: num(x.ts, 0) };
    });
    _loaded = true;
    if (!_cards.length) ensureSamples();
    return { cards: _cards.length, worlds: _worlds.length, rooms: Object.keys(_rooms).length, from: c.from + '/' + w.from };
  };

  RP.cards = function () { return _cards.slice(); };
  RP.worlds = function () { return _worlds.slice(); };
  RP.card = function (id) {
    for (var i = 0; i < _cards.length; i++) if (_cards[i].id === id) return _cards[i];
    return null;
  };
  RP.world = function (id) {
    for (var i = 0; i < _worlds.length; i++) if (_worlds[i].id === id) return _worlds[i];
    return null;
  };

  function persistCards() { writeList('cards.v1', _cards); }
  function persistWorlds() { writeList('worlds.v1', _worlds); }
  function persistRooms() {
    var arr = Object.keys(_rooms).map(function (k) {
      return { roomId: k, cardId: _rooms[k].cardId, vol: _rooms[k].vol || 1, ts: _rooms[k].ts || 0 };
    });
    writeList('rp.v1', arr);
  }

  RP.saveCard = function (raw) {
    var card = normCard(raw);
    var i, found = -1;
    for (i = 0; i < _cards.length; i++) if (_cards[i].id === card.id) { found = i; break; }
    if (found >= 0) _cards[found] = card;
    else {
      if (_cards.length >= MAX_CARDS) { _lastErr = '角色卡最多 ' + MAX_CARDS + ' 张'; return { ok: false, err: _lastErr }; }
      _cards.push(card);
    }
    persistCards();
    return { ok: true, card: card };
  };

  RP.delCard = function (id) {
    var next = _cards.filter(function (c) { return c.id !== id; });
    if (next.length === _cards.length) return false;
    _cards = next;
    persistCards();
    // 会话映射跟着删；聊天记录保留（可在存储管理里单独清）
    Object.keys(_rooms).forEach(function (rid) {
      if (_rooms[rid].cardId === id) { delete _rooms[rid]; }
    });
    persistRooms();
    return true;
  };

  RP.saveWorld = function (raw) {
    var w = normWorld(raw);
    var i, found = -1;
    for (i = 0; i < _worlds.length; i++) if (_worlds[i].id === w.id) { found = i; break; }
    if (found >= 0) _worlds[found] = w;
    else {
      if (_worlds.length >= MAX_WORLDS) { _lastErr = '世界包最多 ' + MAX_WORLDS + ' 个'; return { ok: false, err: _lastErr }; }
      _worlds.push(w);
    }
    persistWorlds();
    return { ok: true, world: w };
  };

  // 删世界包不级联删卡：只把引用它的卡 worldId 置空（文档 §4.3 的约定）
  RP.delWorld = function (id) {
    var next = _worlds.filter(function (w) { return w.id !== id; });
    if (next.length === _worlds.length) return { ok: false, detached: 0 };
    _worlds = next;
    persistWorlds();
    var n = 0;
    _cards.forEach(function (c) {
      if (c.worldId === id) { c.worldId = ''; n++; }
    });
    if (n) persistCards();
    return { ok: true, detached: n };
  };

  /* ---------- RP 会话（roomId = 'rp:<cardId>'） ---------- */
  RP.RP_PREFIX = 'rp:';
  RP.roomOf = function (cardId) { return 'rp:' + cardId; };
  RP.isRpRoom = function (rid) { return !!rid && rid.indexOf('rp:') === 0; };
  RP.cardIdOfRoom = function (rid) {
    if (!RP.isRpRoom(rid)) return '';
    var byMap = _rooms[rid] && _rooms[rid].cardId;
    if (byMap && RP.card(byMap)) return byMap;
    var direct = rid.slice(3);
    return RP.card(direct) ? direct : '';
  };
  RP.rooms = function () { return _rooms; };
  RP.roomMeta = function (rid) { return _rooms[rid] || null; };

  RP.ensureRoom = function (cardId) {
    var rid = RP.roomOf(cardId);
    if (!_rooms[rid]) { _rooms[rid] = { cardId: cardId, vol: 1, ts: Date.now() }; persistRooms(); }
    return rid;
  };
  RP.setVol = function (rid, vol) {
    if (!_rooms[rid]) return;
    _rooms[rid].vol = num(vol, 1, 1, 999);
    persistRooms();
  };
  RP.volOf = function (rid) { return (_rooms[rid] && _rooms[rid].vol) || 1; };
  RP.touchRoom = function (rid) {
    if (_rooms[rid]) { _rooms[rid].ts = Date.now(); }
  };
  RP.removeRoom = function (rid) {
    if (!_rooms[rid]) return false;
    delete _rooms[rid];
    persistRooms();
    return true;
  };

  /* ---------- 设置（预算档位等） ---------- */
  RP.settings = function () {
    var raw = readList('set.v1');
    var it = (raw.items && raw.items[0]) || {};
    return {
      budget: num(it.budget, 8192, 2048, 1048576),
      autoBackup: it.autoBackup !== false,
      backupKeep: num(it.backupKeep, 3, 1, 9),
      withRawDefault: it.withRawDefault === true,
      volBadge: it.volBadge !== false
    };
  };
  RP.saveSettings = function (obj) {
    var cur = RP.settings();
    var next = {
      budget: num(obj.budget, cur.budget, 2048, 1048576),
      autoBackup: obj.autoBackup === undefined ? cur.autoBackup : !!obj.autoBackup,
      backupKeep: num(obj.backupKeep, cur.backupKeep, 1, 9),
      withRawDefault: obj.withRawDefault === undefined ? cur.withRawDefault : !!obj.withRawDefault,
      volBadge: obj.volBadge === undefined ? cur.volBadge : !!obj.volBadge
    };
    writeList('set.v1', [next]);
    return next;
  };

  /* ---------- 内置示例（默认决策：1 张卡 + 1 个世界，纯文本不带头像） ---------- */
  function ensureSamples() {
    var seeded = lsGet('samples.v1') || kvGet('samples.v1');
    if (seeded === '1') return;
    var w = RP.saveWorld({
      id: 'w_sample_bookstore',
      name: '城西旧书店',
      desc: '九十年代末的南方小城，梅雨季节。城西一条老街，街尾有一间开了二十年的旧书店，木地板、绿罩台灯、书页发霉的味道。街上的人认识彼此，但不爱打听别人家的事。',
      lore: [
        { keys: ['旧书店', '父亲'], text: '书店是父亲留下的，1998 年开的；父亲三年前去世后由她一个人守着。' },
        { keys: ['老街', '拆迁'], text: '老街北段已经贴了拆迁公告，年底前要清空。' }
      ],
      rules: ['没有魔法与超能力', '时代是九十年代末，没有智能手机']
    }).world;
    RP.saveCard({
      id: 'c_sample_linwan',
      name: '林晚',
      worldId: w.id,
      desc: '27 岁，旧书店店主。说话慢，习惯先想再说，喜欢反问。',
      personality: '克制、记得住细节、被追问私事时会转移话题；对熟客会多说两句。',
      scenario: '雨夜，书店快打烊了，你推门进来躲雨。',
      firstMes: '（抬眼看了看门口的水）伞放门口吧，地有点滑。',
      mesExample: [
        { u: '你认识我吗', a: '（顿了一下）书认识你，我不认识。' }
      ],
      rules: '不要写旁白式心理描写；一次回复不超过 3 段；不要出现「作为AI」这类说法。',
      style: { len: 'short', person: 'first', banned: ['~', '呢'] },
      temp: 0.85,
      builtin: true
    });
    lsPut('samples.v1', '1');
    kvPut('samples.v1', '1');
  }
  RP.ensureSamples = ensureSamples;

  /* ---------- 导出用的纯数据（不含 id 冲突检查，导入时由上层处理） ---------- */
  RP.rawCards = function () { return JSON.parse(JSON.stringify(_cards)); };
  RP.rawWorlds = function () { return JSON.parse(JSON.stringify(_worlds)); };
  RP.rawRooms = function () { return _rooms; };

  global.RP = RP;
})(window);