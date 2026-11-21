'use strict';
/**
 * 狼人杀 · 游戏引擎
 * 服务端权威：所有行动由服务端校验，角色只经单发通道下发，广播里永不出现别人的 role。
 */
const { ROLES, isWolf, isGod } = require('./roles');
const { validateBoard, getBoard, mergeOpts, DEFAULT_OPTS } = require('./boards');

const games = new Map();
const MAX_GAMES = 3;   // 受服务器带宽限制：最多同时 3 个房间
const IDLE_MS = 30 * 60 * 1000;   // 空房 30 分钟回收
const OFFLINE_GRACE = 60 * 1000;  // 掉线保留座位 60 秒

/* ---------------- 工具 ---------------- */
function keyOf(api, c) {
  const a = c.account && api.accounts[c.account];
  if (a && a.uid) return 'uid:' + a.uid;
  return c.deviceId || c.id;
}
function nameOfC(c) {
  const a = c.account ? null : null; // 昵称由 c.name 提供，账号昵称已在 join 时同步
  return c.name || '路人';
}
function clientsOf(api, key) {
  const out = [];
  for (const c of api.clients) if (keyOf(api, c) === key) out.push(c);
  return out;
}
function sendKey(api, key, obj) {
  for (const c of clientsOf(api, key)) api.send(c, obj);
}
function toGame(game, api, obj, exceptKey) {
  for (const p of game.players) {
    if (exceptKey && p.key === exceptKey) continue;
    sendKey(api, p.key, obj);
  }
}
function seatOf(game, key) {
  const p = game.players.find(x => x.key === key);
  return p ? p.seat : 0;
}
function playerAt(game, seat) {
  return game.players.find(p => p.seat === Number(seat)) || null;
}
function alivePlayers(game) { return game.players.filter(p => p.alive); }
function aliveWolves(game) { return game.players.filter(p => p.alive && isWolf(p.role)); }
function aliveGods(game) { return game.players.filter(p => p.alive && isGod(p.role)); }
function aliveVillagers(game) { return game.players.filter(p => p.alive && p.role === 'villager'); }

function publicPlayer(p) {
  return {
    seat: p.seat, name: p.name, alive: p.alive, connected: p.connected, bot: !!p.bot,
    role: p.revealed ? p.role : undefined,   // 只在白痴翻牌/结算后出现
    host: !!p.host,
  };
}
function publicGame(game) {
  return {
    id: game.id, board: game.board, boardName: game.boardName, size: game.size,
    opts: game.opts, state: game.state, round: game.round, hostSeat: game.hostSeat,
    players: game.players.map(publicPlayer), deadline: game.deadline,
  };
}
function refreshHost(game) {
  if (game.players.some(p => p.seat === game.hostSeat && p.alive !== undefined)) {
    const h = playerAt(game, game.hostSeat);
    if (h && h.host) return;
  }
  const cand = alivePlayers(game)[0] || game.players[0];
  game.players.forEach(p => { p.host = false; });
  if (cand) { cand.host = true; game.hostSeat = cand.seat; }
}

/* ---------------- 建房 / 加入 ---------------- */
function createGame(api, c, d) {
  if (games.size >= MAX_GAMES) throw new Error('游戏房间已满');
  if (alreadyInGame(api, keyOf(api, c))) throw new Error('你已经在别的游戏里了');

  let board = getBoard(d.board);
  let size, roles, boardName, boardId;
  if (board) {
    size = board.size; roles = Object.assign({}, board.roles);
    boardName = board.name; boardId = board.id;
  } else if (d.board === 'custom') {
    size = Number(d.size) || 0;
    roles = d.roles || {};
    const err = validateBoard(size, roles, null);
    if (err) throw new Error(err);
    boardName = d.name ? String(d.name).slice(0, 20) : '自定义板子';
    boardId = 'custom';
  } else {
    throw new Error('未知板子');
  }

  const opts = mergeOpts(d.opts);
  const key = keyOf(api, c);
  const game = {
    id: 'ww_' + api.uid().slice(0, 8),
    board: boardId, boardName, size, roles, opts,
    state: 'waiting', round: 0,
    players: [], hostSeat: 1,
    night: null, votes: {}, speechOrder: [], speechIndex: 0,
    deadline: 0, log: [], lovers: [], pending: null,
    createdAt: api.now(), touchedAt: api.now(),
  };
  game.players.push(newPlayer(api, c, 1, true));
  games.set(game.id, game);
  api.send(c, { t: 'ww_room', game: publicGame(game), you: { seat: 1 } });
  broadcastRooms(api);
  return game;
}

function newPlayer(api, c, seat, host) {
  const key = keyOf(api, c);
  return {
    key, seat, name: c.name || '路人', role: null, alive: true,
    connected: true, offlineAt: 0, deadReason: '', canVote: true,
    host: !!host, revealed: false, charmedBy: null,
  };
}

function alreadyInGame(api, key) {
  for (const g of games.values()) {
    const p = g.players.find(x => x.key === key);
    if (!p) continue;
    if (p.left) continue;                       // 已退出这一局，不阻挡开新局
    if (g.state === 'settlement') continue;     // 已结束的局也不阻挡
    return g;
  }
  return null;
}

