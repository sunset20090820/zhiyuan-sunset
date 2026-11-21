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
      '  <button id="wwMic" class="ww-mic" type="button">🎤 按住说话</button>' +
      '  <span class="ww-michint">群聊语音，松开即发送（最长 10 秒）</span>' +
      '</div>',
      '<div id="wwToast" class="ww-toast"></div>',
    ].join('');
    document.body.appendChild(page);
    $('#wwBack').addEventListener('click', function () { close(); });
    var micBtn = $('#wwMic');
    if (micBtn) {
      micBtn.addEventListener('pointerdown', function (e) { e.preventDefault(); micBtn.classList.add('on'); micStart(); });
      micBtn.addEventListener('pointerup', function () { micBtn.classList.remove('on'); micStop(); });
      micBtn.addEventListener('pointercancel', function () { micBtn.classList.remove('on'); micStop(); });
      micBtn.addEventListener('pointerleave', function () { if (mic.held) { micBtn.classList.remove('on'); micStop(); } });
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
    $('#gamePage').classList.remove('hidden');
    G.open = true;
    if (!G.rooms.length) send({ t: 'ww_list' });
    send({ t: 'ww_boards' });
    render();
  }
  function close() {
    var p = $('#gamePage');
    if (p) p.classList.add('hidden');
    judgeStop();
    try { if (voicePlayer) voicePlayer.pause(); } catch (e) {}
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

  /* ---------------- 渲染 ---------------- */
  function syncMicBar() {
    var bar = $('#wwMicBar');
    if (!bar) return;
    var inGame = !!(G.room && G.room.state && G.room.state !== 'waiting' && G.room.state !== 'settlement');
    bar.classList.toggle('hidden', !inGame);
  }

  function render() {
    if (!G.open) return;
    syncMicBar();
    var body = $('#wwBody');
    if (!body) return;
    var st = G.room ? (G.room.state || 'waiting') : '';
    if ($('#wwState')) $('#wwState').textContent = st ? (STATE_NAME[st] || st) : '';
    if (!G.room) return renderLobby(body);
    if (G.stage === 'result' || G.room.state === 'settlement') return renderResult(body);
    if (G.room.state === 'waiting') return renderWaiting(body);
    return renderPlaying(body);
  }

  function renderLobby(body) {
    var list = G.rooms.filter(function (r) { return r.state === 'waiting'; });
    body.innerHTML = [
      '<div class="ww-hero">',
      '  <div class="ww-hero-emoji">🐺</div>',
      '  <h2>狼人杀</h2>',
      '  <p>和好友开一局：天黑请闭眼，白天靠发言与投票找出狼人。</p>',
      '  <button id="wwCreate" class="primary" type="button">创建房间</button>',
      '</div>',
      '<div class="ww-section"><h3>正在等人的房间</h3>',
      list.length ? list.map(function (r) {
        return '<button class="ww-room" type="button" data-join="' + esc(r.id) + '">' +
          '<b>' + esc(r.boardName) + '</b>' +
          '<span>' + esc(r.hostName) + ' 的房间 · ' + r.players + '/' + r.max + ' 人</span>' +
          '<i>加入</i></button>';
      }).join('') : '<p class="ww-empty">还没有房间，点上面「创建房间」开一局</p>',
      '</div>',
    ].join('');
    $('#wwCreate').addEventListener('click', openCreate);
    Array.prototype.forEach.call(body.querySelectorAll('[data-join]'), function (b) {
      b.addEventListener('click', function () { send({ t: 'ww_join', id: b.getAttribute('data-join') }); });
    });
  }

  function openCreate() {
    var body = $('#wwBody');
    var sel = G.boards[0] ? G.boards[0].id : 'ww6';
    function paint() {
      var b = G.boards.find(function (x) { return x.id === sel; }) || G.boards[0] || { roles: {} };
      body.innerHTML = [
        '<div class="ww-section"><h3>选一个板子</h3><div class="ww-boards">',
        G.boards.map(function (x) {
          return '<button class="ww-board' + (x.id === sel ? ' on' : '') + '" type="button" data-board="' + esc(x.id) + '">' +
            '<b>' + esc(x.name) + '</b><small>' + x.size + ' 人 · ' + esc(x.desc || '') + '</small>' +
            '<span class="ww-roles">' + Object.keys(x.roles).map(function (k) {
              return '<i title="' + esc(ROLE_NAME[k] || k) + '">' + (ROLE_EMOJI[k] || '?') + '×' + x.roles[k] + '</i>';
            }).join('') + '</span></button>';
        }).join(''),
        '</div></div>',
        '<div class="ww-section"><h3>选项</h3>',
        '<label class="ww-opt">发言时长 <input id="wwSpeech" type="number" min="15" max="180" value="' + (G.defaults.speechTime || 45) + '"> 秒</label>',
        '<label class="ww-opt"><input id="wwSelfSave" type="checkbox" checked> 女巫可首夜自救</label>',
        '<label class="ww-opt"><input id="wwCity" type="checkbox"> 屠城模式（狼过半即胜）</label>',
        '</div>',
        '<button id="wwDoCreate" class="primary" type="button">创建 ' + esc(b.name || '') + '</button>',
        '<button id="wwCancelCreate" class="flat" type="button">返回</button>',
      ].join('');
      Array.prototype.forEach.call(body.querySelectorAll('[data-board]'), function (b2) {
        b2.addEventListener('click', function () { sel = b2.getAttribute('data-board'); paint(); });
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

  function playerGrid(withAction) {
    if (!G.room) return '';
    return '<div class="ww-seats">' + (G.room.players || []).map(function (p) {
      var me = G.you && G.you.seat === p.seat;
      var cls = 'ww-seat' + (p.alive ? '' : ' dead') + (me ? ' me' : '') + (p.host ? ' host' : '') + (p.connected === false ? ' off' : '');
      var roleTag = p.role ? '<em>' + (ROLE_EMOJI[p.role] || '') + (ROLE_NAME[p.role] || p.role) + '</em>' : '';
      return '<button class="' + cls + '" type="button" data-seat="' + p.seat + '">' +
        '<b>' + p.seat + ' 号</b><span>' + esc(p.name) + '</span>' +
        (p.bot ? '<i class="ww-bot">人机</i>' : '') + roleTag +
        (p.host ? '<i>房主</i>' : '') + '</button>';
    }).join('') + '</div>';
  }

  function bindSeats(handler) {
    Array.prototype.forEach.call(document.querySelectorAll('#wwBody [data-seat]'), function (b) {
      b.addEventListener('click', function () {
        var seat = Number(b.getAttribute('data-seat'));
        handler(seat, b);
      });
    });
  }

  function renderWaiting(body) {
    var me = (G.room.players || []).find(function (p) { return G.you && p.seat === G.you.seat; });
    var host = me && me.host;
    var need = G.room.size || G.room.max || 0;
    var full = G.room.players.length >= need;
    body.innerHTML = [
      '<div class="ww-section">',
      '  <h3>' + esc(G.room.boardName) + ' · ' + G.room.players.length + '/' + need + ' 人</h3>',
      '  <p class="ww-hint">把房间号发给好友：<code>' + esc(G.room.id) + '</code></p>',
      playerGrid(),
      '</div>',
      host
        ? '<button id="wwStart" class="primary" type="button"' + (full ? '' : ' disabled') + '>' + (full ? '开始游戏' : '还差 ' + (need - G.room.players.length) + ' 人') + '</button>'
        : '<p class="ww-hint">等房主开始…</p>',
      host ? '<div class="ww-bots">' +
        '<button id="wwAddBot" class="flat" type="button"' + (full ? ' disabled' : '') + '>＋ 人机</button>' +
        '<button id="wwDelBot" class="flat" type="button"' + (G.room.players.some(function (p) { return p.bot; }) ? '' : ' disabled') + '>－ 人机</button>' +
        '</div>' +
        '<p class="ww-hint">人不够可以先加人机陪练，等人齐了再踢掉人机</p>' : '',
      '<button id="wwLeave" class="flat" type="button">离开房间</button>',
    ].join('');
    if (host) $('#wwStart').addEventListener('click', function () { send({ t: 'ww_start', id: G.room.id }); });
    if ($('#wwAddBot')) $('#wwAddBot').addEventListener('click', function () { send({ t: 'ww_addbot', id: G.room.id }); });
    if ($('#wwDelBot')) $('#wwDelBot').addEventListener('click', function () { send({ t: 'ww_removebot', id: G.room.id }); });
    $('#wwLeave').addEventListener('click', function () { leaveRoom(); render(); });
  }

  var chosenSeat = null;

  function renderPlaying(body) {
    var st = G.room.state;
    var role = G.you && G.you.role;
    var head = [
      '<div class="ww-status">',
      '  <div class="ww-myrole">' + (role ? (ROLE_EMOJI[role] || '') + ' 你是 <b>' + (ROLE_NAME[role] || role) + '</b>' : '') + '</div>',
      G.mates.length ? '<div class="ww-mates">队友：' + G.mates.map(function (m) { return m.seat + ' 号 ' + esc(m.name); }).join('、') + '</div>' : '',
      G.lover ? '<div class="ww-mates">情侣：' + G.lover.seat + ' 号 ' + esc(G.lover.name) + '</div>' : '',
      '</div>',
      playerGrid(),
    ].join('');

    var panel = '';
    if (st === 'night') {
      panel = '<div class="ww-panel"><h3>天黑请闭眼</h3>';
      if (role === 'witch' && G.witch) {
        panel += '<p class="ww-hint">' + (G.witch.killed ? ('今晚 ' + G.witch.killed + ' 号被刀') : '今晚没人被刀') + '</p>';
        if (G.witch.canSave) panel += '<button class="ww-act" data-act="save" type="button">💊 用解药救他</button>';
        if (G.witch.canPoison) panel += '<button class="ww-act" data-act="poison" type="button">☠️ 用毒药（先点座位选人）</button>';
        panel += '<button class="ww-act" data-act="witch_none" type="button">这晚不用药</button>';
      } else if (G.checkResult) {
        panel += '<p class="ww-hint">你验了 ' + G.checkResult.target + ' 号：<b>' +
          (G.checkResult.result === 'wolf' ? '狼人' : '好人') + '</b>（点座位可继续验）</p>';
      } else {
        panel += '<p class="ww-hint">' + actionHint(role) + '</p>';
      }
      panel += '</div>';
    } else if (st === 'dawn') {
      panel = '<div class="ww-panel"><h3>天亮了</h3><p class="ww-hint">' +
        (G.dawn && G.dawn.deaths && G.dawn.deaths.length ? ('昨晚 ' + G.dawn.deaths.join('、') + ' 号出局') : '昨晚是平安夜') +
        '</p></div>';
    } else if (st === 'speech') {
      var mine = G.speech && G.you && G.speech.seat === G.you.seat;
      panel = '<div class="ww-panel"><h3>发言</h3><p class="ww-hint">' +
        (G.speech ? ('轮到 ' + G.speech.seat + ' 号 ' + esc(G.speech.name)) : '') + '</p>' +
        (mine ? '<textarea id="wwSay" maxlength="500" placeholder="说点什么…"></textarea>' +
                '<button id="wwSendSay" class="primary" type="button">发言</button>'
              : '<p class="ww-hint">等别人说完</p>') + '</div>';
    } else if (st === 'vote') {
      chosenSeat = null;
      panel = '<div class="ww-panel"><h3>投票</h3><p class="ww-hint">点头像选人，再按「投票」；也可以弃票</p>' +
        '<button id="wwVoteBtn" class="primary" type="button" disabled>投票</button>' +
        '<button id="wwSkip" class="flat" type="button">弃票</button></div>';
    } else if (st === 'shoot') {
      panel = '<div class="ww-panel"><h3>开枪</h3><p class="ww-hint">你是' + (ROLE_NAME[role] || '') +
        '，可以带走一个人（点座位选人）</p><button id="wwGiveup" class="flat" type="button">不开枪</button></div>';
    }

    body.innerHTML = head + panel;

    // ---- DOM 就绪后再绑定 ----
    bindSeats(function (seat, el) {
      if (G.room.state === 'night') { nightClick(seat); return; }
      if (G.room.state === 'vote') {
        chosenSeat = seat;
        Array.prototype.forEach.call(document.querySelectorAll('#wwBody .ww-seat.chosen'), function (x) { x.classList.remove('chosen'); });
        el.classList.add('chosen');
        var vb = $('#wwVoteBtn'); if (vb) vb.disabled = false;
        return;
      }
      if (G.room.state === 'shoot') { send({ t: 'ww_shoot', target: seat }); return; }
    });

    if (st === 'vote') {
      var btn = $('#wwVoteBtn');
      if (btn) btn.addEventListener('click', function () { if (chosenSeat) send({ t: 'ww_vote', target: chosenSeat }); });
      var sk = $('#wwSkip');
      if (sk) sk.addEventListener('click', function () { send({ t: 'ww_vote', target: 'skip' }); });
    }
    if (st === 'speech') {
      var sb = $('#wwSendSay');
      if (sb) sb.addEventListener('click', function () {
        var v = ($('#wwSay').value || '').trim();
        if (!v) return toast('先说点什么');
        send({ t: 'ww_say', text: v });
      });
    }
    if (st === 'shoot') {
      var gv = $('#wwGiveup');
      if (gv) gv.addEventListener('click', function () { send({ t: 'ww_shoot', target: 0 }); });
    }
    if (st === 'night') {
      Array.prototype.forEach.call(document.querySelectorAll('#wwBody [data-act]'), function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-act');
          if (act === 'save') send({ t: 'ww_action', kind: 'save' });
          else if (act === 'poison') {
            if (!G._poisonSeat) return toast('先点上面的座位选人');
            send({ t: 'ww_action', kind: 'poison', target: G._poisonSeat });
          } else send({ t: 'ww_action', kind: 'witch_none' });
        });
      });
    }
  }

  function actionHint(role) {
    switch (role) {
      case 'wolf': case 'wolfking': return '点上面的座位选择今晚要刀的人';
      case 'wolfbeauty': return '点座位选择今晚魅惑的人';
      case 'seer': return '点座位选择要查验的人';
      case 'guard': return '点座位选择要守护的人' + (G.guard && G.guard.lastGuard ? ('（上晚守了 ' + G.guard.lastGuard + ' 号）') : '');
      case 'cupid': return '点两个座位连成情侣';
      case 'witch': return '等待夜间信息';
      default: return '闭眼等待天亮';
    }
  }

  var cupidPick = [];
  function nightClick(seat) {
    var role = G.you && G.you.role;
    if (!role) return;
    if (role === 'wolf' || role === 'wolfking' || role === 'wolfbeauty') return send({ t: 'ww_action', kind: 'kill', target: seat });
    if (role === 'seer') return send({ t: 'ww_action', kind: 'check', target: seat });
    if (role === 'guard') return send({ t: 'ww_action', kind: 'guard', target: seat });
    if (role === 'witch') { G._poisonSeat = seat; return toast('已选 ' + seat + ' 号，点「用毒药」确认'); }
    if (role === 'cupid') {
      cupidPick.push(seat);
      if (cupidPick.length === 2) { send({ t: 'ww_action', kind: 'link', a: cupidPick[0], b: cupidPick[1] }); cupidPick = []; }
      else toast('再选一个人');
    }
  }

  function renderResult(body) {
    var r = G.result || {};
    var win = r.winner === 'wolf' ? '狼人胜利' : '好人胜利';
    body.innerHTML = [
      '<div class="ww-result">',
      '  <h2 class="' + (r.winner === 'wolf' ? 'wolf' : 'good') + '">' + win + '</h2>',
      '</div>',
      '<div class="ww-section"><h3>身份公开</h3><div class="ww-reveal">',
      (r.reveal || []).map(function (p) {
        return '<div class="ww-reveal-row' + (p.alive ? '' : ' dead') + '">' +
          '<b>' + p.seat + ' 号</b><span>' + esc(p.name) + '</span>' +
          '<em>' + (ROLE_EMOJI[p.role] || '') + ' ' + (ROLE_NAME[p.role] || p.role) + '</em></div>';
      }).join(''),
      '</div></div>',
      '<button id="wwAgain" class="primary" type="button">回到大厅</button>',
    ].join('');
    $('#wwAgain').addEventListener('click', function () {
      G.result = null; G.stage = ''; leaveRoom(); render();
    });
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
        if (G.room) { G.room.players = d.players || G.room.players; G.room.state = d.state || G.room.state; render(); }
        break;
      case 'ww_started': G.room = d.game; G.stage = 'playing'; render(); break;
      case 'ww_wolves': G.mates = d.mates || []; render(); break;
      case 'ww_lover': G.lover = d; render(); break;
      case 'ww_night':
        G.night = d; if (d.you && d.you.role) G.you = d.you; G.checkResult = null;
        sfx('night'); judge('天黑请闭眼，第 ' + (d.round || 1) + ' 天');
        render(); break;
      case 'ww_witch_info': G.witch = d; render(); break;
      case 'ww_guard_info': G.guard = d; break;
      case 'ww_check_result': G.checkResult = d; render(); break;
      case 'ww_action_ack': if (d.kind === 'poison') { G.witch = null; } if (d.kind === 'save') { G.witch = null; } render(); break;
      case 'ww_deaths': toast('昨晚：' + (d.deaths || []).map(function (x) { return x.seat + ' 号'; }).join('、') + ' 出局'); break;
      case 'ww_dawn':
        G.dawn = { deaths: (d.deaths || []).map(function (x) { return typeof x === 'object' ? x.seat : x; }) };
        sfx('dawn');
        judge(G.dawn.deaths.length ? ('天亮了，' + G.dawn.deaths.join('号、') + '号出局') : '天亮了，昨晚是平安夜');
        if (G.dawn.deaths.length) setTimeout(function () { sfx('out'); }, 900);
        render(); break;
      case 'ww_speech': G.speech = d; render(); break;
      case 'ww_said': toast(d.seat + ' 号：' + (d.text || '')); break;
      case 'ww_vote_start':
        G.voteStart = d; sfx('vote'); judge('请投票'); render(); break;
      case 'ww_vote_result':
        G.voteResult = d;
        sfx('vote');
        judge(d.out ? (d.out + '号被放逐') : '平票，本轮无人出局');
        toast(d.out ? (d.out + ' 号被放逐') : '平票，无人出局');
        break;
      case 'ww_flip': toast(d.seat + ' 号翻牌：' + (ROLE_NAME[d.role] || d.role) + '，失去投票权'); break;
      case 'ww_hunter': G.stage = 'shoot'; render(); break;
      case 'ww_over':
        G.result = d; G.stage = 'result';
        var iWin = G.result.winner === (isWolfSide() ? 'wolf' : 'good');
        sfx(iWin ? 'win' : 'lose');
        judge(iWin ? '你所在的阵营胜利' : '游戏结束');
        render(); break;
      case 'ww_kicked': toast('你被房主请出了房间'); leaveRoom(); G.stage = ''; render(); break;
      case 'ww_left': G.room = null; G.stage = ''; render(); break;
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
