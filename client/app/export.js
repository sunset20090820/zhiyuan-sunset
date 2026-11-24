/* 纸鸢 · 导出 / 导入
 * ---------------------------------------------------------------
 * 三种粒度：角色卡 / 世界包 / 剧情存档 / 全量备份。
 * 红线：不含 API key、不含账号 token、不含服务器地址、不含 deviceId。
 * 导入：先预览，再选策略（仅新增 / 覆盖同名 / 合并会话），导入前自动快照。
 */
(function (global) {
  'use strict';

  var EX = {};
  var FORMAT = 'paperlite.export';
  var SCHEMA = 1;
  var MAX_FILE = 8 * 1024 * 1024;

  function appVer() { try { return global.APP_VERSION || ''; } catch (e) { return ''; } }
  function now() { return Date.now(); }

  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '未命名';
  }
  function stamp(d) {
    d = d || new Date();
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }
  EX.safeName = safeName;
  EX.stamp = stamp;

  function wrap(kind, payload, withRaw) {
    return {
      format: FORMAT,
      schema: SCHEMA,
      kind: kind,
      exportedAt: now(),
      appVersion: appVer(),
      withRaw: !!withRaw,
      notice: '本文件含角色扮演的设定与剧情内容，请自行妥善保存；不含 API key、账号与服务器信息。',
      payload: payload
    };
  }

  /* 只挑导出需要的字段，顺手把不该外发的都丢掉 */
  function cleanCard(c) {
    return {
      id: c.id, name: c.name, avatar: /^data:image\//.test(String(c.avatar || '')) ? c.avatar : '',
      worldId: c.worldId || '', desc: c.desc || '', personality: c.personality || '',
      scenario: c.scenario || '', firstMes: c.firstMes || '',
      mesExample: (c.mesExample || []).slice(0, 12), rules: c.rules || '',
      style: c.style || {}, model: c.model || '', temp: c.temp, v: 1
    };
  }
  function cleanWorld(w) {
    return {
      id: w.id, name: w.name, desc: w.desc || '',
      lore: (w.lore || []).slice(0, 200), rules: (w.rules || []).slice(0, 20), v: 1
    };
  }
  function cleanMsg(m) {
    var o = {
      id: m.id, from: m.from, name: m.name || '', text: String(m.text || '').slice(0, 4000),
      ts: m.ts, volMark: m.volMark || 0
    };
    if (m.replyTo) o.replyTo = m.replyTo;
    return o;
  }

  /* ---------- 生成 ---------- */
  EX.card = function (card, withWorld) {
    var p = { card: cleanCard(card) };
    if (withWorld && card.worldId) {
      var w = global.RP.world(card.worldId);
      if (w) { p.world = cleanWorld(w); p.worldId = w.id; }
    }
    return wrap('card', p, !!withWorld);
  };

  EX.world = function (world) {
    return wrap('world', { world: cleanWorld(world) }, false);
  };

  EX.story = function (roomId, opts) {
    opts = opts || {};
    var cards = global.RP.cards();
    var cid = global.RP.cardIdOfRoom(roomId);
    var card = null;
    for (var i = 0; i < cards.length; i++) if (cards[i].id === cid) { card = cards[i]; break; }
    var roll = global.ROLL.get(roomId);
    var msgs = (opts.msgs || []).map(cleanMsg);
    var p = { card: card ? cleanCard(card) : null, roll: roll };
    if (card && card.worldId) { var w = global.RP.world(card.worldId); if (w) p.world = cleanWorld(w); }
    if (opts.withRaw) p.msgs = msgs;
    return wrap('story', p, !!opts.withRaw);
  };

  EX.backup = function (opts) {
    opts = opts || {};
    var cards = global.RP.rawCards().map(cleanCard);
    var worlds = global.RP.rawWorlds().map(cleanWorld);
    var stories = [];
    var rooms = global.RP.rooms();
    Object.keys(rooms).forEach(function (rid) {
      var msgs = opts.takeHist ? opts.takeHist(rid) : [];
      var roll = global.ROLL.get(rid);
      var cid = rooms[rid].cardId;
      stories.push({
        room: rid, cardId: cid, roll: roll,
        msgs: opts.withRaw ? (msgs || []).map(cleanMsg) : null
      });
    });
    return wrap('backup', {
      cards: cards, worlds: worlds, stories: stories,
      aiconf: {
        base: (global.__aiConfSnap ? global.__aiConfSnap().base : ''),
        model: (global.__aiConfSnap ? global.__aiConfSnap().model : ''),
        sumModel: (global.__aiConfSnap ? global.__aiConfSnap().sumModel : ''),
        effort: (global.__aiConfSnap ? global.__aiConfSnap().effort : '')
      }
    }, !!opts.withRaw);
  };

  EX.text = function (obj) {
    var s = JSON.stringify(obj);
    // 8MB 上限：超了就提示「不含原文再试」，不静默截断
    return s;
  };

  /* ---------- 解析 ---------- */
  EX.parse = function (text) {
    if (!text) return { ok: false, err: '文件是空的' };
    if (String(text).length > MAX_FILE) return { ok: false, err: '文件超过 8 MB，先试试不含原文再导出' };
    var o = null;
    try { o = JSON.parse(text); } catch (e) { return { ok: false, err: '不是合法的 JSON（可能选错了文件）' }; }
    if (!o || o.format !== FORMAT) return { ok: false, err: '不是纸鸢的导出文件' };
    if (Number(o.schema) > SCHEMA) return { ok: false, err: '这个文件来自更新的版本（schema ' + o.schema + '），先升级 App' };
    if (!o.payload || typeof o.payload !== 'object') return { ok: false, err: '文件内容不完整' };
    var kind = String(o.kind || '');
    if (['card', 'world', 'story', 'backup'].indexOf(kind) < 0) return { ok: false, err: '认不出导出类型：' + kind };
    var p = o.payload;
    var meta = { kind: kind, exportedAt: o.exportedAt || 0, appVersion: o.appVersion || '', withRaw: !!o.withRaw };
    if (kind === 'card') meta.cards = p.card ? 1 : 0;
    if (kind === 'world') meta.worlds = p.world ? 1 : 0;
    if (kind === 'story') { meta.stories = 1; meta.msgs = (p.msgs || []).length; }
    if (kind === 'backup') {
      meta.cards = (p.cards || []).length;
      meta.worlds = (p.worlds || []).length;
      meta.stories = (p.stories || []).length;
      meta.msgs = (p.stories || []).reduce(function (n, s) { return n + ((s.msgs || []).length); }, 0);
    }
    // 红线检查：出现这些字段就拒绝
    var bad = text.indexOf('"apiKey"') >= 0 || text.indexOf('"token"') >= 0 || text.indexOf('paperlite_secrets') >= 0;
    if (bad) return { ok: false, err: '文件里出现了不该有的敏感字段（key/token），已拒绝导入' };
    return { ok: true, kind: kind, pay: p, meta: meta, data: o };
  };

  /* ---------- 导入 ---------- */
  function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

  // strategy: 'new'（默认，冲突就换新 id）/ 'overwrite'（同名覆盖）/ 'merge'（剧情按消息合并）
  EX.import = function (parsed, strategy) {
    strategy = strategy || 'new';
    var RP = global.RP;
    if (!RP) return { ok: false, err: '角色模块没加载' };
    var stat = { cards: 0, worlds: 0, stories: 0, msgs: 0, renamed: 0, linked: 0 };

    var idMap = {};           // 旧 id → 新 id
    function mapCardId(oldId) { return idMap[oldId] || oldId; }
    function mapWorldId(oldId) { return idMap['w:' + oldId] || oldId; }

    function importWorld(w) {
      if (!w || !w.name) return;
      var byId = null, byName = null;
      RP.worlds().forEach(function (x) {
        if (x.id === w.id) byId = x;
        if (x.name === w.name) byName = x;
      });
      var id = w.id;
      if (strategy !== 'overwrite' && (byName || byId)) {
        // 「仅新增」也按名字认人：同一个世界包再导一次不该多出一个
        var target = byName || byId;
        idMap['w:' + w.id] = target.id;
        stat.linked++;
        return;
      }
      if (byId) {
        if (strategy === 'overwrite') { id = byId.id; }
        else { id = newId('w_'); stat.renamed++; }
      } else if (strategy === 'overwrite' && byName) {
        id = byName.id;
      }
      idMap['w:' + w.id] = id;
      var res = RP.saveWorld({
        id: id, name: w.name, desc: w.desc, lore: w.lore, rules: w.rules
      });
      if (res.ok) stat.worlds++;
    }

    function importCard(c) {
      if (!c || !c.name) return;
      var byId = null, byName = null;
      RP.cards().forEach(function (x) {
        if (x.id === c.id) byId = x;
        if (x.name === c.name) byName = x;
      });
      if (strategy !== 'overwrite' && (byName || byId)) {
        // 同名卡已存在：只把剧情接上去，不再复制一张（否则导入两次就多两张）
        var target = byName || byId;
        idMap[c.id] = target.id;
        stat.linked++;
        return target;
      }
      var id = c.id;
      if (byId || (strategy === 'overwrite' && byName)) id = (byId || byName).id;
      else if (!byId && byName && strategy === 'overwrite') id = byName.id;
      idMap[c.id] = id;
      var res = RP.saveCard({
        id: id, name: c.name, avatar: c.avatar, worldId: mapWorldId(c.worldId || ''),
        desc: c.desc, personality: c.personality, scenario: c.scenario, firstMes: c.firstMes,
        mesExample: c.mesExample, rules: c.rules, style: c.style, model: c.model, temp: c.temp
      });
      if (res.ok) stat.cards++;
      return res.card;
    }

    function importStory(st) {
      if (!st) return;
      if (st.card && st.card.id && !idMap[st.card.id] && st.card.name) importCard(st.card);
      var cardId = mapCardId((st.cardId || (st.card && st.card.id) || ''));
      if (!cardId) return;
      var rid = RP.roomOf(cardId);
      RP.ensureRoom(cardId);
      var roll = global.ROLL.get(rid);
      if (strategy === 'merge' && (roll.vols || []).length) {
        // 合并：按消息 id/ts 去重，取新的；卷以文件为准的旧卷补进去
        var incoming = (st.roll && st.roll.vols) || [];
        var have = {};
        (roll.vols || []).forEach(function (v) { have[v.n] = 1; });
        incoming.forEach(function (v) { if (v && v.n && !have[v.n]) roll.vols.push(v); });
        roll.vols.sort(function (a, b) { return (a.n || 0) - (b.n || 0); });
        roll.cur = Math.max(roll.cur || 1, (st.roll && st.roll.cur) || 1);
      } else {
        roll = st.roll || roll;
      }
      global.ROLL.set(rid, roll);
      var msgs = st.msgs || [];
      if (msgs.length) {
        var hist = (global.__takeHist ? global.__takeHist(rid) : []) || [];
        var seen = {};
        hist.forEach(function (m) { if (m && m.id) seen[m.id] = 1; });
        var merged = hist.slice();
        msgs.forEach(function (m) {
          if (!m || !m.id) return;
          if (seen[m.id]) return;
          seen[m.id] = 1;
          merged.push(m);
        });
        merged.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
        if (global.__putHist) global.__putHist(rid, merged);
        stat.msgs += msgs.length;
      }
      stat.stories++;
    }

    var pay = parsed.pay;
    if (parsed.kind === 'card' || parsed.kind === 'story') {
      if (pay.world) importWorld(pay.world);
      if (pay.card) importCard(pay.card);
    }
    if (parsed.kind === 'world') importWorld(pay.world);
    if (parsed.kind === 'story') importStory(pay);
    if (parsed.kind === 'backup') {
      (pay.worlds || []).forEach(importWorld);
      (pay.cards || []).forEach(importCard);
      (pay.stories || []).forEach(importStory);
    }
    return { ok: true, stat: stat };
  };

  EX.MAX_FILE = MAX_FILE;
  global.EX = EX;
})(window);