function joinGame(api, c, d) {
  const game = games.get(String(d.id || ''));
  if (!game) throw new Error('房间不存在');
  const key = keyOf(api, c);
  let existing = game.players.find(p => p.key === key);
  if (existing && existing.left) {
    if (game.state !== 'waiting') throw new Error('你已退出这一局，等这局结束再开新局');
    game.players = game.players.filter(p => p !== existing);
    existing = null;
  }
  if (existing) {
    existing.connected = true; existing.offlineAt = 0; existing.name = c.name || existing.name;
    api.send(c, { t: 'ww_room', game: publicGame(game), you: youOf(game, existing) });
    syncPlayers(game, api);
    return game;
  }
  if (game.state !== 'waiting') throw new Error('游戏已经开始');
  if (game.players.length >= game.size) throw new Error('房间已满');
  const used = new Set(game.players.map(p => p.seat));
  let seat = 1;
  while (used.has(seat)) seat++;
  game.players.push(newPlayer(api, c, seat, false));
  game.players.sort((a, b) => a.seat - b.seat);
  api.send(c, { t: 'ww_room', game: publicGame(game), you: { seat } });
  syncPlayers(game, api);
  broadcastRooms(api);
  return game;
}

function youOf(game, p) {
  return { seat: p.seat, role: p.role || undefined, alive: p.alive, host: !!p.host };
}

function leaveGame(api, c, d) {
  const game = games.get(String(d.id || ''));
  if (!game) return;
  const key = keyOf(api, c);
  const p = game.players.find(x => x.key === key);
  if (!p) return;
  if (game.state === 'waiting') {
    game.players = game.players.filter(x => x.key !== key);
    if (!game.players.length) { games.delete(game.id); broadcastRooms(api); return; }
    if (p.host) refreshHost(game);
    syncPlayers(game, api);
    broadcastRooms(api);
    api.send(c, { t: 'ww_left' });
    return;
  }
  // 游戏中离开：视为死亡退出，并记录「已离开」，之后可以重新建房/加入别的局
  p.connected = false;
  p.left = true;
  if (p.alive) {
    p.alive = false;
    p.deadReason = 'quit';
    afterDeaths(game, api, [p], () => checkAndContinue(game, api));
  }
  // 没有任何真人在场了 → 直接销毁，别让空局占着
  const humans = game.players.filter(x => !x.bot && !x.left);
  if (!humans.length) {
    games.delete(game.id);
    broadcastRooms(api);
    api.send(c, { t: 'ww_left' });
    return;
  }
  syncPlayers(game, api);
  broadcastRooms(api);
}

const BOT_NAMES = ['小狼', '阿福', '老K', '豆豆', '阿飞', '圆圆', '大锤', '七七'];

function addBot(api, c, d) {
  const game = games.get(String(d.id || ''));
  if (!game) throw new Error('房间不存在');
  if (game.state !== 'waiting') throw new Error('游戏已经开始');
  const me = game.players.find(p => p.key === keyOf(api, c));
  if (!me || !me.host) throw new Error('只有房主能加人机');
  if (game.players.length >= game.size) throw new Error('房间已满');
  const used = new Set(game.players.map(p => p.seat));
  let seat = 1;
  while (used.has(seat)) seat++;
  const botCount = game.players.filter(p => p.bot).length;
  game.players.push({
    key: 'bot:' + game.id + ':' + seat, seat,
    name: BOT_NAMES[botCount % BOT_NAMES.length] + '(人机)',
    role: null, alive: true, connected: true, offlineAt: 0, deadReason: '',
    canVote: true, host: false, revealed: false, bot: true,
  });
  game.players.sort((a, b) => a.seat - b.seat);
  syncPlayers(game, api);
  broadcastRooms(api);
}

function removeBot(api, c, d) {
  const game = games.get(String(d.id || ''));
  if (!game || game.state !== 'waiting') throw new Error('只有等待中才能移除人机');
  const me = game.players.find(p => p.key === keyOf(api, c));
  if (!me || !me.host) throw new Error('只有房主能移除人机');
  const bots = game.players.filter(p => p.bot);
  if (!bots.length) throw new Error('房间里没有人机');
  const last = bots[bots.length - 1];
  game.players = game.players.filter(p => p !== last);
  syncPlayers(game, api);
  broadcastRooms(api);
}

function kick(api, c, d) {
  const game = games.get(String(d.id || ''));
  if (!game || game.state !== 'waiting') throw new Error('只有等待中才能踢人');
  const me = game.players.find(p => p.key === keyOf(api, c));
  if (!me || !me.host) throw new Error('只有房主能踢人');
  const target = playerAt(game, d.seat);
  if (!target || target.key === me.key) throw new Error('目标不合法');
  game.players = game.players.filter(p => p.key !== target.key);
  sendKey(api, target.key, { t: 'ww_kicked' });
  syncPlayers(game, api);
  broadcastRooms(api);
}

/* ---------------- 开局 ---------------- */
function startGame(api, c, d) {
  const game = games.get(String(d.id || ''));
  if (!game) throw new Error('房间不存在');
  const me = game.players.find(p => p.key === keyOf(api, c));
  if (!me || !me.host) throw new Error('只有房主能开始');
  if (game.state !== 'waiting') throw new Error('已经开始了');
  if (game.players.length !== game.size) throw new Error(`需要 ${game.size} 人，现在 ${game.players.length} 人`);
  const offline = game.players.filter(p => !p.connected && !p.bot);
  if (offline.length) throw new Error('有人掉线，等他回来再开始');

  deal(game);
  game.state = 'night';
  game.round = 1;
  toGame(game, api, { t: 'ww_started', game: publicGame(game) });
  // 逐个发身份（含狼队友）
  for (const p of game.players) {
    const you = { seat: p.seat, role: p.role, alive: true };
    sendKey(api, p.key, { t: 'ww_room', game: publicGame(game), you });
    if (isWolf(p.role)) {
      const mates = game.players.filter(x => isWolf(x.role) && x.key !== p.key).map(x => ({ seat: x.seat, name: x.name, role: x.role }));
      sendKey(api, p.key, { t: 'ww_wolves', mates });
    }
    if (p.role === 'cupid' && game.round === 1) sendKey(api, p.key, { t: 'ww_cupid', players: game.players.map(x => ({ seat: x.seat, name: x.name })) });
  }
  startNight(game, api);
  broadcastRooms(api);
}

