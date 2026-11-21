/* 纸鸢 · 狼人杀客户端
   与服务端 game/werewolf.js 对话：只渲染服务端下发的信息，不推断任何身份。 */
(function () {
  'use strict';

  var G = {
    open: false,
    room: null,          // 当前房间（公开数据）
    you: null,           // {seat, role, alive}
    mates: [],           // 狼队友
    stage: '',           // lobby|room|night|dawn|speech|vote|shoot|result
    rooms: [], boards: [], defaults: {},
    night: null,         // 最近一条 ww_night
    witch: null, guard: null,
    checkResult: null, lover: null,
    dawn: null, speech: null, voteStart: null, voteResult: null,
    shoot: null, result: null,
    toastMsg: '',
    micPerm: { ok: false, scope: null, reason: '' },
    wolfPicks: null,     // { votes:[{seat,target,picked}], agreed, target }
    timer: null,
  };

  var ROLE_NAME = {
    wolf: '狼人', wolfking: '狼王', wolfbeauty: '狼美人', seer: '预言家', witch: '女巫',
    guard: '守卫', hunter: '猎人', fool: '白痴', knight: '骑士', cupid: '丘比特', villager: '平民',
  };
  var ROLE_EMOJI = {
    wolf: '🐺', wolfking: '🐺', wolfbeauty: '🐺', seer: '🔮', witch: '🧪',
    guard: '🛡', hunter: '🏹', fool: '🃏', knight: '⚔️', cupid: '💘', villager: '👤',
  };
  var STATE_NAME = {
    waiting: '等待中', night: '天黑请闭眼', dawn: '天亮了', speech: '发言中',
    vote: '投票中', shoot: '开枪', settlement: '已结束',
  };

  function $(s) { return document.querySelector(s); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function send(obj) {
    if (window.__zySend) { window.__zySend(obj); return true; }
    return false;
  }
  function toast(msg) {
    G.toastMsg = msg;
    var el = $('#wwToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(G._tt);
    G._tt = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  /* ---------------- 音效 / 法官语音 ---------------- */
  var SFX = { on: true, judge: true };
  var actx = null;
  function ac() {
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
    }
    if (actx && actx.state === 'suspended') { try { actx.resume(); } catch (e) {} }
    return actx;
  }
  /** 合成音效，不需要音频文件 */
  function beep(freq, dur, type, vol) {
    if (!SFX.on) return;
    var ctx = ac();
    if (!ctx) return;
    try {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.value = vol == null ? 0.13 : vol;
      o.connect(g); g.connect(ctx.destination);
      var t0 = ctx.currentTime;
      g.gain.setValueAtTime(g.gain.value, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.start(t0); o.stop(t0 + dur + 0.02);
    } catch (e) {}
  }
  function sfx(name) {
    switch (name) {
      case 'night': beep(220, .5, 'sine', .12); setTimeout(function () { beep(165, .7, 'sine', .1); }, 240); break;
      case 'deal': [392, 523, 659, 784].forEach(function (f, i) { setTimeout(function () { beep(f, .16, 'triangle', .1); }, i * 90); }); break;
      case 'seat': beep(880, .05, 'sine', .05); break;
      case 'turn': beep(660, .12, 'sine', .12); setTimeout(function () { beep(880, .18, 'sine', .1); }, 120); break;
      case 'death': beep(140, .5, 'sawtooth', .11); break;
      case 'wolf': beep(110, .55, 'sawtooth', .09); setTimeout(function () { beep(98, .5, 'sawtooth', .07); }, 200); break;
      case 'flip': beep(520, .1, 'square', .09); setTimeout(function () { beep(300, .16, 'square', .08); }, 100); break;
      case 'dawn': beep(520, .22, 'triangle', .12); setTimeout(function () { beep(660, .3, 'triangle', .1); }, 180); break;
      case 'click': beep(760, .07, 'square', .06); break;
      case 'vote': beep(420, .12, 'square', .08); break;
      case 'out': beep(180, .3, 'sawtooth', .1); setTimeout(function () { beep(120, .4, 'sawtooth', .09); }, 200); break;
      case 'win': [523, 659, 784].forEach(function (f, i) { setTimeout(function () { beep(f, .28, 'triangle', .12); }, i * 140); }); break;
      case 'lose': [392, 330, 262].forEach(function (f, i) { setTimeout(function () { beep(f, .34, 'sine', .12); }, i * 170); }); break;
      default: beep(600, .1, 'sine', .08);
    }
  }
  /** 法官语音播报（系统 TTS；不可用时静默跳过） */
  function judge(text) {
    if (!SFX.judge || !text) return;
    try {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN'; u.rate = 1.0; u.pitch = 1.0; u.volume = 1;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }
  function judgeStop() { try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {} }

  /* ---------------- 麦克风（按住说话，游戏内语音） ---------------- */
  var mic = { rec: null, chunks: [], start: 0, stream: null, timer: null, held: false };
  function micSupported() {
    return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  function micStart() {
    if (!micSupported()) return toast('这个系统不支持录音');
    if (mic.held) return;
    mic.held = true;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      mic.stream = stream;
      mic.chunks = [];
      var mime = '';
      try {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
        else if (MediaRecorder.isTypeSupported('audio/webm')) mime = 'audio/webm';
        else if (MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4';
      } catch (e) {}
      try { mic.rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) { try { mic.rec = new MediaRecorder(stream); } catch (e2) { toast('这台设备不支持录音'); micCleanup(); return; } }
      mic.rec.ondataavailable = function (e) { if (e.data && e.data.size) mic.chunks.push(e.data); };
      mic.rec.onstop = function () {
        var rec = mic.rec;
        var secs = Math.max(1, Math.round((Date.now() - mic.start) / 1000));
        var chunks = mic.chunks.slice();
        micCleanup();
        if (!chunks.length) return;
        var blob = new Blob(chunks, { type: (rec && rec.mimeType) || 'audio/webm' });
        var fr = new FileReader();
        fr.onload = function () {
          var data = String(fr.result || '');
          if (data.length > 700 * 1024) return toast('语音太长，说短一点（≤10 秒）');
          send({ t: 'ww_voice', data: data, mime: blob.type || 'audio/webm', duration: secs });
        };
        fr.readAsDataURL(blob);
      };
      mic.start = Date.now();
      mic.rec.start();
      sfx('click');
      mic.timer = setTimeout(function () { if (mic.held) micStop(); }, 10000);   // 最长 10 秒
    }).catch(function (err) {
      mic.held = false;
      var nm = err && err.name || '';
      toast(nm === 'NotAllowedError' ? '麦克风被拒绝：去系统设置给纸鸢开麦克风权限' : '录音启动失败');
    });
  }
  function micStop() {
    mic.held = false;
    clearTimeout(mic.timer);
    try { if (mic.rec && mic.rec.state === 'recording') mic.rec.stop(); } catch (e) {}
  }
  function micCleanup() {
    try { if (mic.stream) mic.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    mic.stream = null; mic.rec = null; mic.chunks = []; mic.held = false;
  }
  /** 播放别人发来的语音 */
  var voicePlayer = null;
  function playVoice(d) {
    try {
      if (!voicePlayer) { voicePlayer = new Audio(); document.body.appendChild(voicePlayer); }
      voicePlayer.src = d.data;
      voicePlayer.play().catch(function () {});
    } catch (e) {}
  }

  /* ---------------- 实时语音（连续推流） ---------------- */
  var RT = {
    on: false, ctx: null, stream: null, src: null, proc: null,
    seq: 0, playCtx: null, nextAt: 0, recvGain: null, lastSeat: 0,
  };
  function rtCanUse() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      (window.AudioContext || window.webkitAudioContext));
  }
  /** 开始推流：8kHz 单声道 Int16 分帧发送 */
  function rtStart() {
    if (RT.on) return true;
    if (!rtCanUse()) { toast('这个系统不支持实时语音'); return false; }
    try {
      RT.ctx = new (window.AudioContext || window.webkitAudioContext)();
      RT.stream = null;
    } catch (e) { toast('音频引擎启动失败'); return false; }
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        RT.stream = stream;
        RT.src = RT.ctx.createMediaStreamSource(stream);
        var bufSize = 2048;
        RT.proc = RT.ctx.createScriptProcessor(bufSize, 1, 1);
        var ratio = (RT.ctx.sampleRate || 48000) / 8000;
        var pending = [];
        var lastSend = 0;
        RT.proc.onaudioprocess = function (ev) {
          if (!RT.on) return;
          var ch = ev.inputBuffer.getChannelData(0);
          var outLen = Math.floor(ch.length / ratio);
          for (var k = 0; k < outLen; k++) {
            var v = ch[Math.floor(k * ratio)] || 0;
            pending.push(Math.max(-1, Math.min(1, v)) * 0x7fff);
          }
          var now2 = Date.now();
          if (now2 - lastSend < 260) return;        // 约 4 帧/秒，够流畅也不打爆限流
          lastSend = now2;
          var pcm = new Int16Array(pending);
          pending = [];
          var bytes = new Uint8Array(pcm.buffer);
          var bin = '';
          for (var j = 0; j < bytes.length; j++) bin += String.fromCharCode(bytes[j]);
          send({ t: 'ww_audio', seq: ++RT.seq, fmt: 'pcm8', data: btoa(bin) });
        };
        RT.src.connect(RT.proc);
        RT.proc.connect(RT.ctx.destination);   // 需要连到 destination 才会跑（音量置 0 不影响）
        try { RT.proc.disconnect && null; } catch (e) {}
        RT.on = true;
        syncMicState();
      })
      .catch(function (err) {
        var nm = err && err.name || '';
        toast(nm === 'NotAllowedError' ? '麦克风被拒绝：去系统设置给纸鸢开麦克风' : '麦克风启动失败');
      });
    return true;
  }
  function rtStop() {
    RT.on = false;
    try { if (RT.proc) RT.proc.disconnect(); } catch (e) {}
    try { if (RT.src) RT.src.disconnect(); } catch (e) {}
    try { if (RT.stream) RT.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (RT.ctx && RT.ctx.close) RT.ctx.close(); } catch (e) {}
    RT.ctx = null; RT.proc = null; RT.src = null; RT.stream = null;
    syncMicState();
  }
  /** 播放收到的音频帧（8kHz Int16） */
  function rtPlay(d) {
    try {
      if (!RT.playCtx) RT.playCtx = new (window.AudioContext || window.webkitAudioContext)();
      var ctx = RT.playCtx;
      if (ctx.state === 'suspended') ctx.resume();
      var bin = atob(d.data || '');
      var len = bin.length >> 1;
      if (!len) return;
      var buf = ctx.createBuffer(1, len, 8000);
      var out = buf.getChannelData(0);
      for (var i = 0; i < len; i++) {
        var lo = bin.charCodeAt(i * 2), hi = bin.charCodeAt(i * 2 + 1);
        var v = (hi << 8) | lo;
        if (v >= 0x8000) v -= 0x10000;
        out[i] = v / 0x8000;
      }
      var srcNode = ctx.createBufferSource();
      srcNode.buffer = buf;
      if (!RT.recvGain) { RT.recvGain = ctx.createGain(); RT.recvGain.gain.value = 1.2; RT.recvGain.connect(ctx.destination); }
      srcNode.connect(RT.recvGain);
      var now2 = ctx.currentTime;
      if (RT.nextAt < now2 + 0.05) RT.nextAt = now2 + 0.12;   // 小缓冲，抗抖动
      srcNode.start(RT.nextAt);
      RT.nextAt += buf.duration;
      if (d.seat !== RT.lastSeat) { RT.lastSeat = d.seat; syncMicState(); }
    } catch (e) {}
  }
  function syncMicState() {
    var b = $('#wwMic');
    if (b) {
      var perm = G.micPerm || {};
      b.classList.toggle('live', RT.on);
      b.disabled = !perm.ok && !RT.on;
      if (RT.on) b.textContent = '🎙 正在开麦（点一下关麦）';
      else if (perm.ok) b.textContent = '🎤 可以开麦：' + (perm.scope === 'wolves' ? '狼队内部' : '全场可听');
      else b.textContent = '🔇 现在不能开麦';
    }
    var hint = $('#wwMicHint');
    if (hint) hint.textContent = (G.micPerm && G.micPerm.reason) || '';
  }

  /** 全屏一次性动画：flash（白闪）/ night（天黑遮罩）/ wolf（狼人） */
  function fx(kind) {
    try {
      var el = document.createElement('div');
      el.className = 'ww-fx ww-fx-' + kind;
      document.body.appendChild(el);
      setTimeout(function () { el.classList.add('go'); }, 20);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1100);
    } catch (e) {}
  }

  /* ---------------- 页面骨架 ---------------- */
  function ensurePage() {
    if ($('#gamePage')) return;
    var page = document.createElement('section');
    page.id = 'gamePage';
    page.className = 'game hidden';
    page.innerHTML = [
      '<header class="topbar game-top">',
      '  <button id="wwBack" class="icon-btn back" type="button" aria-label="返回">‹</button>',
      '  <div class="brand">狼人杀<span id="wwState" class="ww-state"></span></div>',
      '  <button id="wwSfx" class="icon-btn ww-tog" type="button" aria-label="音效">🔊</button>',
      '  <button id="wwJudge" class="icon-btn ww-tog" type="button" aria-label="法官语音">🗣️</button>',
      '  <button id="wwRefresh" class="icon-btn" type="button" aria-label="刷新">⟳</button>',
      '</header>',
      '<div id="wwBody" class="ww-body"></div>',
      '<div id="wwMicBar" class="ww-micbar hidden">' +
      '  <button id="wwMic" class="ww-mic" type="button">🎤 实时语音</button>' +
      '  <span id="wwMicHint" class="ww-michint"></span>' +
      '</div>',
      '<div id="wwToast" class="ww-toast"></div>',
    ].join('');
    document.body.appendChild(page);
    $('#wwBack').addEventListener('click', function () { close(); });
    var micBtn = $('#wwMic');
    if (micBtn) {
      micBtn.addEventListener('click', function () {
        if (RT.on) { rtStop(); toast('已关麦'); return; }
        if (!G.micPerm || !G.micPerm.ok) {
          var why = (G.micPerm && G.micPerm.reason) || '现在不能开麦';
          toast(why);
          send({ t: 'ww_mic_ask' });     // 顺手向服务端确认一次权限
          return;
        }
        if (rtStart()) toast(G.micPerm.scope === 'wolves' ? '已开麦：只有狼队友能听到' : '已开麦：同局玩家都能听到');
      });
    }
    $('#wwSfx').addEventListener('click', function () {
      SFX.on = !SFX.on;
      $('#wwSfx').classList.toggle('off', !SFX.on);
      $('#wwSfx').textContent = SFX.on ? '🔊' : '🔇';
      if (SFX.on) sfx('click');
    });
    $('#wwJudge').addEventListener('click', function () {
      SFX.judge = !SFX.judge;
      $('#wwJudge').classList.toggle('off', !SFX.judge);
      $('#wwJudge').textContent = SFX.judge ? '🗣️' : '🤐';
      if (!SFX.judge) judgeStop(); else judge('法官已开启');
    });
    $('#wwRefresh').addEventListener('click', function () {
      if (G.room) send({ t: 'ww_join', id: G.room.id }); else send({ t: 'ww_list' });
    });
  }

  function open() {
    ensurePage();
    document.body.classList.add('in-game');
    $('#gamePage').classList.remove('hidden');
    G.open = true;
    if (!G.rooms.length) send({ t: 'ww_list' });
    send({ t: 'ww_boards' });
    render();
  }
  function close() {
    var p = $('#gamePage');
    if (p) p.classList.add('hidden');
    document.body.classList.remove('in-game');
    judgeStop();
    try { if (voicePlayer) voicePlayer.pause(); } catch (e) {}
    rtStop();
    G.open = false;
    if (G.room) leaveRoom();
  }
  function leaveRoom() {
    if (!G.room) return;
    send({ t: 'ww_leave', id: G.room.id });
    G.room = null; G.you = null; G.stage = 'lobby';
    G.night = G.dawn = G.speech = G.voteStart = G.voteResult = G.result = null;
    G.checkResult = G.witch = G.guard = G.lover = G.shoot = null;
  }

  function syncMicBar() {
    var bar = $('#wwMicBar');
    if (!bar) return;
    var inGame = !!(G.room && G.room.state && G.room.state !== 'waiting' && G.room.state !== 'settlement');
    bar.classList.toggle('hidden', !inGame);
    if (inGame) { try { send({ t: 'ww_mic_ask' }); } catch (e) {} }
    syncMicState();
  }

  /* ---------------- 渲染（网易式布局） ---------------- */
  function render() {
    if (!G.open) return;
    syncMicBar();
    var body = $('#wwBody');
    if (!body) return;
    var st = G.room ? (G.room.state || 'waiting') : '';
    if ($('#wwState')) $('#wwState').textContent = st ? (STATE_NAME[st] || st) : '';
    if (!G.room) return renderLobby(body);
    if (st === 'waiting') return renderWaiting(body);
    if (st === 'settlement' || G.stage === 'result') return renderResult(body);
    return renderTable(body);
  }

  /* 首页：房间列表（最多 3 个） */
  function renderLobby(body) {
    var list = G.rooms || [];
    body.innerHTML = [
      '<div class="ww-lobbylist">',
      '<div class="ww-list-head"><span>房间列表</span><b>' + list.length + ' / 3</b></div>',
      list.length ? list.map(function (r) {
        var full = r.players >= r.max;
        var mine = r.state !== 'waiting';
        return '<button class="ww-card' + (mine ? ' playing' : '') + '" type="button" data-join="' + esc(r.id) + '">' +
          '<div class="ww-card-top"><b>' + esc(r.boardName) + '</b><em>' + (STATE_NAME[r.state] || r.state) + '</em></div>' +
          '<div class="ww-card-mid"><span class="ww-card-host">房主 ' + esc(r.hostName || '') + '</span>' +
          '<span class="ww-card-count">' + r.players + '/' + r.max + ' 人</span></div>' +
          '<div class="ww-card-go">' + (full ? '已满' : (mine ? '加入' : '加入')) + '</div>' +
          '</button>';
      }).join('') : '<div class="ww-empty-card">还没有房间<br><small>点下面新建一个，或叫朋友开房</small></div>',
      '</div>',
      '<div class="ww-lobby-actions">',
      '  <button id="wwCreate" class="primary" type="button">＋ 创建房间</button>',
      '  <button id="wwQuick" class="flat" type="button">有房间就进最快的</button>',
      '</div>',
    ].join('');
    $('#wwCreate').addEventListener('click', openCreate);
    $('#wwQuick').addEventListener('click', function () {
      var r = list.find(function (x) { return x.state === 'waiting' && x.players < x.max; });
      if (!r) return toast('现在没有可加入的房间');
      send({ t: 'ww_join', id: r.id });
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-join]'), function (b) {
      b.addEventListener('click', function () { sfx('click'); send({ t: 'ww_join', id: b.getAttribute('data-join') }); });
    });
  }

  /* 圆桌：座位沿椭圆分布 */
  function tableHtml() {
    var ps = (G.room.players || []).slice().sort(function (a, b) { return a.seat - b.seat; });
    var n = Math.max(ps.length, 1);
    // 座位占比随人数缩小：6 人 21%、9 人 16%、12 人 13%
    var seatW = Math.max(11, Math.min(21, Math.round(126 / n)));
    var radiusX = n >= 11 ? 41 : (n >= 9 ? 40 : 39);
    var radiusY = n >= 11 ? 40 : (n >= 9 ? 38.5 : 37);
    var seats = ps.map(function (p, i) {
      var ang = (-90 + i * 360 / n) * Math.PI / 180;
      var x = 50 + Math.cos(ang) * radiusX;
      var y = 50 + Math.sin(ang) * radiusY;
      var me = G.you && G.you.seat === p.seat;
      var speak = G.speech && G.speech.seat === p.seat;
      var cls = 'ww-p' + (p.alive ? '' : ' dead') + (me ? ' me' : '') + (speak ? ' speaking' : '') +
        (p.justDied ? ' dying' : '') +
        (p.connected === false ? ' off' : '') + (p.bot ? ' bot' : '');
      var pickTag = '';
      if (G.wolfPicks && G.wolfPicks.votes) {
        var mine = G.wolfPicks.votes.filter(function (v) { return v.target === p.seat && v.picked; });
        if (mine.length) {
          pickTag = '<i class="ww-p-pick">' + mine.map(function (v) { return v.seat; }).join('/') + ' 刀</i>';
        }
      }
      return '<div class="' + cls + '" style="left:' + x.toFixed(2) + '%;top:' + y.toFixed(2) + '%;width:' + seatW + '%" data-seat="' + p.seat + '">' +
        '<div class="ww-p-ava">' + (p.seat) + '</div>' +
        '<div class="ww-p-name">' + esc(p.name) + '</div>' +
        (p.host ? '<i class="ww-p-badge">房主</i>' : '') +
        (speak ? '<i class="ww-p-mic">🎙</i>' : '') +
        pickTag +
        '</div>';
    }).join('');
    return '<div class="ww-table">' +
      '<div class="ww-table-center">' +
      '  <div class="ww-phase-icon">' + phaseIcon() + '</div>' +
      '  <div class="ww-phase-text">' + phaseText() + '</div>' +
      '  <div class="ww-countdown" id="wwCountdown"></div>' +
      '</div>' + seats + '</div>';
  }

  function phaseIcon() {
    var st = G.room.state;
    if (st === 'night') return '🌙';
    if (st === 'dawn') return '🌅';
    if (st === 'speech') return '💬';
    if (st === 'vote') return '🗳';
    if (st === 'shoot') return '🔫';
    return '🐺';
  }
  function phaseText() {
    var st = G.room.state;
    if (st === 'night') return '第 ' + (G.room.round || 1) + ' 夜';
    if (st === 'dawn') return G.dawn && G.dawn.deaths && G.dawn.deaths.length ? (G.dawn.deaths.join('、') + ' 号出局') : '平安夜';
    if (st === 'speech') return G.speech ? (G.speech.seat + ' 号发言中') : '发言';
    if (st === 'vote') return '请投票';
    if (st === 'shoot') return '开枪';
    return '';
  }

  function roleBar() {
    var role = G.you && G.you.role;
    if (!role) return '';
    return '<div class="ww-rolebar">' +
      '<span class="ww-role-emoji">' + (ROLE_EMOJI[role] || '') + '</span>' +
      '<span class="ww-role-name">' + (ROLE_NAME[role] || role) + '</span>' +
      (G.mates.length ? '<span class="ww-role-mates">队友 ' + G.mates.map(function (m) { return m.seat; }).join('/') + '</span>' : '') +
      (G.checkResult ? '<span class="ww-role-info">验 ' + G.checkResult.target + '：' + (G.checkResult.result === 'wolf' ? '狼' : '好') + '</span>' : '') +
      (G.lover ? '<span class="ww-role-info">情侣 ' + G.lover.seat + '</span>' : '') +
      '</div>';
  }

  /* 对局界面：圆桌 + 底部操作区 */
  function renderTable(body) {
    var st = G.room.state;
    var role = G.you && G.you.role;
    var panel = '';

    if (st === 'night') {
      var wolfInfo = '';
      if (G.wolfPicks && (role === 'wolf' || role === 'wolfking' || role === 'wolfbeauty')) {
        var lines = (G.wolfPicks.votes || []).map(function (v) {
          return v.seat + '号' + (v.picked ? ('→' + v.target + '号') : '→ 未选');
        }).join('　');
        var state = G.wolfPicks.agreed ? ('统一刀 ' + G.wolfPicks.target + ' 号')
          : (G.wolfPicks.allPicked ? '意见不一致 → 空刀' : '等待队友选择…');
        wolfInfo = '<div class="ww-wolfinfo"><div>' + lines + '</div><div class="' +
          (G.wolfPicks.agreed ? 'ok' : 'warn') + '">' + state + '</div></div>';
      }
      if (role === 'witch' && G.witch) {
        panel = '<div class="ww-actions">' +
          '<div class="ww-tip">' + (G.witch.killed ? ('今晚 ' + G.witch.killed + ' 号被刀') : '今晚没人被刀') + '</div>' +
          (G.witch.canSave ? '<button class="ww-btn main" data-act="save" type="button">用解药</button>' : '') +
          (G.witch.canPoison ? '<button class="ww-btn" data-act="poison" type="button">用毒药' + (G._poisonSeat ? ('（' + G._poisonSeat + ' 号）') : '') + '</button>' : '') +
          '<button class="ww-btn ghost" data-act="witch_none" type="button">不用药</button></div>';
      } else {
        panel = '<div class="ww-actions">' + wolfInfo + '<div class="ww-tip">' + actionHint(role) + '</div></div>';
      }
    } else if (st === 'speech') {
      var mine = G.speech && G.you && G.speech.seat === G.you.seat;
      var amHost = (G.room.players || []).some(function (p) { return G.you && p.seat === G.you.seat && p.host; });
      panel = '<div class="ww-actions">' +
        (mine ? '<div class="ww-tip on">轮到你了，直接说话（已开麦）</div>' : '<div class="ww-tip">听 ' + (G.speech ? G.speech.seat + ' 号' : '') + ' 发言</div>') +
        ((mine || amHost) ? '<button id="wwSkipSay" class="ww-btn ghost" type="button">跳过发言</button>' : '') +
        '</div>';
    } else if (st === 'vote') {
      var meAlive = G.you && G.you.alive;
      var total = 0, done = 0;
      if (G.voteStart && G.voteStart.candidates) {
        total = G.voteStart.candidates.length;
        done = (G.voteResult && G.voteResult.detail)
          ? (G.voteResult.detail.reduce(function (a, d) { return a + (d.voters ? d.voters.length : 0); }, 0) +
             ((G.voteResult.skipped || []).length))
          : (G._voted ? 1 : 0);
      }
      var progress = G.voteResult ? '' : ('　已投 ' + done + '/' + total);
      panel = meAlive
        ? '<div class="ww-actions">' +
          '<div class="ww-tip">点头像选人，再按投票（不能投自己）' + progress + '</div>' +
          '<button id="wwVoteBtn" class="ww-btn main" type="button" disabled>投票</button>' +
          '<button id="wwSkip" class="ww-btn ghost" type="button">弃票</button></div>'
        : '<div class="ww-actions"><div class="ww-tip">你已出局，只能旁观投票</div></div>';
    } else if (st === 'shoot') {
      var amShooter = G.shootMe;
      panel = amShooter
        ? '<div class="ww-actions"><div class="ww-tip">你可以带走一个人（点头像选）</div>' +
          '<button id="wwGiveup" class="ww-btn ghost" type="button">不开枪</button></div>'
        : '<div class="ww-actions"><div class="ww-tip">等待 ' + (G.shootSeat || '') + ' 号开枪…</div></div>';
    } else if (st === 'dawn') {
      panel = '<div class="ww-actions"><div class="ww-tip">' + phaseText() + '</div></div>';
    }

    body.innerHTML = tableHtml() + roleBar() + voteDetailHtml() + panel;
    bindTable();
  }

  /* 投票明细：谁被投、谁投的他 */
  function voteDetailHtml() {
    var v = G.voteResult;
    if (!v || G.room.state !== 'vote') return '';
    var detail = v.detail || [];
    var skipped = v.skipped || [];
    if (!detail.length && !skipped.length) return '';
    return '<div class="ww-votedetail">' +
      '<div class="ww-vd-title">本轮投票 · ' + (v.out ? (v.out + ' 号出局') : '平票/无人出局') + '</div>' +
      detail.map(function (d) {
        var who = (d.voters || []).map(function (x) { return x.seat + '号'; }).join('、');
        return '<div class="ww-vd-row' + (v.out === d.seat ? ' out' : '') + '">' +
          '<b>' + d.seat + ' 号 ' + esc(d.name || '') + '</b>' +
          '<span>' + d.votes + ' 票</span>' +
          '<em>' + (who ? ('投他：' + who) : '票数公开未列出') + '</em></div>';
      }).join('') +
      (skipped.length ? '<div class="ww-vd-skip">弃票：' + skipped.map(function (x) { return x.seat + '号'; }).join('、') + '</div>' : '') +
      ((v.notVoted && v.notVoted.length) ? '<div class="ww-vd-skip">未投票：' + v.notVoted.map(function (x) { return x.seat + '号'; }).join('、') + '</div>' : '') +
      '</div>';
  }

  var chosenSeat = null;
  function bindTable() {
    var st = G.room.state;
    Array.prototype.forEach.call(document.querySelectorAll('#wwBody [data-seat]'), function (el) {
      el.addEventListener('click', function () {
        var seat = Number(el.getAttribute('data-seat'));
        if (st === 'night') return nightClick(seat);
        if (st === 'vote') {
          if (G.you && seat === G.you.seat) { toast('不能投自己'); return; }
          chosenSeat = seat;
          Array.prototype.forEach.call(document.querySelectorAll('#wwBody .ww-p.chosen'), function (x) { x.classList.remove('chosen'); });
          el.classList.add('chosen');
          var b = $('#wwVoteBtn'); if (b) b.disabled = false;
          sfx('click');
          return;
        }
        if (st === 'shoot') { sfx('click'); return send({ t: 'ww_shoot', target: seat }); }
      });
    });
    if (st === 'vote') {
      if ($('#wwVoteBtn')) $('#wwVoteBtn').addEventListener('click', function () {
        if (!chosenSeat) return;
        send({ t: 'ww_vote', target: chosenSeat });
        G._voted = true;
        var b = $('#wwVoteBtn'); if (b) { b.disabled = true; b.textContent = '已投票'; }
        toast('已投票，等其他人');
      });
      if ($('#wwSkip')) $('#wwSkip').addEventListener('click', function () {
        send({ t: 'ww_vote', target: 'skip' });
        G._voted = true;
        toast('已弃票');
      });
    }
    if (st === 'shoot' && $('#wwGiveup')) $('#wwGiveup').addEventListener('click', function () { send({ t: 'ww_shoot', target: 0 }); });
    if (st === 'speech' && $('#wwSkipSay')) $('#wwSkipSay').addEventListener('click', function () { send({ t: 'ww_skip_speech' }); });
    Array.prototype.forEach.call(document.querySelectorAll('#wwBody [data-act]'), function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-act');
        if (act === 'save') send({ t: 'ww_action', kind: 'save' });
        else if (act === 'poison') {
          if (!G._poisonSeat) return toast('先点头像选人');
          send({ t: 'ww_action', kind: 'poison', target: G._poisonSeat });
        } else send({ t: 'ww_action', kind: 'witch_none' });
      });
    });
    startCountdown();
  }

  /* 投票/发言兜底提示：服务器到点会自动推进，避免误以为卡住 */
  function voteHint() {
    if (!G.room || !G.room.deadline) return;
    var left = Math.round((G.room.deadline - Date.now()) / 1000);
    if (G.room.state === 'vote' && left <= 0) {
      toast('投票时间到，正在结算…');
    }
  }

  /* 倒计时 */
  var cdTimer = null;
  function startCountdown() {
    clearInterval(cdTimer);
    var el = $('#wwCountdown');
    if (!el || !G.room || !G.room.deadline) return;
    var tick = function () {
      var left = Math.max(0, Math.round((G.room.deadline - Date.now()) / 1000));
      el.textContent = left > 0 ? (left + '″') : '';
      if (left <= 0) { clearInterval(cdTimer); voteHint(); }
    };
    tick();
    cdTimer = setInterval(tick, 500);
  }

  /* 等待厅：圆桌 + 人机按钮 */
  function renderWaiting(body) {
    var me = (G.room.players || []).find(function (p) { return G.you && p.seat === G.you.seat; });
    var host = me && me.host;
    var need = G.room.size || 0;
    var full = G.room.players.length >= need;
    body.innerHTML = tableHtml() +
      '<div class="ww-wait">' +
      '<div class="ww-wait-line">房间号 <code>' + esc(G.room.id) + '</code> · ' + G.room.players.length + '/' + need + ' 人</div>' +
      (host ? '<div class="ww-wait-btns">' +
        '<button id="wwAddBot" class="ww-btn small" type="button"' + (full ? ' disabled' : '') + '>＋人机</button>' +
        '<button id="wwDelBot" class="ww-btn small" type="button"' + (G.room.players.some(function (p) { return p.bot; }) ? '' : ' disabled') + '>－人机</button>' +
        '</div>' : '<div class="ww-wait-line">等房主开始…</div>') +
      (host ? '<button id="wwStart" class="ww-btn main" type="button"' + (full ? '' : ' disabled') + '>' + (full ? '开始游戏' : '还差 ' + (need - G.room.players.length) + ' 人') + '</button>' : '') +
      '<button id="wwLeave" class="ww-btn ghost" type="button">离开房间</button>' +
      '</div>';
    Array.prototype.forEach.call(document.querySelectorAll('#wwBody [data-seat]'), function (el) {
      el.addEventListener('click', function () { sfx('click'); });
    });
    if (host && $('#wwStart')) $('#wwStart').addEventListener('click', function () { send({ t: 'ww_start', id: G.room.id }); });
    if ($('#wwAddBot')) $('#wwAddBot').addEventListener('click', function () { send({ t: 'ww_addbot', id: G.room.id }); });
    if ($('#wwDelBot')) $('#wwDelBot').addEventListener('click', function () { send({ t: 'ww_removebot', id: G.room.id }); });
    if ($('#wwLeave')) $('#wwLeave').addEventListener('click', function () { leaveRoom(); render(); });
  }

  function renderResult(body) {
    var r = G.result || {};
    var win = r.winner === 'wolf' ? '狼人胜利' : '好人胜利';
    body.innerHTML = '<div class="ww-result ' + (r.winner === 'wolf' ? 'wolf' : 'good') + '">' +
      '<div class="ww-result-title">' + win + '</div></div>' +
      '<div class="ww-reveal">' + (r.reveal || []).map(function (p) {
        return '<div class="ww-rev-row' + (p.alive ? '' : ' dead') + '">' +
          '<b>' + p.seat + '</b><span>' + esc(p.name) + '</span>' +
          '<em>' + (ROLE_EMOJI[p.role] || '') + (ROLE_NAME[p.role] || p.role) + '</em></div>';
      }).join('') + '</div>' +
      '<button id="wwAgain" class="ww-btn main" type="button">回到房间列表</button>';
    $('#wwAgain').addEventListener('click', function () {
      G.result = null; G.stage = ''; leaveRoom(); send({ t: 'ww_list' }); render();
    });
  }

  /* ---------------- 创建房间（板子选择） ---------------- */
  function openCreate() {
    var body = $('#wwBody');
    var sel = G.boards[0] ? G.boards[0].id : 'ww6';
    function paint() {
      var b = G.boards.find(function (x) { return x.id === sel; }) || G.boards[0] || { roles: {} };
      body.innerHTML =
        '<div class="ww-list-head"><span>选板子</span><b>' + G.boards.length + ' 种</b></div>' +
        '<div class="ww-boards">' + G.boards.map(function (x) {
          return '<button class="ww-board' + (x.id === sel ? ' on' : '') + '" type="button" data-board="' + esc(x.id) + '">' +
            '<b>' + esc(x.name) + '</b><small>' + x.size + ' 人</small>' +
            '<span class="ww-roles">' + Object.keys(x.roles).map(function (k) {
              return '<i>' + (ROLE_EMOJI[k] || '?') + x.roles[k] + '</i>';
            }).join('') + '</span></button>';
        }).join('') + '</div>' +
        '<div class="ww-opts">' +
        '<label class="ww-opt">发言 <input id="wwSpeech" type="number" min="15" max="180" value="' + (G.defaults.speechTime || 45) + '"> 秒</label>' +
        '<label class="ww-opt"><input id="wwSelfSave" type="checkbox" checked> 女巫首夜可自救</label>' +
        '<label class="ww-opt"><input id="wwCity" type="checkbox"> 屠城模式</label>' +
        '</div>' +
        '<button id="wwDoCreate" class="ww-btn main" type="button">创建 ' + esc(b.name || '') + '</button>' +
        '<button id="wwCancelCreate" class="ww-btn ghost" type="button">返回列表</button>';
      Array.prototype.forEach.call(body.querySelectorAll('[data-board]'), function (el) {
        el.addEventListener('click', function () { sel = el.getAttribute('data-board'); sfx('click'); paint(); });
      });
      $('#wwDoCreate').addEventListener('click', function () {
        send({
          t: 'ww_create', board: sel,
          opts: {
            speechTime: Number($('#wwSpeech').value) || 45,
            witchSelfSave: $('#wwSelfSave').checked ? 'first' : 'none',
            winMode: $('#wwCity').checked ? 'city' : 'side',
          },
        });
      });
      $('#wwCancelCreate').addEventListener('click', render);
    }
    paint();
  }

  /* ---------------- 夜间行动 ---------------- */
  function actionHint(role) {
    switch (role) {
      case 'wolf': case 'wolfking': return '点头像选今晚要刀的人';
      case 'wolfbeauty': return '点头像选今晚魅惑的人';
      case 'seer': return '点头像选要查验的人';
      case 'guard': return '点头像选要守护的人' + (G.guard && G.guard.lastGuard ? ('（上晚 ' + G.guard.lastGuard + ' 号）') : '');
      case 'cupid': return '点两个头像连成情侣';
      case 'witch': return '等夜间信息';
      default: return '闭眼等待天亮';
    }
  }

  var cupidPick = [];
  function nightClick(seat) {
    var role = G.you && G.you.role;
    if (!role) return;
    sfx('click');
    if (role === 'wolf' || role === 'wolfking') return send({ t: 'ww_action', kind: 'kill', target: seat });
    if (role === 'wolfbeauty') return send({ t: 'ww_action', kind: 'charm', target: seat });
    if (role === 'seer') return send({ t: 'ww_action', kind: 'check', target: seat });
    if (role === 'guard') return send({ t: 'ww_action', kind: 'guard', target: seat });
    if (role === 'witch') { G._poisonSeat = seat; return toast('已选 ' + seat + ' 号，点「用毒药」确认'); }
    if (role === 'cupid') {
      cupidPick.push(seat);
      if (cupidPick.length === 2) {
        send({ t: 'ww_action', kind: 'link', a: cupidPick[0], b: cupidPick[1] });
        cupidPick = [];
      } else toast('再选一个人');
    }
  }

  function isWolfSide() {
    var r = G.you && G.you.role;
    return r === 'wolf' || r === 'wolfking' || r === 'wolfbeauty';
  }

  /* ---------------- 消息 ---------------- */
  function onMessage(d) {
    switch (d.t) {
      case 'ww_rooms': G.rooms = d.rooms || []; if (!G.room) render(); break;
      case 'ww_boards': G.boards = d.boards || []; G.defaults = d.defaults || {}; break;
      case 'ww_room':
        G.room = d.game; G.you = d.you || null; G.stage = d.game.state === 'settlement' ? 'result' : 'room';
        if (d.game.state !== 'settlement') { G.result = null; }
        render(); break;
      case 'ww_players':
        if (G.room) {
          G.room.players = d.players || G.room.players;
          G.room.state = d.state || G.room.state;
          var mine = (G.room.players || []).find(function (p) { return G.you && p.seat === G.you.seat; });
          if (mine) G.you = Object.assign({}, G.you, { alive: mine.alive, host: mine.host });
          render();
        }
        break;
      case 'ww_started':
        G.room = d.game; G.stage = 'playing';
        sfx('deal'); fx('flash');
        render(); break;
      case 'ww_wolves':
        G.mates = d.mates || [];
        if (G.mates.length) { sfx('wolf'); fx('wolf'); }
        render(); break;
      case 'ww_lover': G.lover = d; render(); break;
      case 'ww_night':
        G.night = d; if (d.you && d.you.role) G.you = d.you; G.checkResult = null;
        G.wolfPicks = null;
        fx('night');
        if (G.room) { G.room.state = 'night'; G.room.round = d.round || G.room.round; G.room.deadline = d.deadline || 0; }
        sfx('night'); judge('天黑请闭眼，第 ' + (d.round || 1) + ' 天');
        render(); break;
      case 'ww_witch_info': G.witch = d; render(); break;
      case 'ww_guard_info': G.guard = d; break;
      case 'ww_check_result': G.checkResult = d; render(); break;
      case 'ww_action_ack': if (d.kind === 'poison') { G.witch = null; } if (d.kind === 'save') { G.witch = null; } render(); break;
      case 'ww_night_step':
        if (d.done === 'wolf') {
          toast('狼人已选定目标' + (d.target ? ('（' + d.target + ' 号）') : ''));
          if (G.room) G.room.deadline = Math.min(G.room.deadline || 0, Date.now() + 18000);
          render();
        }
        break;
      case 'ww_deaths':
        sfx('death');
        if (G.room && G.room.state === 'dawn') {
          toast('昨晚：' + (d.deaths || []).map(function (x) { return x.seat + ' 号'; }).join('、') + ' 出局');
        }
        break;
      case 'ww_dawn':
        G.dawn = {
          deaths: (d.deaths || []).map(function (x) { return typeof x === 'object' ? x.seat : x; }),
          detail: d.detail || [],
        };
        // 给本回合出局的人打上动画标记，播完再清
        if (G.room && G.room.players) {
          var died = {};
          (d.detail || []).forEach(function (x) { died[x.seat] = true; });
          G.room.players.forEach(function (pp) { pp.justDied = !!died[pp.seat]; });
          setTimeout(function () {
            if (G.room && G.room.players) G.room.players.forEach(function (pp) { pp.justDied = false; });
          }, 1400);
        }
        if (G.room) { G.room.state = 'dawn'; G.room.deadline = d.deadline || 0; }
        sfx('dawn'); fx('flash');
        judge(G.dawn.deaths.length ? ('天亮了，' + G.dawn.deaths.join('号、') + '号出局') : '天亮了，昨晚是平安夜');
        if (G.dawn.deaths.length) setTimeout(function () { sfx('out'); }, 900);
        render(); break;
      case 'ww_speech':
        G.speech = d;
        if (G.you && d.seat === G.you.seat) { sfx('turn'); }
        if (G.room) { G.room.state = 'speech'; G.room.deadline = d.deadline || 0; }
        render(); break;
      case 'ww_said':
        toast(d.seat + ' 号：' + (d.text || ''));
        if (d.skipped) { G._lastSaid = null; render(); }
        break;
      case 'ww_vote_start':
        G.voteStart = d; G._voted = false; G.voteResult = null;
        if (G.room) { G.room.state = 'vote'; G.room.deadline = d.deadline || 0; }
        sfx('vote'); judge('请投票'); render(); break;
      case 'ww_vote_result':
        G.voteResult = d;
        sfx('vote');
        judge(d.out ? (d.out + '号被放逐') : '平票，本轮无人出局');
        toast(d.out ? (d.out + ' 号被放逐') : '平票，无人出局');
        render();
        break;
      case 'ww_flip':
        sfx('flip');
        toast(d.seat + ' 号翻牌：' + (ROLE_NAME[d.role] || d.role) + '，失去投票权');
        break;
      case 'ww_hunter':
        G.stage = 'shoot';
        G.shootSeat = d.seat;
        G.shootMe = !!(G.you && G.you.seat === d.seat);
        if (G.room) { G.room.state = 'shoot'; G.room.deadline = d.deadline || 0; }
        render(); break;
      case 'ww_over':
        G.result = d; G.stage = 'result';
        var iWin = G.result.winner === (isWolfSide() ? 'wolf' : 'good');
        sfx(iWin ? 'win' : 'lose');
        judge(iWin ? '你所在的阵营胜利' : '游戏结束');
        render(); break;
      case 'ww_kicked': toast('你被房主请出了房间'); leaveRoom(); G.stage = ''; render(); break;
      case 'ww_left': G.room = null; G.stage = ''; render(); break;
      case 'ww_wolf_pick':
        G.wolfPicks = d;
        sfx('seat');
        render();
        break;
      case 'ww_mic_perm':
        G.micPerm = { ok: !!d.ok, scope: d.scope || null, reason: d.reason || '' };
        if (!G.micPerm.ok && RT.on) rtStop();
        syncMicState();
        render(); 
        break;
      case 'ww_audio':
        rtPlay(d);
        break;
      case 'ww_voice':
        playVoice(d);
        toast(d.seat + ' 号语音' + (d.duration ? (' ' + d.duration + '″') : ''));
        break;
      case 'ww_error': toast(d.message || '操作失败'); break;
      default: break;
    }
  }

  window.WW = { open: open, close: close, onMessage: onMessage, state: G };
})();
