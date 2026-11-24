/* 纸鸢 · 上下文拼装（人设扮演）
 * ---------------------------------------------------------------
 * 三层拼装：system（人设/世界/规则/状态/卷摘要/事实） + 近端原文 + 当前消息。
 * 预算写死常量，按 8k / 12k / 32k 三档缩放（文档 §7.2）。
 * 本文件只负责「拼」，不负责发请求 —— 请求仍走 app.js 的 aiAskNative。
 */
(function (global) {
  'use strict';

  var CTX = {};
  CTX.TIERS = [8192, 32768, 131072, 1048576];

  /* ---------- token 估算：中文按 0.65/字，其余按 1/4 ---------- */
  var CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
  CTX.est = function (text) {
    var s = String(text == null ? '' : text), cjk = 0, other = 0, i, ch;
    for (i = 0; i < s.length; i++) {
      ch = s.charAt(i);
      if (CJK.test(ch)) cjk++; else other++;
    }
    return Math.ceil(cjk * 0.65 + other / 4);
  };

  /* ---------- 预算分配（按档位倍数缩放） ---------- */
  CTX.budgets = function (tier) {
    var b = Number(tier) || 8192;
    var k = b / 8192;
    // system 部分只按 8k→48k 缩放（k 上限 6）：1M 档不把设定区铺成几十万 token，
    // 多出来的预算全给近端原文，这才是长上下文真正该干的事
    var ks = Math.min(k, 6);
    return {
      total: b,
      card: Math.round(800 * ks),       // 角色卡 + 规则
      world: Math.round(300 * Math.min(ks, 1.6)),
      state: Math.round(300 * ks),
      vols: Math.round(600 * ks),
      lore: Math.round(300 * ks),       // 世界书命中
      facts: Math.round(220 * ks),
      reserve: Math.round(800 * ks)     // 回复预留
    };
  };

  function trim(str, tokens) {
    var s = String(str || '');
    if (!s) return '';
    var limitChars = Math.max(40, Math.floor(tokens / 0.65));
    if (s.length <= limitChars) return s;
    return s.slice(0, limitChars - 1) + '…';
  }
  CTX.trim = trim;

  /* ---------- 卷/事实（P1 才有内容；这里先按空结构读，保证接口稳定） ---------- */
  function gkKey(name) { return 'pl.global.' + name; }
  function readJSON(key) {
    try {
      if (global.PaperNative && global.PaperNative.kvGet) {
        var v = global.PaperNative.kvGet(key);
        if (v) return JSON.parse(v);
      }
    } catch (e) {}
    try {
      var l = global.localStorage.getItem(gkKey(key));
      return l ? JSON.parse(l) : null;
    } catch (e) { return null; }
  }
  CTX.rollup = function (roomId) {
    var r = readJSON('rollup.v2.' + roomId);
    return (r && typeof r === 'object') ? r : { cur: 1, budget: 8192, vols: [] };
  };

  /* ---------- 世界书命中：只在最近几条消息里找关键词 ---------- */
  function hitLore(world, recentText, max) {
    if (!world || !Array.isArray(world.lore) || !world.lore.length) return [];
    var out = [];
    for (var i = 0; i < world.lore.length && out.length < max; i++) {
      var e = world.lore[i], keys = e.keys || [];
      for (var j = 0; j < keys.length; j++) {
        if (keys[j] && recentText.indexOf(keys[j]) >= 0) { out.push(e); break; }
      }
    }
    return out;
  }

  /* ---------- 事实库：称呼 + 未完成承诺（≤5 条） ---------- */
  function factsBlock(roll) {
    var out = [];
    var vols = (roll && roll.vols) || [];
    var facts = (vols[vols.length - 1] || {}).facts || {};
    if (facts.name && facts.name.v) out.push('称呼：' + facts.name.v);
    if (facts.addr && facts.addr.v) out.push('地点：' + facts.addr.v);
    (facts.promises || []).forEach(function (p) {
      if (p && p.v && p.open && out.length < 5) out.push('未兑现：' + p.v);
    });
    (facts.open || []).forEach(function (p) {
      if (p && p.v && out.length < 5) out.push('悬念：' + p.v);
    });
    return out;
  }

  function volLoreBlock(roll) {
    var vols = (roll && roll.vols) || [];
    if (!vols.length) return '';
    var lines = [];
    vols.forEach(function (v) {
      if (!v || !v.lore) return;
      // 越旧越短：最后一卷给满，往前依次压缩
      var idx = vols.indexOf(v);
      var age = vols.length - 1 - idx;
      var cap = age === 0 ? 260 : Math.max(60, 200 - age * 60);
      lines.push('【第 ' + (v.n || (idx + 1)) + ' 卷】' + trim(v.lore, cap / 0.65));
    });
    return lines.join('\n');
  }

  /* ---------- system 拼装 ---------- */
  CTX.systemFor = function (card, world, roll, opts) {
    opts = opts || {};
    var B = CTX.budgets(opts.budget);
    var parts = {};
    var sys = [];

    var persona = [];
    persona.push('你在扮演「' + (card.name || '角色') + '」，只以这个角色的身份说话。');
    if (card.desc) persona.push('设定：' + card.desc);
    if (card.personality) persona.push('性格：' + card.personality);
    if (card.scenario) persona.push('场景：' + card.scenario);
    var st = card.style || {};
    var styleBits = [];
    if (st.len === 'short') styleBits.push('每次回复 1–3 句，不写长段');
    else if (st.len === 'mid') styleBits.push('每次回复 1–2 段');
    else if (st.len === 'long') styleBits.push('可以写到 3 段，但不要空泛');
    if (st.person === 'first') styleBits.push('用第一人称');
    if (st.person === 'third') styleBits.push('用第三人称叙述');
    if (st.banned && st.banned.length) styleBits.push('不要出现这些词/符号：' + st.banned.join('、'));
    if (card.tic) styleBits.push('口癖/说话习惯：' + card.tic);
    if (card.look) styleBits.push('外貌：' + card.look);
    if (styleBits.length) persona.push('说话方式：' + styleBits.join('；') + '。');
    if (card.callUser) persona.push('你称呼对方为「' + card.callUser + '」，不要用别的称呼。');
    if (card.relation) persona.push('你和对方的关系：' + card.relation + '。');
    if (card.likes) persona.push('你喜欢：' + card.likes + '。');
    if (card.dislikes) persona.push('你讨厌：' + card.dislikes + '。');
    if (card.secret) persona.push('你心里藏着的事（对方问起、或者时机到了才说，不要主动全盘倒出）：' + card.secret + '。');
    parts.persona = trim(persona.join('\n'), B.card);
    sys.push(parts.persona);

    if (world && world.desc) {
      parts.world = trim('世界设定（只作背景，不要直接复述）：' + world.desc, B.world);
      sys.push(parts.world);
    }

    // 情感浓度：把 5 根滑杆翻译成模型能听懂的行为指令
    var tone = [];
    var D = card.dials || {};
    var mk = function (v, lo, mid, hi) {
      v = Number(v); if (isNaN(v)) v = 50;
      return v < 30 ? lo : (v < 60 ? mid : hi);
    };
    tone.push('情绪：' + mk(D.emotion, '情绪很克制，几乎不外露，用细节和沉默表达',
      '情绪自然流露，但不夸张', '情绪起伏明显，可以激动、哽咽、发火、大笑'));
    tone.push('亲密：' + mk(D.intimacy, '保持身体和心理距离，不主动靠近',
      '朋友式的亲近，会关心对方的小事', '很亲近，可以贴近、牵手、靠在对方肩上，会主动要陪伴'));
    tone.push('主动：' + mk(D.initiative, '主要回应对方，很少主动开新话题',
      '偶尔主动抛话题', '主动推动剧情，会制造事件、提出邀请或要求'));
    tone.push('动作描写：' + mk(D.action, '以对话为主，动作只写必要的',
      '适度写动作和神态', '多写动作、神态、环境，让画面立起来'));
    tone.push('张力：' + mk(D.drama, '平稳日常，不要硬造冲突',
      '有一点小波折', '有明显冲突与转折，情节推进要快'));
    var moodMap = {
      daily: '整体基调：日常、温柔，像真的在过日子',
      sweet: '整体基调：甜，暧昧与照顾多一点，克制地表达好感',
      angst: '整体基调：虐，情绪有拉扯、有误会和未说出口的话',
      mystery: '整体基调：悬疑，留线索、留疑点，别急着解释',
      comedy: '整体基调：轻喜剧，节奏快，允许吐槽和玩笑'
    };
    if (moodMap[card.mood]) tone.push(moodMap[card.mood]);
    if (card.pace) tone.push('节奏：' + card.pace);
    parts.tone = trim('语气与情感浓度：' + tone.join('；') + '。', 260);
    sys.push(parts.tone);

    var rules = [];
    if (card.rules) rules.push(card.rules);
    if (card.limits) rules.push('这些内容一律不写：' + card.limits);
    if (world && world.rules && world.rules.length) rules.push('这个世界的规则：' + world.rules.join('；'));
    rules.push('不要出戏，不要提到「AI」「模型」「提示词」，不要解释自己在扮演。');
    parts.rules = trim(rules.join('\n'), 220);
    sys.push(parts.rules);

    var state = '';
    var vols = (roll && roll.vols) || [];
    var lastVol = vols[vols.length - 1];
    if (lastVol && lastVol.state) {
      var stv = lastVol.state;
      var bits = [];
      if (stv.time) bits.push('时间 ' + stv.time);
      if (stv.place) bits.push('地点 ' + stv.place);
      if (stv.cast && stv.cast.length) bits.push('在场 ' + stv.cast.join('、'));
      if (stv.mood) bits.push('气氛 ' + stv.mood);
      if (stv.todo) bits.push('正要 ' + stv.todo);
      state = bits.join('；');
    }
    if (state) {
      parts.state = trim('当前状态：' + state, B.state);
      sys.push(parts.state);
    }

    var vl = volLoreBlock(roll);
    if (vl) { parts.vols = trim('前情（越靠前越简略）：\n' + vl, B.vols); sys.push(parts.vols); }

    var hits = opts.loreHits || [];
    if (hits.length) {
      parts.lore = trim('设定补充：\n' + hits.map(function (h) { return '· ' + h.text; }).join('\n'), B.lore);
      sys.push(parts.lore);
    }

    var fb = factsBlock(roll);
    if (fb.length) { parts.facts = trim('要记住的事：\n' + fb.map(function (x) { return '· ' + x; }).join('\n'), B.facts); sys.push(parts.facts); }

    return { system: sys.join('\n\n'), parts: parts };
  };

  /* ---------- 近端原文窗口 ---------- */
  function toMsgs(hist, excludeId, maxMsgs) {
    var out = [];
    var arr = (hist || []).filter(function (m) {
      return m && !m.sys && !m.typing && String(m.text || '').length && m.id !== excludeId;
    });
    arr = arr.slice(-maxMsgs);
    arr.forEach(function (m) {
      var out2 = m.out === true || m.self === true;
      out.push({ role: out2 ? 'user' : 'assistant', content: String(m.text || '').slice(0, 4000) });
    });
    return out;
  }
  CTX.toMsgs = toMsgs;

  /* ---------- 主入口：build ---------- */
  CTX.build = function (roomId, opts) {
    opts = opts || {};
    var card = opts.card || (global.RP && RP.card(opts.cardId || (RP.cardIdOfRoom(roomId))));
    var world = opts.world || (card && card.worldId && RP.world(card.worldId)) || null;
    var roll = opts.roll || CTX.rollup(roomId);
    var B = CTX.budgets(opts.budget);
    var hist = opts.hist || [];

    var recentText = hist.slice(-6).map(function (m) { return String(m.text || ''); }).join('\n') + '\n' + String(opts.userText || '');
    var hits = hitLore(world, recentText, 2);

    var sysPack = CTX.systemFor(card, world, roll, { budget: B.total, loreHits: hits });
    var estSys = CTX.est(sysPack.system);

    var left = B.total - estSys - B.reserve;
    var msgs = [];
    // 示例对话：只在第一轮（没有历史）时注入，省 token
    if (hist.length < 4 && card && card.mesExample && card.mesExample.length) {
      for (var i = 0; i < card.mesExample.length && i < 3; i++) {
        var ex = card.mesExample[i];
        if (ex.u) msgs.push({ role: 'user', content: ex.u });
        if (ex.a) msgs.push({ role: 'assistant', content: ex.a });
      }
      left -= CTX.est(msgs.map(function (m) { return m.content; }).join(''));
    }
    var rest = toMsgs(hist, opts.excludeId, 40);
    var kept = [];
    for (var j = rest.length - 1; j >= 0; j--) {
      var e = CTX.est(rest[j].content);
      if (left - e < 200 && kept.length >= 4) break;
      kept.unshift(rest[j]);
      left -= e;
    }
    var all = msgs.concat(kept);
    var est = estSys + CTX.est(all.map(function (m) { return m.content; }).join('')) + CTX.est(opts.userText || '');
    return {
      system: sysPack.system,
      messages: all,
      est: est,
      budget: B.total,
      parts: sysPack.parts,
      loreHits: hits,
      roll: roll
    };
  };

  /* ---------- 诊断用：一段人类可读的拼装报告 ---------- */
  CTX.report = function (pack) {
    if (!pack) return '（没有上下文）';
    var p = pack.parts || {};
    var row = function (k, v) { return k + ' ' + CTX.est(v || '') + ' / ' + String(v || '').length + ' 字'; };
    var lines = [
      '预算 ' + pack.budget + ' · 估算 ' + pack.est + ' (' + Math.round(pack.est / pack.budget * 100) + '%)',
      row('人设', p.persona),
      row('世界', p.world),
      row('规则', p.rules),
      row('状态', p.state),
      row('前情', p.vols),
      row('设定补充', p.lore),
      row('事实', p.facts),
      '近端原文 ' + pack.messages.length + ' 条'
    ];
    return lines.join('\n');
  };

  global.CTX = CTX;
})(window);