/* ---------------- 人机行为 ---------------- */
function pick(arr) { return arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; }

function scheduleBots(game, api) {
  if (!game.players.some(p => p.bot)) return;
  // 夜晚：每个存活人机各自行动
  for (const p of game.players) {
    if (!p.bot || !p.alive) continue;
    setTimeout(() => {
      try { if (games.get(game.id) !== game || game.state !== 'night') return; botNight(game, api, p); }
      catch (e) { }
    }, 900 + Math.random() * 1600);
  }
}

function botNight(game, api, p) {
  const n = game.night;
  if (!n) return;
  const alive = game.players.filter(x => x.alive && x.key !== p.key);
  if (isWolf(p.role) && !n.wolfVotes[p.key]) {
    // 优先刀非狼，其次随机
    const t = pick(alive.filter(x => !isWolf(x.role))) || pick(alive);
    if (t) { n.wolfVotes[p.key] = t.key; n.acted[p.key] = true; recomputeWolfTarget(n); }
  } else if (p.role === 'seer' && !n.acted[p.key]) {
    const t = pick(alive);
    if (t) { n.seerTarget = t.key; n.seerResult = isWolf(t.role) ? 'wolf' : 'good'; n.acted[p.key] = true; }
  } else if (p.role === 'guard' && !n.guardDone) {
    const t = pick(alive.filter(x => x.seat !== game.lastGuardSeat));
    if (t) { n.guardTarget = t.key; n.guardDone = true; game.lastGuardSeat = t.seat; n.acted[p.key] = true; }
  } else if (p.role === 'witch' && !n.witchDone) {
    const victim = n.wolfTarget ? game.players.find(x => x.key === n.wolfTarget) : null;
    const canSelf = game.opts.witchSelfSave === 'always' || (game.opts.witchSelfSave === 'first' && game.round === 1);
    if (victim && !game.witchSaveUsed && (victim.key !== p.key || canSelf) && Math.random() < 0.7) {
      game.witchSaveUsed = true; n.witchSave = true; n.witchDone = true; n.acted[p.key] = true;
    } else if (!game.witchPoisonUsed && Math.random() < 0.35) {
      const t = pick(alive);
      if (t) { game.witchPoisonUsed = true; n.witchPoison = t.key; n.witchDone = true; n.acted[p.key] = true; }
      else { n.witchDone = true; }
    } else { n.witchDone = true; }
  } else if (p.role === 'cupid' && game.round === 1 && !n.cupidDone) {
    const a = pick(alive), b = pick(alive.filter(x => !a || x.key !== a.key));
    if (a && b) { game.lovers = [a.key, b.key]; n.cupidDone = true; n.acted[p.key] = true; }
  } else if (p.role === 'wolfbeauty' && !n.charmDone) {
    const t = pick(alive.filter(x => !isWolf(x.role)));
    if (t) { n.charmTarget = t.key; n.charmDone = true; n.acted[p.key] = true; }
  }
  maybeAdvance(game, api);
}

const BOT_LINES = [
  '我是好人，过。', '我先过，听后面的人说。', '我觉得要谨慎一点。',
  '昨晚的信息不多，先过。', '我怀疑前面发言的人。', '我是平民，没什么信息。',
];

/** 当前发言者是人机 → 自动说一句 */
function botSpeak(game, api, p) {
  const text = pick(BOT_LINES) || '过。';
  toGame(game, api, { t: 'ww_said', seat: p.seat, name: p.name, text });
  game.log.push({ type: 'speech', seat: p.seat, text, round: game.round, bot: true });
  game.speechIndex++;
  nextSpeaker(game, api);
}

/** 投票阶段的人机投票 */
function scheduleBotVotes(game, api) {
  for (const p of game.players) {
    if (!p.bot || !p.alive || !p.canVote) continue;
    setTimeout(() => {
      try {
        if (games.get(game.id) !== game || game.state !== 'vote') return;
        const alive = game.players.filter(x => x.alive && x.key !== p.key);
        let pool = alive;
        if (isWolf(p.role)) pool = alive.filter(x => !isWolf(x.role));
        const t = pick(pool) || pick(alive);
        if (t) game.votes[p.key] = t.key; else game.votes[p.key] = 'skip';
        const voters = alivePlayers(game).filter(x => x.canVote).map(x => x.key);
        if (voters.every(k => game.votes[k] !== undefined)) resolveVote(game, api);
      } catch (e) { }
    }, 1200 + Math.random() * 2600);
  }
}

function deal(game) {
  const pool = [];
  for (const [k, v] of Object.entries(game.roles)) for (let i = 0; i < Number(v || 0); i++) pool.push(k);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  game.players.forEach((p, i) => { p.role = pool[i]; });
}

