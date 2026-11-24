/* 纸鸢 · 卷与记忆（人设扮演的长期上下文）
 * ---------------------------------------------------------------
 * 一个会话 = 多卷：每卷有原文区间 range、叙事摘要 lore、事实表 facts、状态 state。
 * 规则（文档 §7.5）：
 *   · facts 只增改不压，每条带 src 可回溯
 *   · 摘要从原文重算（不是摘要再摘要）
 *   · 满了换卷不换会话：roomId 不变，cur++
 * 本文件只做数据与 prompt；请求由 app.js 用原生 aiAsk 发。
 */
(function (global) {
  'use strict';

  var ROLL = {};
  var SUMMARIZE_EVERY = 12;        // 每 12 条新消息压一次
  var ROLL_AT = 0.92;              // 估算超过预算 92% 就换卷
  var LORE_MAX = 600;

  function gkKey(roomId) { return 'pl.global.rollup.v2.' + roomId; }

  function read(roomId) {
    var raw = '';
    try {
      if (global.PaperNative && global.PaperNative.kvGet) raw = global.PaperNative.kvGet(gkKey(roomId)) || '';
    } catch (e) {}
    if (!raw) { try { raw = global.localStorage.getItem(gkKey(roomId)) || ''; } catch (e) {} }
    var o = null;
    try { o = raw ? JSON.parse(raw) : null; } catch (e) { o = null; }
    if (!o || typeof o !== 'object') return { cur: 1, vols: [], budget: 0, lastSumId: '' };
    if (!Array.isArray(o.vols)) o.vols = [];
    if (!o.cur) o.cur = 1;
    return o;
  }

  function write(roomId, roll) {
    var s = JSON.stringify(roll);
    try { if (global.PaperNative && global.PaperNative.kvPut) global.PaperNative.kvPut(gkKey(roomId), s); } catch (e) {}
    try { global.localStorage.setItem(gkKey(roomId), s); } catch (e) {}
    return roll;
  }

  ROLL.get = read;
  ROLL.set = write;
  ROLL.SUMMARIZE_EVERY = SUMMARIZE_EVERY;

  function curVol(roll) {
    var v = null;
    (roll.vols || []).forEach(function (x) { if (x && x.n === roll.cur) v = x; });
    if (!v) {
      v = { n: roll.cur || 1, range: ['', ''], lore: '', facts: {}, state: {}, tail: [], ts: Date.now() };
      roll.vols.push(v);
    }
    if (!v.facts) v.facts = {};
    if (!v.state) v.state = {};
    return v;
  }
  ROLL.curVol = curVol;

  /* ---------- 还没被压过的原文 ---------- */
  ROLL.pendingRange = function (roll, hist, excludeId) {
    var lastId = roll.lastSumId || '';
    var startAt = 0;
    if (lastId) {
      for (var i = hist.length - 1; i >= 0; i--) {
        if (hist[i] && hist[i].id === lastId) { startAt = i + 1; break; }
      }
    }
    var out = [];
    for (var j = startAt; j < hist.length; j++) {
      var m = hist[j];
      if (!m || m.sys || m.typing || !String(m.text || '').length) continue;
      if (excludeId && m.id === excludeId) continue;
      out.push(m);
    }
    return out;
  };

  ROLL.shouldSummarize = function (roll, hist, budget, est) {
    var pend = ROLL.pendingRange(roll, hist, '');
    if (pend.length >= SUMMARIZE_EVERY) return true;
    if (est && budget && est > budget * 0.70 && pend.length >= 4) return true;
    return false;
  };

  ROLL.shouldRoll = function (roll, est, budget) {
    return !!(est && budget && est > budget * ROLL_AT);
  };

  /* ---------- prompt ---------- */
  function isOut(m, me) {
    return m && (m.out === true || m.self === true);
  }
  ROLL.dialogText = function (msgs, nameOf) {
    return (msgs || []).map(function (m) {
      var who = isOut(m) ? '用户' : (m.name || '角色');
      return '[' + (m.id || '') + '] ' + who + '：' + String(m.text || '').slice(0, 1200);
    }).join('\n');
  };

  ROLL.summaryPrompt = function (dialog, loreMax) {
    return '你是对话压缩器，不是创作者。把下面这段角色扮演对话压成三部分，只输出 JSON，不要代码块、不要解释。\n\n' +
      '要求：\n' +
      '- lore：第三人称、只陈述发生过的事实，禁用形容词与评价，≤' + (loreMax || LORE_MAX) + ' 字\n' +
      '- facts.ops：只抽取长期影响剧情的项（称呼/地点/物品/承诺/悬念），op 取 ADD | UPDATE | DELETE，' +
      'key 取 name | addr | items | promises | open | 其它自定短词，每条带 src（消息 id）\n' +
      '- state：当前时间、地点、在场人物、情绪、待处理事项\n' +
      '- 必须保留：称呼、承诺及其是否兑现、未完成伏笔、专有名词\n\n' +
      '输出格式：{"lore":"...","facts":{"ops":[{"op":"ADD","key":"name","v":"...","src":"m12"}]},"state":{"time":"","place":"","cast":[],"mood":"","todo":""}}\n\n' +
      '对话：\n' + dialog;
  };

  ROLL.handoffPrompt = function (roll, tailMsgs, styleAnchor) {
    var vols = roll.vols || [];
    var prev = vols[vols.length - 1] || {};
    var facts = prev.facts || {};
    var bits = [];
    if (facts.name && facts.name.v) bits.push('称呼：' + facts.name.v);
    (facts.promises || []).slice(0, 3).forEach(function (p) { if (p && p.v && p.open) bits.push('未兑现：' + p.v); });
    (facts.open || []).slice(0, 2).forEach(function (p) { if (p && p.v) bits.push('悬念：' + p.v); });
    var st = prev.state || {};
    var stateStr = [st.time, st.place, st.mood, st.todo].filter(Boolean).join('；');
    return '【接续第 ' + ((prev.n || 1) + 1) + ' 卷】\n' +
      '前情：' + String(prev.lore || '').slice(0, 600) + '\n' +
      '现状：' + (stateStr || '（未记录）') + '\n' +
      '关键：' + (bits.join('；') || '（无）') + '\n' +
      '文风：' + (styleAnchor || '延续上一卷的语气与句长，不要突然变成说明文') + '\n' +
      '以下是你最近的原话，保持同样的语气：\n' +
      (tailMsgs || []).map(function (m) { return String(m.text || '').slice(0, 300); }).join('\n');
  };

  /* ---------- 应用摘要 ---------- */
  ROLL.applySummary = function (roll, sum, msgs) {
    var v = curVol(roll);
    var ids = (msgs || []).map(function (m) { return m.id; }).filter(Boolean);
    if (!ids.length) return roll;
    if (!v.range || !v.range[0]) v.range = [ids[0], ids[ids.length - 1]];
    else v.range[1] = ids[ids.length - 1];
    if (sum && sum.lore) v.lore = String(sum.lore).slice(0, 2400);
    if (sum && sum.state && typeof sum.state === 'object') {
      v.state = {
        time: String(sum.state.time || ''),
        place: String(sum.state.place || ''),
        cast: Array.isArray(sum.state.cast) ? sum.state.cast.slice(0, 8) : [],
        mood: String(sum.state.mood || ''),
        todo: String(sum.state.todo || '')
      };
    }
    var ops = (sum && sum.facts && sum.facts.ops) || [];
    applyOps(v.facts || (v.facts = {}), ops);
    v.tail = ids.slice(-3);
    v.ts = Date.now();
    v.degraded = !!(sum && sum.degraded);
    roll.lastSumId = ids[ids.length - 1];
    return roll;
  };

  function applyOps(facts, ops) {
    (ops || []).forEach(function (o) {
      if (!o || !o.key) return;
      var key = String(o.key);
      var val = o.v;
      var src = o.src || '';
      var op = String(o.op || 'ADD').toUpperCase();
      if (key === 'name' || key === 'addr') {
        if (op === 'DELETE') { delete facts[key]; return; }
        facts[key] = { v: String(val || '').slice(0, 80), src: src };
        return;
      }
      if (key === 'items') {
        facts.items = facts.items || { v: [] };
        var arr = facts.items.v || [];
        if (op === 'DELETE') facts.items.v = arr.filter(function (x) { return String(x) !== String(val); });
        else if (val && arr.indexOf(String(val)) < 0) arr.push(String(val).slice(0, 60));
        facts.items.v = arr.slice(0, 20);
        return;
      }
      if (key === 'promises' || key === 'open') {
        var list = facts[key] || (facts[key] = []);
        if (op === 'DELETE') {
          facts[key] = list.filter(function (x) { return !(x && (x.src === src || String(x.v) === String(val))); });
          return;
        }
        if (op === 'UPDATE') {
          for (var i = 0; i < list.length; i++) {
            if (list[i] && (list[i].src === src || String(list[i].v) === String(val))) {
              list[i].v = String(val || list[i].v).slice(0, 200);
              if (o.open === false) list[i].open = false;
              return;
            }
          }
        }
        if (val) list.push({ v: String(val).slice(0, 200), src: src, open: o.open !== false });
        facts[key] = list.slice(-12);
        return;
      }
      // 自定短词：直接当字符串事实存
      if (op === 'DELETE') delete facts[key];
      else facts[key] = { v: String(val || '').slice(0, 120), src: src };
    });
  }
  ROLL.applyOps = applyOps;

  /* ---------- 解析模型返回 ---------- */
  ROLL.parseSummary = function (text) {
    var s = String(text || '').trim();
    var i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
    var out = null;
    try { out = JSON.parse(s); } catch (e) { out = null; }
    if (!out || typeof out !== 'object') {
      return { lore: String(text || '').slice(0, 800), facts: { ops: [] }, state: {}, degraded: true };
    }
    if (!out.facts) out.facts = { ops: [] };
    if (!Array.isArray(out.facts.ops)) out.facts.ops = [];
    if (!out.state || typeof out.state !== 'object') out.state = {};
    out.lore = String(out.lore || '').slice(0, 2400);
    return out;
  };

  /* ---------- 换卷 ---------- */
  ROLL.startVolume = function (roll, handoff) {
    var nextN = (roll.cur || 1) + 1;
    roll.cur = nextN;
    roll.vols.push({
      n: nextN, range: ['', ''], lore: String(handoff || '').slice(0, 1400),
      facts: {}, state: {}, tail: [], ts: Date.now(), handoff: String(handoff || '').slice(0, 2000),
      rolled: true
    });
    return roll;
  };

  /* ---------- 原文归档（卷切走后把原文存原生，localStorage 只留近的） ---------- */
  ROLL.archive = function (roomId, msgs) {
    if (!msgs || !msgs.length) return 0;
    try {
      if (global.PaperNative && global.PaperNative.kvPut) {
        global.PaperNative.kvPut('hist.' + roomId + '.' + Date.now(), JSON.stringify(msgs));
        return msgs.length;
      }
    } catch (e) {}
    return 0;
  };

  ROLL.loadArchive = function (key) {
    try {
      if (global.PaperNative && global.PaperNative.kvGet) {
        var raw = global.PaperNative.kvGet(key) || '';
        if (raw) return JSON.parse(raw);
      }
    } catch (e) {}
    return null;
  };

  /* ---------- 诊断文本 ---------- */
  ROLL.report = function (roll) {
    var v = curVol(roll);
    return [
      '第 ' + roll.cur + ' 卷 · 共 ' + (roll.vols || []).length + ' 卷',
      '前情 ' + String(v.lore || '').length + ' 字',
      '事实 ' + Object.keys(v.facts || {}).length + ' 项',
      '状态 ' + (v.state && (v.state.time || v.state.place) ? (v.state.time || '') + ' ' + (v.state.place || '') : '未记录'),
      '已压到 ' + (roll.lastSumId || '（还没压过）')
    ].join(' · ');
  };

  global.ROLL = ROLL;
})(window);