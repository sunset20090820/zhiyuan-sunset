/* ============================================================
   小说书源规则引擎（阅读/Legado 规则精简实现，ES5）
   支持：
     A 老语法 class.x / id.x / tag.x / text.x / children，链式 @ 组合
     B 纯 CSS 选择器（.a  #id  [attr=v]  div a）
     C .N 索引 / !N 排除 / :a:b:c 步进 / || 备选 / && 并列
     D @text @textNodes @html @href @src @content @ownText 及任意属性
     E ##正则##替换（含 $1 引用）
     F JSONPath（$.a.b[0] / $..list[*]）与规则里的 {{$.字段}}
   不支持（返回空，按失败处理）：@@ / @js: / <js> / @XPath / //xx / @get / @put
   ============================================================ */
(function (root) {
  'use strict';
  function trim(s) { return String(s == null ? '' : s).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, ''); }
  var PARSER = null;
  function parseHtml(html) {
    try { if (!PARSER) PARSER = new DOMParser(); return PARSER.parseFromString(String(html || ''), 'text/html'); }
    catch (e) { return null; }
  }

  /* ---------- 模板 ---------- */
  function buildUrl(tpl, vars) {
    var s = String(tpl || '');
    if (!s) return '';
    s = s.replace(/\{\{[\s\S]*?\}\}/g, function (m) {
      var inner = m.slice(2, -2).trim();
      if (/^key$/.test(inner)) return encodeURIComponent(vars.key || '');
      if (/^page$/.test(inner)) return String(vars.page == null ? 1 : vars.page);
      if (/^page\s*-\s*\d+$/.test(inner)) return String((vars.page || 1) - parseInt(inner.split('-')[1], 10));
      if (inner === 'host' || inner === 'baseUrl') return vars.baseUrl || vars.host || '';
      if (/^[\w-]+$/.test(inner) && vars[inner] != null) return String(vars[inner]);
      return '';   // JS 片段一律不执行
    });
    return trim(s.split('\n')[0]);
  }
  // searchUrl 可能带 ,{...} 配置（method/body/charset）
  function parseSearchUrl(tpl, vars) {
    var s = String(tpl || '');
    // 去掉开头的 {{...js...}} 块
    var guard = 0;
    while (/^\s*\{\{/.test(s) && guard++ < 5) {
      var d = 0, cut = -1;
      for (var i = 0; i < s.length - 1; i++) {
        if (s[i] === '{' && s[i + 1] === '{') { d++; i++; continue; }
        if (s[i] === '}' && s[i + 1] === '}') { d--; i++; if (d === 0) { cut = i + 1; break; } }
      }
      if (cut < 0) break;
      s = s.slice(cut);
    }
    var cfg = null, url = s;
    var m = /,\s*\{[\s\S]*\}\s*$/.exec(s);
    if (m) {
      var body = m[0].replace(/^,/, '');
      url = s.slice(0, m.index);
      try { cfg = JSON.parse(body); } catch (e) {
        try { cfg = JSON.parse(body.replace(/'/g, '"')); } catch (e2) { cfg = null; }
      }
    }
    url = buildUrl(url, vars);
    var out = { url: url, method: 'GET', body: '', charset: '' };
    if (cfg) {
      if (cfg.method) out.method = String(cfg.method).toUpperCase();
      if (cfg.body) out.body = buildUrl(cfg.body, vars);
      if (cfg.charset) out.charset = String(cfg.charset);
    }
    return out;
  }

  /* ---------- 规则拆分 ---------- */
  function splitTop(s, sep) {   // 按分隔符切，跳过 [] 和 ## 内部
    var out = [], buf = '', depth = 0, inRe = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '#' && s[i + 1] === '#') { inRe = !inRe; buf += '##'; i++; continue; }
      if (inRe) { buf += c; continue; }
      if (c === '[') depth++;
      if (c === ']') depth = Math.max(0, depth - 1);
      if (depth === 0 && s.slice(i, i + sep.length) === sep) { out.push(buf); buf = ''; i += sep.length - 1; continue; }
      buf += c;
    }
    out.push(buf);
    return out.map(trim).filter(function (x) { return x.length > 0; });
  }

  var EXTS = { text: 1, textnodes: 1, html: 1, innhtml: 1, ownerttext: 1, owntext: 1, all: 1, content: 1, href: 1, src: 1, value: 1, title: 1, children: 1 };

  // 一段（@ 之间）解析成 {sel, idx, excl, textEq}
  function parseSeg(seg) {
    var s = trim(seg), excl = [], idx = null, textEq = null;
    // 排除 !0:1:2 / !0
    var em = /!(-?[\d:]+)$/.exec(s);
    if (em) { excl = em[1].split(':').map(function (x) { return parseInt(x, 10); }); s = s.slice(0, em.index); }
    var m;
    if ((m = /^(class|id|tag|text)\.([\s\S]+)$/.exec(s))) {
      var kind = m[1], val = m[2];
      var im = /^(.*?)\.(-?\d+)$/.exec(val);
      if (im && kind !== 'text') { idx = parseInt(im[2], 10); val = im[1]; }
      if (kind === 'class') s = val.split(/\s+/).map(function (c) { return '[class~="' + c + '"]'; }).join('');
      else if (kind === 'id') s = '#' + val;
      else if (kind === 'tag') s = val;
      else { textEq = val; s = ''; }
    } else if ((m = /^(.+?)\.(-?\d+)$/.exec(s)) && !/\]$/.test(s)) {
      idx = parseInt(m[2], 10); s = m[1];
    }
    return { raw: seg, sel: trim(s), idx: idx, excl: excl, textEq: textEq };
  }

  function parseRule(rule) {
    var r = { raw: trim(rule), json: null, steps: [], ext: '', re: null, reTo: '', bad: false, alts: [] };
    var s = trim(rule);
    if (!s) { r.bad = true; return r; }
    if (/@@|@js:|@get:|@put:/.test(s)) { r.bad = true; return r; }
    var ri = s.indexOf('##');
    if (ri >= 0) {
      var tail = s.slice(ri + 2), ri2 = tail.indexOf('##');
      r.re = ri2 >= 0 ? tail.slice(0, ri2) : tail;
      r.reTo = ri2 >= 0 ? tail.slice(ri2 + 2) : '';
      s = s.slice(0, ri);
    }
    s = trim(s);
    if (/^\$\.|^\$\.\./.test(s) || /^@json:/.test(s)) { r.json = s.replace(/^@json:\s*/, ''); return r; }
    if (/^X?Path:|^\/\//i.test(s)) { r.bad = true; return r; }
    var m = /^@?css:/i.exec(s);
    if (m) s = s.slice(m[0].length);
    var parts = splitTop(s, '@');
    // 最后一段是取值方式？
    if (parts.length > 1) {
      var last = parts[parts.length - 1].toLowerCase().replace(/\s+/g, '');
      if (EXTS[last] || /^[a-z][\w-]*$/.test(last) && parts.length > 1 && !/\./.test(last)) {
        r.ext = parts.pop();
      }
    } else if (parts.length === 1 && /^(text|textNodes|html|href|src|content|ownText|title|value|children)$/i.test(trim(parts[0]))) {
      r.ext = parts.pop();
    }
    r.steps = parts.map(parseSeg).filter(function (x) { return x.sel || x.textEq != null; });
    if (!r.steps.length && !r.ext) r.bad = true;
    return r;
  }

  /* ---------- 取值 ---------- */
  function textOf(el) { return el ? trim(el.textContent || '') : ''; }
  function allText(list) { var s = ''; for (var i = 0; i < list.length; i++) s += textOf(list[i]); return s; }
  function attrOf(el, name) {
    if (!el) return '';
    var k = String(name).toLowerCase();
    if (k === 'text') return textOf(el);
    if (k === 'textnodes') return textOf(el);
    if (k === 'owntext') { var t = ''; for (var i = 0; i < el.childNodes.length; i++) { var c = el.childNodes[i]; if (c.nodeType === 3) t += c.nodeValue; } return trim(t); }
    if (k === 'html' || k === 'all') return trim(el.innerHTML || '');
    if (k === 'content') return trim((el.getAttribute && el.getAttribute('content')) || textOf(el));
    return trim((el.getAttribute && el.getAttribute(k)) || '');
  }
  function applyIndex(list, idx, excl) {
    if (excl && excl.length) list = list.filter(function (x, i) { return excl.indexOf(i) < 0; });
    if (idx == null) return list;
    var k = idx < 0 ? list.length + idx : idx;
    return list[k] ? [list[k]] : [];
  }
  function absUrl(u, base) {
    u = trim(u);
    if (!u || /^(data:|javascript:|#)/i.test(u)) return '';
    try { return new URL(u, base || 'about:blank').toString(); } catch (e) { return u; }
  }
  function applyRegex(s, re, to) {
    if (re == null) return s;
    try { return to ? String(s).replace(new RegExp(re, 'g'), to) : (String(s).match(new RegExp(re, 'g')) || []).join(''); }
    catch (e) { return s; }
  }

  /* ---------- JSONPath ---------- */
  function jsonPick(obj, path) {
    var s = trim(path).replace(/^\$\.?/, '');
    if (!s) return obj;
    var segs = [];
    s.replace(/(\.\.)?([^.[\]]+)|\[(-?\d+|\*)\]/g, function (m, deep, key, num) {
      if (num != null) segs.push({ n: num === '*' ? '*' : parseInt(num, 10) });
      else segs.push({ k: key, deep: !!deep });
      return '';
    });
    var cur = [obj];
    segs.forEach(function (seg) {
      var next = [];
      cur.forEach(function (v) {
        if (v == null) return;
        if (seg.n != null) {
          if (Array.isArray(v)) { seg.n === '*' ? next.push.apply(next, v) : (v[seg.n] !== undefined && next.push(v[seg.n])); }
          else if (isObj(v) && seg.n === '*') next.push.apply(next, Object.keys(v).map(function (k) { return v[k]; }));
        } else if (seg.deep) {
          (function walk(x) {
            if (!x || typeof x !== 'object') return;
            if (Array.isArray(x)) x.forEach(walk);
            else { for (var k in x) { if (k === seg.k) { next.push(x[k]); } else walk(x[k]); } }
          })(v);
        } else {
          var got = v[seg.k];
          if (Array.isArray(got)) next.push.apply(next, got);
          else if (got !== undefined) next.push(got);
        }
      });
      cur = next;
    });
    return cur.length === 1 ? cur[0] : cur;
  }
  function isObj(o) { return o && typeof o === 'object'; }

  /* ---------- 执行 ---------- */
  function runChain(doc, rule, base) {
    var cur = [doc];
    for (var i = 0; i < rule.steps.length; i++) {
      var st = rule.steps[i], next = [];
      for (var j = 0; j < cur.length; j++) {
        var node = cur[j];
        if (!node) continue;
        if (st.textEq != null) {
          var all = node.querySelectorAll ? node.querySelectorAll('*') : [];
          for (var q = 0; q < all.length; q++) if (trim(all[q].textContent) === st.textEq) next.push(all[q]);
          continue;
        }
        if (!st.sel) { next.push(node); continue; }
        var found = [];
        try {
          if (st.sel === ':self') found = [node];
          else if (node.querySelectorAll) found = Array.prototype.slice.call(node.querySelectorAll(st.sel));
        } catch (e) { found = []; }
        found = applyIndex(found, st.idx, st.excl);
        for (var f = 0; f < found.length; f++) next.push(found[f]);
      }
      cur = next;
      if (!cur.length) break;
    }
    return cur;
  }

  function value(doc, rule, base, json) {
    var s = trim(rule);
    if (!s) return '';
    // 规则里引用 JSON：{{$.x}}
    if (json && /\{\{\s*\$/.test(s)) {
      var t = s.replace(/\{\{\s*\$([^}]*)\}\}/g, function (m, p) {
        var v = jsonPick(json, '$' + p);
        return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      });
      return trim(t);
    }
    var alts = splitTop(s, '&&').length > 1 ? [s] : splitTop(s, '||');
    for (var a = 0; a < alts.length; a++) {
      var r = parseRule(alts[a]);
      if (r.bad) continue;
      var out = '';
      if (r.json != null) {
        var jv = json ? jsonPick(json, r.json) : '';
        out = jv == null ? '' : (typeof jv === 'string' ? jv : JSON.stringify(jv));
      } else if (doc) {
        var nodes = runChain(doc, r, base);
        if (r.ext) {
          var k = r.ext.toLowerCase();
          if (k === 'href' || k === 'src') out = absUrl(attrOf(nodes[0], r.ext), base);
          else if (k === 'text' && nodes.length > 1) out = allText(nodes);
          else if (k === 'textnodes') out = allText(nodes);
          else if (k === 'children') out = nodes.length ? nodes[0].children.length : '';
          else out = attrOf(nodes[0], r.ext);
        } else out = nodes.length > 1 ? allText(nodes) : textOf(nodes[0]);
      }
      out = applyRegex(out, r.re, r.reTo);
      if (trim(out)) return trim(out);
    }
    return '';
  }

  function list(doc, rule, base, json) {
    var s = trim(rule);
    if (!s) return [];
    var alts = splitTop(s, '||');
    for (var a = 0; a < alts.length; a++) {
      var r = parseRule(alts[a]);
      if (r.bad) continue;
      if (r.json != null) {
        var jv = json ? jsonPick(json, r.json) : null, out = [];
        (function push(v) {
          if (v == null) return;
          if (Array.isArray(v)) v.forEach(push);
          else if (isObj(v)) out.push(v);
          else if (typeof v === 'string' && trim(v)) out.push(trim(v));
        })(jv);
        if (out.length) return out;
        continue;
      }
      if (!doc) continue;
      var nodes = runChain(doc, r, base);
      if (nodes.length) return nodes;
    }
    return [];
  }

  // 在列表项内部取一段（el 可能是 DOM 节点或 JSON 对象）
  function inEl(el, rule, base, jsonNode) {
    if (!el && !jsonNode) return '';
    if (jsonNode) return value(null, rule, base, jsonNode);
    return value(el, rule, base, null);
  }

  root.BR = {
    trim: trim, buildUrl: buildUrl, parseSearchUrl: parseSearchUrl, parseHtml: parseHtml,
    one: value, list: list, inEl: inEl, json: jsonPick, absUrl: absUrl, applyRegex: applyRegex
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.BR;
})(typeof window !== 'undefined' ? window : globalThis);