/* ---------------- 夜晚 ---------------- */
function startNight(game, api) {
  game.state = 'night';
  game.night = {
    wolfVotes: {}, wolfTarget: null, seerTarget: null, seerResult: null,
    witchSave: false, witchPoison: null, witchDone: false,
    guardTarget: null, guardDone: false, cupidDone: game.round > 1,
    charmTarget: null, charmDone: false, acted: {},
  };
  game.deadline = api.now() + 60 * 1000;
  for (const p of game.players) {
    if (!p.alive) continue;
    const targets = nightTargetsFor(game, p);
    sendKey(api, p.key, {
      t: 'ww_night', round: game.round, deadline: game.deadline,
      you: { seat: p.seat, role: p.role, alive: p.alive },
      targets,
    });
    if (p.role === 'witch') {
      const killedSeat = game.night.wolfTarget ? seatOf(game, game.night.wolfTarget) : 0;
      sendKey(api, p.key, {
        t: 'ww_witch_info', killed: killedSeat || 0,
        canSave: !game.witchSaveUsed && (!killedSeat || canSelfSave(game, p)),
        canPoison: !game.witchPoisonUsed, canSelfSave: game.opts.witchSelfSave !== 'none',
      });
    }
    if (p.role === 'guard') sendKey(api, p.key, { t: 'ww_guard_info', lastGuard: game.lastGuardSeat || 0 });
  }
  toGame(game, api, { t: 'ww_night_start', round: game.round, deadline: game.deadline });
  scheduleBots(game, api);
}

function canSelfSave(game, p) {
  if (game.opts.witchSelfSave === 'always') return true;
  if (game.opts.witchSelfSave === 'first') return game.round === 1;
  return false;
}

function nightTargetsFor(game, p) {
  const alive = game.players.filter(x => x.alive).map(x => ({ seat: x.seat, name: x.name }));
  switch (p.role) {
    case 'wolf': case 'wolfking': case 'wolfbeauty':
      return alive.filter(x => x.seat !== p.seat);
    case 'seer':
      return alive.filter(x => x.seat !== p.seat);
    case 'guard':
      return alive.filter(x => x.seat !== p.seat);
    case 'cupid':
      return alive;
    case 'witch':
      return alive;
    default:
      return [];
  }
}

/* ---------------- 行动 ---------------- */
function handleAction(api, c, d) {
  const game = findGameOfPlayer(api, c);
  if (!game) throw new Error('你不在任何游戏中');
  if (game.state !== 'night') throw new Error('现在不是夜晚');
  const p = game.players.find(x => x.key === keyOf(api, c));
  if (!p || !p.alive) throw new Error('你已出局');
  const n = game.night;
  const kind = String(d.kind || '');
  const targetSeat = Number(d.target) || 0;

  const role = p.role;
  const wolfRole = role === 'wolf' || role === 'wolfking' || role === 'wolfbeauty';

  if (kind === 'kill') {
    if (!wolfRole) throw new Error('你不能刀人');
    if (!targetSeat || !playerAt(game, targetSeat) || !playerAt(game, targetSeat).alive) throw new Error('目标不合法');
    n.wolfVotes[p.key] = playerAt(game, targetSeat).key;
    n.acted[p.key] = true;
    recomputeWolfTarget(n);
    // 注意：狼人全部行动后不能直接结算夜晚，还要等预言家/女巫/守卫
    maybeAdvance(game, api);
    api.send(c, { t: 'ww_action_ack', kind, target: targetSeat });
    return;
  }

  if (kind === 'check') {
    if (role !== 'seer') throw new Error('只有预言家能验人');
    const t = playerAt(game, targetSeat);
    if (!t || !t.alive || t.seat === p.seat) throw new Error('目标不合法');
    n.seerTarget = t.key; n.seerResult = isWolf(t.role) ? 'wolf' : 'good'; n.acted[p.key] = true;
    api.send(c, { t: 'ww_check_result', target: targetSeat, name: t.name, result: n.seerResult });
    api.send(c, { t: 'ww_action_ack', kind, target: targetSeat });
    maybeAdvance(game, api);
    return;
  }

  if (kind === 'save' || kind === 'poison' || kind === 'witch_none') {
    if (role !== 'witch') throw new Error('只有女巫能用药');
    if (n.witchDone && !game.opts.witchSameNight) throw new Error('这一晚已经用过了');
    if (kind === 'save') {
      if (game.witchSaveUsed) throw new Error('解药已经用完了');
      if (!n.wolfTarget) throw new Error('今晚还没有人被刀');
      if (n.wolfTarget === p.key && !canSelfSave(game, p)) throw new Error('这一晚不能自救');
      game.witchSaveUsed = true; n.witchSave = true;
    } else if (kind === 'poison') {
      if (game.witchPoisonUsed) throw new Error('毒药已经用完了');
      const t = playerAt(game, targetSeat);
      if (!t || !t.alive) throw new Error('目标不合法');
      game.witchPoisonUsed = true; n.witchPoison = t.key;
    } else {
      n.witchDone = true;
    }
    if (n.witchSave || n.witchPoison) n.witchDone = true;
    n.acted[p.key] = true;
    api.send(c, { t: 'ww_action_ack', kind, target: targetSeat || 0 });
    maybeAdvance(game, api);
    return;
  }

  if (kind === 'guard') {
    if (role !== 'guard') throw new Error('只有守卫能守护');
    const t = playerAt(game, targetSeat);
    if (!t || !t.alive) throw new Error('目标不合法');
    if (game.lastGuardSeat === t.seat) throw new Error('不能连续两晚守同一人');
    n.guardTarget = t.key; n.guardDone = true; game.lastGuardSeat = t.seat; n.acted[p.key] = true;
    api.send(c, { t: 'ww_action_ack', kind, target: targetSeat });
    maybeAdvance(game, api);
    return;
  }

  if (kind === 'charm') {
    if (role !== 'wolfbeauty') throw new Error('只有狼美人能魅惑');
    const t = playerAt(game, targetSeat);
    if (!t || !t.alive || t.seat === p.seat) throw new Error('目标不合法');
    n.charmTarget = t.key; n.charmDone = true; n.acted[p.key] = true;
    api.send(c, { t: 'ww_action_ack', kind, target: targetSeat });
    maybeAdvance(game, api);
    return;
  }

  if (kind === 'link') {
    if (role !== 'cupid' || game.round > 1) throw new Error('只有首夜丘比特能连线');
    const a = Number(d.a) || 0, b = Number(d.b) || 0;
    const pa = playerAt(game, a), pb = playerAt(game, b);
    if (!pa || !pb || a === b) throw new Error('情侣必须选两个不同的人');
    game.lovers = [pa.key, pb.key];
    n.cupidDone = true; n.acted[p.key] = true;
    sendKey(api, pa.key, { t: 'ww_lover', seat: pb.seat, name: pb.name });
    sendKey(api, pb.key, { t: 'ww_lover', seat: pa.seat, name: pa.name });
    if (a === p.seat || b === p.seat) api.send(c, { t: 'ww_lover_self', note: '你是丘比特，连到了自己' });
    api.send(c, { t: 'ww_action_ack', kind });
    maybeAdvance(game, api);
    return;
  }

  throw new Error('未知操作');
}

