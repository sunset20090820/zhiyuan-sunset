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
  /* 白名单只在这里维护一次（cards.js 的 RP.cardKeep），
     以前手写枚举漏了 callUser/dials/look…，导出再导入人设会归零。 */
  function cleanCard(c) {
    var keep = (window.RP && RP.cardKeep) ? RP.cardKeep() : [];
    var out = {};
    var norm = (window.RP && RP.normCard) ? RP.normCard(c) : c;
    keep.forEach(function (k) {
      if (k === 'id' || k === 'builtin') return;
      if (k === 'avatar') { out.avatar = /^data:image\//.test(String(c.avatar || '')) ? c.avatar : ''; return; }
      if (norm[k] !== undefined) out[k] = norm[k];
    });
    out.v = 3;
    return out;
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

  /* ---------- PNG 图卡（图片即卡） ----------
     PNG 的 tEXt 段里存两份数据：
       zycard → 纸鸢自己的完整卡（含自定义调节全部参数，导入时原样还原）
       chara  → 按 SillyTavern v2 的写法再存一份，方便别的软件也能读
     读的时候先看 zycard，读到就是原样卡，不再做字段映射。 */
  var CRC_TABLE = (function () {
    var t = [], c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8Bytes(str) {
    var out = [], i, c;
    str = String(str == null ? '' : str);
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c < 0xD800 || c >= 0xE000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      else {
        i++;
        c = 0x10000 + (((c & 0x3FF) << 10) | (str.charCodeAt(i) & 0x3FF));
        out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return new Uint8Array(out);
  }
  function bytesFromB64(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function b64FromBytes(u8) {
    var s = '', i, step = 0x8000;
    for (i = 0; i < u8.length; i += step) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + step));
    }
    return btoa(s);
  }
  function pngChunk(keyword, text) {
    var kw = utf8Bytes(keyword), tx = utf8Bytes(text);
    var data = new Uint8Array(kw.length + 1 + tx.length);
    data.set(kw, 0);
    data[kw.length] = 0;
    data.set(tx, kw.length + 1);
    var type = utf8Bytes('tEXt');
    var out = new Uint8Array(12 + data.length);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(type, 4);
    out.set(data, 8);
    var crcBuf = new Uint8Array(type.length + data.length);
    crcBuf.set(type, 0); crcBuf.set(data, 4);
    dv.setUint32(8 + data.length, crc32(crcBuf));
    return out;
  }
  // 在 IEND 之前插入若干 tEXt 段
  function insertTextChunks(pngBytes, chunks) {
    var u8 = pngBytes, pos = 8, iendAt = -1;
    while (pos + 8 <= u8.length) {
      var len = ((u8[pos] << 24) | (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3]) >>> 0;
      var type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
      if (type === 'IEND') { iendAt = pos; break; }
      pos = pos + 8 + len + 4;
    }
    if (iendAt < 0) return u8;
    var extra = [];
    for (var k = 0; k < chunks.length; k++) extra.push(pngChunk(chunks[k][0], chunks[k][1]));
    var add = 0;
    for (var m = 0; m < extra.length; m++) add += extra[m].length;
    var out = new Uint8Array(u8.length + add);
    out.set(u8.subarray(0, iendAt), 0);
    var at = iendAt;
    for (var n = 0; n < extra.length; n++) { out.set(extra[n], at); at += extra[n].length; }
    out.set(u8.subarray(iendAt), at);
    return out;
  }
  // SillyTavern v2 的最小兼容写法（给别的软件读；我们自己读 zycard 段）
  function stV2(card) {
    var ex = (card.mesExample || []).map(function (e) {
      return '<START>\n{{user}}: ' + (e.u || '') + '\n{{char}}: ' + (e.a || '');
    }).join('\n');
    return {
      name: card.name || '',
      description: card.desc || '',
      personality: card.personality || '',
      scenario: card.scenario || '',
      first_mes: card.firstMes || '',
      mes_example: ex,
      system_prompt: card.rules || '',
      spec: 'chara_card_v2', spec_version: '2.0',
      data: { name: card.name || '', creator_notes: card.desc || '', extensions: { paperlite: card } }
    };
  }

  /* 画一张 512×768 的图卡底图，再把卡数据塞进 tEXt；cb(err, base64) */
  EX.png = function (card, withWorld, cb) {
    var canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 768;
    var g = canvas.getContext('2d');
    var grad = g.createLinearGradient(0, 0, 512, 768);
    grad.addColorStop(0, '#e8eefc'); grad.addColorStop(1, '#f7e9f3');
    g.fillStyle = grad; g.fillRect(0, 0, 512, 768);
    var json = JSON.stringify(EX.card(card, withWorld));

    function finish() {
      try {
        var src = canvas.toDataURL('image/png');
        var png = insertTextChunks(bytesFromB64(src.split(',')[1]), [
          ['zycard', b64FromBytes(utf8Bytes(json))],
          ['chara', b64FromBytes(utf8Bytes(JSON.stringify(stV2(card))))]
        ]);
        cb(null, b64FromBytes(png));
      } catch (e) { cb(String((e && e.message) || e)); }
    }

    function decorate() {
      // 无头像时上半区太空：铺一点柔光和纸纹感的圆
      var r1 = g.createRadialGradient(140, 150, 10, 140, 150, 240);
      r1.addColorStop(0, 'rgba(122,157,255,.28)'); r1.addColorStop(1, 'rgba(122,157,255,0)');
      g.fillStyle = r1; g.beginPath(); g.arc(140, 150, 240, 0, Math.PI * 2); g.fill();
      var r2 = g.createRadialGradient(400, 320, 10, 400, 320, 220);
      r2.addColorStop(0, 'rgba(255,150,205,.22)'); r2.addColorStop(1, 'rgba(255,150,205,0)');
      g.fillStyle = r2; g.beginPath(); g.arc(400, 320, 220, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(29,35,64,.08)';
      g.font = '700 200px system-ui, -apple-system, sans-serif';
      g.fillText(String(card.name || '★').slice(0, 1), 300, 340);
    }

    function drawText() {
      g.fillStyle = '#1d2340';
      g.font = '700 40px system-ui, -apple-system, sans-serif';
      g.fillText(String(card.name || '未命名').slice(0, 12), 40, 556);
      g.font = '20px system-ui, -apple-system, sans-serif';
      g.fillStyle = 'rgba(29,35,64,.72)';
      g.fillText(String(card.desc || card.personality || '').replace(/\s+/g, ' ').slice(0, 46), 40, 600);
      var quote = String(card.firstMes || '').replace(/\s+/g, ' ').slice(0, 40);
      if (quote) {
        g.fillStyle = 'rgba(29,35,64,.5)';
        g.fillText('「' + quote + '」', 40, 640);
      }
      g.fillStyle = 'rgba(29,35,64,.42)';
      g.font = '16px system-ui, -apple-system, sans-serif';
      g.fillText('纸鸢人设卡 · 导回纸鸢即可还原全部设定', 40, 712);
      finish();
    }

    var av = String(card.avatar || '');
    if (/^data:image\//.test(av)) {
      var im = new Image();
      im.onload = function () {
        var w = im.width, h = im.height, sc = Math.min(512 / w, 476 / h);
        var dw = Math.round(w * sc), dh = Math.round(h * sc);
        g.drawImage(im, Math.round((512 - dw) / 2), Math.round((476 - dh) / 2), dw, dh);
        drawText();
      };
      im.onerror = drawText;
      im.src = av;
    } else { decorate(); drawText(); }
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
      // 导入也走白名单：v3 的结构化字段一并搬过来（旧文件没有这些字段就是空）
      var keep = (window.RP && RP.cardKeep) ? RP.cardKeep() : [];
      var card = { id: id, avatar: c.avatar, worldId: mapWorldId(c.worldId || '') };
      keep.forEach(function (k) {
        if (k === 'id' || k === 'avatar' || k === 'worldId' || k === 'builtin') return;
        if (c[k] !== undefined) card[k] = c[k];
      });
      if (!card.name) card.name = c.name;
      var res = RP.saveCard(card);
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