/** 狼刀按多数，平票随机取一票 */
function recomputeWolfTarget(n) {
  const tally = {};
  Object.values(n.wolfVotes).forEach(k => { tally[k] = (tally[k] || 0) + 1; });
  let best = null, bestN = 0, tie = [];
  for (const [k, v] of Object.entries(tally)) {
    if (v > bestN) { best = k; bestN = v; tie = [k]; }
    else if (v === bestN) tie.push(k);
  }
  n.wolfTarget = tie.length > 1 ? tie[Math.floor(Math.random() * tie.length)] : best;
  return n.wolfTarget;
}

/** 所有夜间行动者都动了 → 提前结算 */
function maybeAdvance(game, api) {
  const n = game.night;
  const need = game.players.filter(p => p.alive && [
    'seer', 'witch', 'guard', 'cupid', 'wolfbeauty',
  ].includes(p.role)).map(p => p.key);
  const wolves = aliveWolves(game).filter(p => p.connected).map(p => p.key);
  const allWolvesActed = wolves.length === 0 || wolves.every(k => n.acted[k]);
  const othersActed = need.every(k => {
    const p = game.players.find(x => x.key === k);
    if (!p || !p.connected) return true;
    if (p.role === 'witch') return n.witchDone || n.witchSave || n.witchPoison;
    if (p.role === 'guard') return n.guardDone;
    if (p.role === 'cupid') return n.cupidDone || game.round > 1;
    return n.acted[k];
  });
  if (allWolvesActed && othersActed) finishNight(game, api);
}

function finishNight(game, api) {
  const n = game.night;
  const deaths = [];
  const wolfVictim = n.wolfTarget ? game.players.find(p => p.key === n.wolfTarget) : null;
  if (wolfVictim && wolfVictim.alive) {
    const guarded = n.guardTarget === wolfVictim.key;
    const saved = n.witchSave;
    if (guarded && saved) markDeath(game, wolfVictim, 'killed', '同守同救');   // 同守同救死
    else if (saved || guarded) { /* 活下来 */ }
    else markDeath(game, wolfVictim, 'killed');
    if (!wolfVictim.alive) deaths.push(wolfVictim);
  }
  if (n.witchPoison) {
    const v = game.players.find(p => p.key === n.witchPoison);
    if (v && v.alive) { markDeath(game, v, 'poisoned'); deaths.push(v); }
  }
  game.lastNightDeaths = deaths.map(p => p.seat);
  afterDeaths(game, api, deaths, () => {
    const winner = winnerOf(game);
    if (winner) return settlement(game, api, winner);
    dawn(game, api);
  });
}

function markDeath(game, p, reason, note) {
  p.alive = false; p.deadReason = reason; p.deadNote = note || '';
  // 情侣殉情
  if (game.lovers.includes(p.key)) {
    const otherKey = game.lovers.find(k => k !== p.key);
    const other = game.players.find(x => x.key === otherKey);
    if (other && other.alive) {
      other.alive = false; other.deadReason = 'lover'; other.deadNote = '殉情';
      game._extraDeaths = (game._extraDeaths || []).concat([other]);
    }
  }
  // 狼美人殉情
  if (p.role === 'wolfbeauty' && game.night && game.night.charmTarget) {
    const c2 = game.players.find(x => x.key === game.night.charmTarget);
    if (c2 && c2.alive) { c2.alive = false; c2.deadReason = 'charm'; game._extraDeaths = (game._extraDeaths || []).concat([c2]); }
  }
}

/** 处理死亡触发的技能（猎人/狼王开枪、白痴翻牌），可能有异步等待 */
function afterDeaths(game, api, deaths, resume) {
  const extra = game._extraDeaths || [];
  game._extraDeaths = [];
  const all = deaths.concat(extra).filter(p => p && !p.alive);
  const shooter = all.find(p => {
    const r = ROLES[p.role];
    if (!r || r.onDeath !== 'shoot') return false;
    if (r.notOnPoison && p.deadReason === 'poisoned') return false;
    if (!game.opts.hunterShoot && (p.role === 'hunter')) return false;
    return true;
  });
  if (shooter) {
    game.state = 'shoot';
    game.pending = {
      kind: 'shoot', seat: shooter.seat, key: shooter.key, role: shooter.role,
      deadline: api.now() + 20 * 1000, resume,
    };
    toGame(game, api, { t: 'ww_deaths', deaths: all.map(publicDeath), round: game.round });
    sendKey(api, shooter.key, { t: 'ww_hunter', seat: shooter.seat, deadline: game.pending.deadline });
    syncPlayers(game, api);
    if (shooter.bot) setTimeout(function () {
      try {
        if (games.get(game.id) !== game || game.state !== 'shoot' || !game.pending) return;
        const t = pick(game.players.filter(x => x.alive && x.key !== shooter.key));
        handleShoot(api, { deviceId: shooter.key, id: shooter.key, account: null }, { target: t ? t.seat : 0 });
      } catch (e) { }
    }, 1200);
    return;
  }
  syncPlayers(game, api);
  if (all.length) toGame(game, api, { t: 'ww_deaths', deaths: all.map(publicDeath), round: game.round });
  resume();
}

function publicDeath(p) {
  return { seat: p.seat, name: p.name, reason: p.deadReason };
}

function resumePending(game, api) {
  const p = game.pending;
  game.pending = null;
  if (!p) return;
  if (p.resume) p.resume();
}

function handleShoot(api, c, d) {
  const game = findGameOfPlayer(api, c);
  if (!game || game.state !== 'shoot' || !game.pending) throw new Error('现在不能开枪');
  if (game.pending.key !== keyOf(api, c)) throw new Error('不是你开枪');
  const targetSeat = Number(d.target) || 0;
  const t = targetSeat ? playerAt(game, targetSeat) : null;
  if (targetSeat && (!t || !t.alive)) throw new Error('目标不合法');
  const deaths = [];
  if (t) { markDeath(game, t, 'shot'); deaths.push(t); }
  const extra = game._extraDeaths || []; game._extraDeaths = [];
  const all = deaths.concat(extra);
  if (all.length) toGame(game, api, { t: 'ww_deaths', deaths: all.map(publicDeath), round: game.round });
  syncPlayers(game, api);
  const winner = winnerOf(game);
  if (winner) return settlement(game, api, winner);
  resumePending(game, api);
}

/* ---------------- 天亮 / 发言 ---------------- */
function dawn(game, api) {
  game.state = 'dawn';
  const deaths = (game.lastNightDeaths || []).slice();
  game.deadline = api.now() + 12 * 1000;
  toGame(game, api, { t: 'ww_dawn', round: game.round, deaths, deadline: game.deadline });
  syncPlayers(game, api);
}

function beginSpeech(game, api) {
  game.state = 'speech';
  const alive = alivePlayers(game).sort((a, b) => a.seat - b.seat);
  const lastDead = (game.lastNightDeaths && game.lastNightDeaths.length)
    ? Math.max(...game.lastNightDeaths) : 0;
  const startIdx = Math.max(0, alive.findIndex(p => p.seat > lastDead));
  const ordered = alive.slice(startIdx).concat(alive.slice(0, startIdx));
  game.speechOrder = ordered.map(p => p.key);
  game.speechIndex = 0;
  nextSpeaker(game, api);
}

function nextSpeaker(game, api) {
  while (game.speechIndex < game.speechOrder.length) {
    const key = game.speechOrder[game.speechIndex];
    const p = game.players.find(x => x.key === key);
    if (p && p.alive) {
      game.deadline = api.now() + game.opts.speechTime * 1000;
      toGame(game, api, { t: 'ww_speech', seat: p.seat, name: p.name, deadline: game.deadline });
      if (p.bot) setTimeout(function () {
        try { if (games.get(game.id) === game && game.state === 'speech' && game.speechOrder[game.speechIndex] === p.key) botSpeak(game, api, p); } catch (e) { }
      }, 1200 + Math.random() * 1500);
      return;
    }
    game.speechIndex++;
  }
  startVote(game, api);
}

/* ---------------- 实时语音（连续 PCM/Opus 帧中继） ---------------- */
const AUDIO_FRAME_MAX = 16 * 1024;    // 单帧 base64 上限（约 12KB 原始数据）
const AUDIO_RATE_MS = 120;            // 单人最少间隔，防刷
function handleAudioFrame(api, c, d) {
  const game = findGameOfPlayer(api, c);
  if (!game) throw new Error('你不在任何游戏中');
  const p = game.players.find(x => x.key === keyOf(api, c));
  if (!p || !p.alive) return;                       // 死人不推流，静默丢弃
  const data = String(d.data || '');
  if (!data || data.length > AUDIO_FRAME_MAX) return;
  const t = api.now();
  if (p.lastAudioAt && t - p.lastAudioAt < AUDIO_RATE_MS) return;
  p.lastAudioAt = t;
  game.speaking = { seat: p.seat, until: t + 900 };
  const payload = { t: 'ww_audio', seat: p.seat, seq: Number(d.seq) || 0, fmt: d.fmt || 'pcm8', data };
  for (const other of game.players) {
    if (other.key === p.key) continue;
    sendKey(api, other.key, payload);
  }
}

const VOICE_MAX = 700 * 1024;   // base64 后约 500KB，够 10 秒左右 opus
function handleVoice(api, c, d) {
  const game = findGameOfPlayer(api, c);
  if (!game) throw new Error('你不在任何游戏中');
  const p = game.players.find(x => x.key === keyOf(api, c));
  if (!p || !p.alive) throw new Error('你已出局，不能发言');
  const data = String(d.data || '');
  if (data.indexOf('data:audio/') !== 0) throw new Error('语音格式不支持');
  if (data.length > VOICE_MAX) throw new Error('语音太长，控制在 10 秒内');
  const now2 = api.now();
  p.lastVoiceAt = p.lastVoiceAt || 0;
  if (now2 - p.lastVoiceAt < 800) throw new Error('慢一点，语音太频繁');
  p.lastVoiceAt = now2;
  toGame(game, api, {
    t: 'ww_voice', seat: p.seat, name: p.name,
    mime: String(d.mime || 'audio/webm').slice(0, 40),
    duration: Number(d.duration) || 0, data: data,
  }, p.key);
  api.send(c, { t: 'ww_voice_ack' });
}

function handleSay(api, c, d) {
  const game = findGameOfPlayer(api, c);
  if (!game || game.state !== 'speech') throw new Error('现在不是发言阶段');
  const p = game.players.find(x => x.key === keyOf(api, c));
  if (!p || !p.alive) throw new Error('你已出局');
  const curKey = game.speechOrder[game.speechIndex];
  if (curKey !== p.key) throw new Error('还没轮到你');
  const text = String(d.text || '').slice(0, 500);
  if (!text.trim()) throw new Error('发言不能为空');
  toGame(game, api, { t: 'ww_said', seat: p.seat, name: p.name, text });
  game.log.push({ type: 'speech', seat: p.seat, text, round: game.round });
  game.speechIndex++;
  nextSpeaker(game, api);
}

/** 跳过当前发言（本人或房主） */
function handleSkipSpeech(api, c, d) {
  const game = findGameOfPlayer(api, c);
  if (!game || game.state !== 'speech') throw new Error('现在不是发言阶段');
  const p = game.players.find(x => x.key === keyOf(api, c));
  if (!p) throw new Error('你不在这一局');
  const curKey = game.speechOrder[game.speechIndex];
  const isHost = p.seat === game.hostSeat;
  if (p.key !== curKey && !isHost) throw new Error('只能跳过自己的发言');
  const cur = game.players.find(x => x.key === curKey);
  if (cur) toGame(game, api, { t: 'ww_said', seat: cur.seat, name: cur.name, text: '（跳过发言）', skipped: true });
  game.speechIndex++;
  nextSpeaker(game, api);
}

/* ---------------- 投票 ---------------- */
function startVote(game, api) {
  game.state = 'vote';
  game.votes = {};
  game.deadline = api.now() + 30 * 1000;
  toGame(game, api, {
    t: 'ww_vote_start', round: game.round, deadline: game.deadline,
    candidates: alivePlayers(game).map(p => ({ seat: p.seat, name: p.name })),
  });
  scheduleBotVotes(game, api);
}

function handleVote(api, c, d) {
  const game = findGameOfPlayer(api, c);
  if (!game || game.state !== 'vote') throw new Error('现在不是投票阶段');
  const p = game.players.find(x => x.key === keyOf(api, c));
  if (!p || !p.alive) throw new Error('你已出局');
  if (!p.canVote) throw new Error('你已失去投票权');
  const targetSeat = Number(d.target) || 0;
  const target = d.target === 'skip' ? 'skip' : targetSeat;
  if (target !== 'skip') {
    const t = playerAt(game, targetSeat);
    if (!t || !t.alive) throw new Error('目标不合法');
    if (t.key === p.key) throw new Error('不能投自己');
    game.votes[p.key] = t.key;      // 存玩家键，计票时再换算座位
  } else {
    game.votes[p.key] = 'skip';
  }
  api.send(c, { t: 'ww_vote_ack', target });
  const voters = alivePlayers(game).filter(x => x.canVote).map(x => x.key);
  if (voters.every(k => game.votes[k] !== undefined)) resolveVote(game, api);
}

function resolveVote(game, api) {
  if (game.state !== 'vote' || game._resolvingVote) return;
  game._resolvingVote = true;
  try { doResolveVote(game, api); }
  catch (e) { game._resolvingVote = false; throw e; }
  game._resolvingVote = false;
}

function doResolveVote(game, api) {
  const tally = {};
  for (const [voter, target] of Object.entries(game.votes)) {
    if (target === 'skip') continue;
    const seat = seatOf(game, target);
    if (!seat) continue;
    tally[seat] = (tally[seat] || 0) + 1;
  }
  const entries = Object.entries(tally).map(([seat, n]) => ({ seat: Number(seat), votes: n }))
    .sort((a, b) => b.votes - a.votes);
  let out = null;
  if (entries.length) {
    const top = entries[0].votes;
    const topList = entries.filter(e => e.votes === top);
    if (topList.length === 1) out = topList[0].seat;
  }
  toGame(game, api, {
    t: 'ww_vote_result', round: game.round, tally: entries,
    out: out, tie: out === null && entries.length > 0,
    votes: game.opts.voteMode === 'public' ? Object.keys(game.votes).map(k => ({ seat: seatOf(game, k), target: game.votes[k] })) : undefined,
  });

  const deaths = [];
  if (out) {
    const p = playerAt(game, out);
    if (p && p.alive) {
      const r = ROLES[p.role];
      if (r && r.onVoteOut === 'flip' && !p.revealed) {
        p.revealed = true; p.canVote = false;
        toGame(game, api, { t: 'ww_flip', seat: p.seat, name: p.name, role: p.role });
        syncPlayers(game, api);
      } else {
        markDeath(game, p, 'voted');
        deaths.push(p);
      }
    }
  }
  const extra = game._extraDeaths || []; game._extraDeaths = [];
  deaths.push(...extra);
  afterDeaths(game, api, deaths, () => {
    const winner = winnerOf(game);
    if (winner) return settlement(game, api, winner);
    game.round++;
    startNight(game, api);
  });
}

/* ---------------- 胜负 ---------------- */
function winnerOf(game) {
  const wolves = aliveWolves(game).length;
  const gods = aliveGods(game).length;
  const vills = aliveVillagers(game).length;
  const aliveN = alivePlayers(game).length;
  if (!wolves) return 'good';
  if (game.opts.winMode === 'city') {
    if (wolves * 2 >= aliveN) return 'wolf';
    return null;
  }
  // 屠边
  if (gods === 0) return 'wolf';
  if (vills === 0) return 'wolf';
  return null;
}

function settlement(game, api, winner) {
  game.state = 'settlement';
  game.deadline = 0;
  toGame(game, api, {
    t: 'ww_over', winner,
    reveal: game.players.map(p => ({ seat: p.seat, name: p.name, role: p.role, alive: p.alive, deadReason: p.deadReason })),
  });
  game.pending = null;
  broadcastRooms(api);
}

function checkAndContinue(game, api) {
  const winner = winnerOf(game);
  if (winner) return settlement(game, api, winner);
  syncPlayers(game, api);
}

/* ---------------- 里程碑推进 ---------------- */
function tick(api) {
  const t = api.now();
  for (const game of games.values()) {
    if (game.state === 'waiting' || game.state === 'settlement') {
      if (game.players.length === 0) games.delete(game.id);
      else if (t - game.touchedAt > IDLE_MS) { games.delete(game.id); broadcastRooms(api); }
      continue;
    }
    if (game.pending && t > game.pending.deadline) { resumePending(game, api); continue; }
    // 兜底：deadline 丢失（0 / 未设置）时补一个，避免整局卡死
    if (!game.deadline) { game.deadline = t + 15000; continue; }
    if (t <= game.deadline) continue;
    switch (game.state) {
      case 'night': finishNight(game, api); break;
      case 'dawn': beginSpeech(game, api); break;
      case 'speech':
        game.speechIndex++;
        nextSpeaker(game, api);
        break;
      case 'vote': {
        const voters = alivePlayers(game).filter(x => x.canVote && !x.bot).map(x => x.key);
        const everyoneVoted = voters.every(k => game.votes[k] !== undefined);
        resolveVote(game, api);
        if (everyoneVoted) break;
        break;
      }
      default: break;
    }
  }
}

function findGameOfPlayer(api, c) {
  const key = keyOf(api, c);
  for (const g of games.values()) if (g.players.some(p => p.key === key)) return g;
  return null;
}

/* ---------------- 列表 ---------------- */
function roomList(api) {
  return Array.from(games.values()).map(g => ({
    id: g.id, host: g.hostSeat,
    hostName: (playerAt(g, g.hostSeat) || {}).name || '',
    players: g.players.length, max: g.size, state: g.state,
    board: g.board, boardName: g.boardName, opts: g.opts,
  }));
}
function broadcastRooms(api) {
  const payload = { t: 'ww_rooms', rooms: roomList(api) };
  for (const c of api.clients) api.send(c, payload);
}

function syncPlayers(game, api) {
  toGame(game, api, { t: 'ww_players', players: game.players.map(publicPlayer), state: game.state });
}

/* ---------------- 断线 ---------------- */
function onDisconnect(api, c) {
  const key = keyOf(api, c);
  const game = findGameOfPlayer(api, c);
  if (!game) return;
  const p = game.players.find(x => x.key === key);
  if (p) {
    p.connected = false; p.offlineAt = api.now();
    syncPlayers(game, api);
  }
}

/* ---------------- 分发 ---------------- */
function handle(c, d, api) {
  try {
    switch (d.t) {
      case 'ww_list': api.send(c, { t: 'ww_rooms', rooms: roomList(api) }); return true;
      case 'ww_boards': api.send(c, { t: 'ww_boards', boards: require('./boards').BOARDS, defaults: DEFAULT_OPTS }); return true;
      case 'ww_create': createGame(api, c, d); return true;
      case 'ww_join': joinGame(api, c, d); return true;
      case 'ww_leave': leaveGame(api, c, d); return true;
      case 'ww_kick': kick(api, c, d); return true;
      case 'ww_addbot': addBot(api, c, d); return true;
      case 'ww_removebot': removeBot(api, c, d); return true;
      case 'ww_start': startGame(api, c, d); return true;
      case 'ww_action': handleAction(api, c, d); return true;
      case 'ww_shoot': handleShoot(api, c, d); return true;
      case 'ww_say': handleSay(api, c, d); return true;
      case 'ww_skip_speech': handleSkipSpeech(api, c, d); return true;
      case 'ww_voice': handleVoice(api, c, d); return true;
      case 'ww_audio': handleAudioFrame(api, c, d); return true;
      case 'ww_vote': handleVote(api, c, d); return true;
      default: return false;
    }
  } catch (e) {
    api.send(c, { t: 'ww_error', message: e && e.message ? e.message : '操作失败' });
    return true;
  }
}

module.exports = { handle, tick, roomList, broadcastRooms, onDisconnect, _games: games };
