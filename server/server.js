#!/usr/bin/env node
/*
 * 纸鸢 · 聊天服务端
 * 零依赖：WebSocket 自己实现，只要装了 Node（>=16）就能跑。
 *
 *   node server.js            # 默认 8080 端口
 *   PORT=9000 node server.js
 *
 * 手机和电脑在同一个 WiFi 下，App 里填 ws://电脑IP:8080 就能聊。
 */
'use strict';

// ---- 客户端版本信息（可用 data/version.json 覆盖） ----
const APK_DIR = (function () { return require('path').join(__dirname, 'data', 'apk'); })();
let versionInfo = { code: 35, name: '3.5', notes: '', url: '', size: 0, sha256: '' };
function loadVersionInfo() {
  try {
    const raw = require('fs').readFileSync(require('path').join(__dirname, 'data', 'version.json'), 'utf8');
    const v = JSON.parse(raw);
    versionInfo = Object.assign(versionInfo, v || {});
  } catch (e) { }
  return versionInfo;
}
loadVersionInfo();

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---- 可选模块：狼人杀（server/game/ 不存在时聊天照常工作） ----
let wwGame = null;
try { wwGame = require('./game/werewolf'); } catch (e) { wwGame = null; }
function wwApi() {
  return { clients, send, now, uid, clean, accounts, accountByUid };
}

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const HIST_MAX = 300;
const MAX_TEXT = 4000;
const MAX_NAME = 16;

const ROOMS = [
  { id: 'lobby', name: '公共大厅', emoji: '💬' },
  { id: 'tech', name: '技术交流', emoji: '🛠' },
  { id: 'fun', name: '摸鱼水区', emoji: '🐟' }
];
// 图片存这里，消息里只放 /img/xxx 引用，避免历史把内存撑爆
const IMG_DIR = path.join(__dirname, 'data', 'img');
try { fs.mkdirSync(IMG_DIR, { recursive: true }); } catch (e) {}
const IMG_MAX_BYTES = 512 * 1024;
const IMG_KEEP = 600;
// 文件（含语音）单独存，名字保留原始文件名用于下载
const FILE_DIR = path.join(__dirname, 'data', 'files');
try { fs.mkdirSync(FILE_DIR, { recursive: true }); } catch (e) {}
const FILE_MAX_BYTES = 50 * 1024 * 1024;
const FILE_KEEP = 400;
const PART_MAX = 600 * 1024;      // 单片 base64 上限，避免超大帧

/* ------------------------- 账号 ------------------------- */
const DATA_DIR = path.join(__dirname, 'data');
// 开发者（收反馈的账号）：DEV_UID=100002 或 DEV_UIDS=100002,100016（可配多个）
const DEV_UIDS = (function () {
  const raw = process.env.DEV_UIDS || process.env.DEV_UID || '100002';
  const list = String(raw).split(',').map(x => Number(String(x).trim())).filter(n => n > 0);
  return list.length ? list : [100002];
})();
const DEV_UID = DEV_UIDS[0];   // 旧代码兼容：回复时用第一个

// ---- 反馈箱：所有用户的反馈都落到这一份，开发者登录就能看到 ----
const FB_FILE = path.join(DATA_DIR, 'feedback.json');
let feedback = [];
try { feedback = JSON.parse(fs.readFileSync(FB_FILE, 'utf8')) || []; } catch (e) { feedback = []; }
const FB_MAX = 800;
function saveFeedback() {
  try {
    const cut = feedback.length > FB_MAX ? feedback.slice(feedback.length - FB_MAX) : feedback;
    fs.writeFileSync(FB_FILE, JSON.stringify(cut, null, 1));
  } catch (e) { console.log('[feedback] 保存失败', e.message); }
}
function isDevAccount(acc) { return !!acc && DEV_UIDS.indexOf(Number(acc.uid)) >= 0; }
function devClients() {
  return [...clients].filter(c => c.account && isDevAccount(accounts[c.account]));
}
function fbPublic(f) {
  return { id: f.id, from: f.from || '', fromUid: f.fromUid || 0, name: f.name || '', text: f.text || '', ts: f.ts || 0, replied: !!f.replied, reply: f.reply || '' };
}
function pushFeedback(f, except) {
  const out = { t: 'fb', msg: fbPublic(f) };
  for (const c of devClients()) {
    if (except && c === except) continue;   // 自己发的不回给自己（否则开发者会一直收到自己的消息）
    if (f.fromUid && DEV_UIDS.indexOf(Number(f.fromUid)) >= 0 && c === except) continue;
    send(c, out);
  }
}
const ACC_FILE = path.join(DATA_DIR, 'accounts.json');
let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')) || {}; } catch (e) { accounts = {}; }
// 数字 ID：看着像 Telegram 那种，从这里开始发
const UID_BASE = 100001;
function rebuildUidIndex() {
  uidIndex = {};
  let max = UID_BASE - 1;
  for (const key of Object.keys(accounts)) {
    const acc = accounts[key];
    if (typeof acc.uid === 'number' && acc.uid > 0) max = Math.max(max, acc.uid);
  }
  let changed = false;
  for (const key of Object.keys(accounts)) {
    const acc = accounts[key];
    if (!(typeof acc.uid === 'number' && acc.uid > 0)) {
      acc.uid = max + 1; max = acc.uid; changed = true;
    }
    uidIndex[String(acc.uid)] = key;
  }
  if (changed) saveAccounts();
}
let uidIndex = {};
function ensureFriendFields(acc) {
  if (!Array.isArray(acc.friends)) acc.friends = [];
  if (!Array.isArray(acc.blocked)) acc.blocked = [];
  if (!Array.isArray(acc.blockedGroups)) acc.blockedGroups = [];
  if (!Array.isArray(acc.reqIn)) acc.reqIn = [];
  if (!Array.isArray(acc.reqOut)) acc.reqOut = [];
  return acc;
}
function accountByUid(n) {
  const key = uidIndex[String(n)];
  return key && accounts[key] ? accounts[key] : null;
}
function saveAccounts() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACC_FILE, JSON.stringify(accounts, null, 1));
  } catch (e) { console.log('[account] 保存失败', e.message); }
}
function hash(text, salt) {
  return crypto.scryptSync(String(text), salt, 32).toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
// 用户名规则：2–16 位，中英文、数字、下划线
function validUser(u) { return /^[\u4e00-\u9fa5A-Za-z0-9_]{2,16}$/.test(u); }
function findUser(u) {
  const lower = u.toLowerCase();
  return Object.keys(accounts).find(k => k.toLowerCase() === lower) || null;
}
// 账号相关：设备 ID 可能还没通过 join 设置，先从消息里取
function deviceOf(c, d) {
  if (c.deviceId) return c.deviceId;
  const raw = String((d && d.device) || '');
  if (/^[a-f0-9]{32}$/i.test(raw)) { c.deviceId = raw.toLowerCase(); return c.deviceId; }
  return null;
}
function maskUser(u) {
  if (u.length <= 2) return u[0] + '*';
  return u[0] + '*'.repeat(Math.max(1, u.length - 2)) + u[u.length - 1];
}
const history = new Map(ROOMS.map(r => [r.id, []]));
const clients = new Set();

/* ------------------------- 小工具 ------------------------- */
const now = () => Date.now();
const uid = () => crypto.randomBytes(8).toString('hex');
const roomIds = new Set(ROOMS.map(r => r.id));

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}
function onlineIn(roomId) {
  let n = 0;
  for (const c of clients) if (c.room === roomId) n++;
  return n;
}
function roomList() {
  return ROOMS.map(r => ({ id: r.id, name: r.name, emoji: r.emoji, online: onlineIn(r.id) }));
}
function publicHistory(roomId) {
  return (history.get(roomId) || []).map(publicMessage);
}
function send(c, obj) {
  writeFrame(c.socket, 0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
}
function broadcast(roomId, obj) {
  for (const c of clients) if (c.room === roomId) send(c, obj);
}
function avatarOfConn(c) {
  const acc = c && c.account ? accounts[c.account] : null;
  return (acc && acc.avatar) || '';
}
function membersIn(roomId) {
  return Array.from(clients)
    .filter(c => c.room === roomId)
    .map(c => ({ id: c.deviceId || c.id, name: c.name, avatar: avatarOfConn(c),
      uid: (c.account && accounts[c.account] && accounts[c.account].uid) || 0 }));
}
function peopleList() {
  const seen = new Map();
  for (const c of clients) {
    const id = c.deviceId || c.id;
    if (!seen.has(id)) seen.set(id, { id, name: c.name, avatar: avatarOfConn(c),
      uid: (c.account && accounts[c.account] && accounts[c.account].uid) || 0 });
  }
  return Array.from(seen.values());
}
function pressPeople() {
  const list = peopleList();
  for (const c of clients) send(c, { t: 'people', list });
}
function blockedBy(acc, otherUid) {
  return Array.isArray(acc.blocked) && acc.blocked.indexOf(otherUid) >= 0;
}
function eitherBlocked(a, b) {
  return blockedBy(a, b.uid) || blockedBy(b, a.uid);
}
function becomeFriends(a, b) {
  if (a.friends.indexOf(b.uid) < 0) a.friends.push(b.uid);
  if (b.friends.indexOf(a.uid) < 0) b.friends.push(a.uid);
}
function onlineOfUid(n) {
  const key = uidIndex[String(n)];
  if (!key) return false;
  return [...clients].some(c => c.account === key);
}
function publicFriend(uidNum) {
  const acc = accountByUid(uidNum);
  if (!acc) return null;
  const peer = [...clients].find(c => c.account === acc.user);
  return {
    uid: acc.uid,
    name: acc.nick || acc.user,
    avatar: acc.avatar || '',
    online: !!peer,
    dev: peer ? (peer.deviceId || peer.id) : null,
    pm: 'uid:' + acc.uid      // 私聊一律按账号寻址，离线也能发
  };
}
function contactsPayload(acc) {
  const friends = (acc.friends || []).map(publicFriend).filter(Boolean);
  const pendingIn = (acc.reqIn || []).map(r => publicFriend(r.uid)).filter(Boolean);
  const pendingOut = (acc.reqOut || []).map(r => publicFriend(r.uid)).filter(Boolean);
  return { t: 'contacts', uid: acc.uid, friends, pendingIn, pendingOut };
}
function pushToAccount(uidNum, obj) {
  const key = uidIndex[String(uidNum)];
  if (!key) return;
  for (const c of clients) if (c.account === key) send(c, obj);
}
// uid:<数字> 形式的会话方，解析成对方当前在线的设备 ID（离线返回 null）
function resolvePeer(to) {
  const m = /^uid:(\d+)$/.exec(String(to || ''));
  if (!m) return null;
  const key = uidIndex[m[1]];
  if (!key) return null;
  const peer = [...clients].find(c => c.account === key);
  return peer ? (peer.deviceId || peer.id) : null;
}
function clientsById(id) {
  const out = [];
  for (const c of clients) if ((c.deviceId || c.id) === id) out.push(c);
  return out;
}
// ---- 私聊：按账号寻址 + 落盘，保证离线也能收到 ----
const DM_DIR = path.join(__dirname, 'data', 'dm');
try { fs.mkdirSync(DM_DIR, { recursive: true }); } catch (e) {}

// 当前连接的身份：登录过用 uid:N，否则退回设备号
function dmIdOf(c) {
  if (c && c.account && accounts[c.account] && accounts[c.account].uid) {
    return 'uid:' + accounts[c.account].uid;
  }
  return (c && (c.deviceId || c.id)) || '';
}
// 把"对方"归一成 uid:N 或设备号
function normalizePeer(to) {
  const raw = String(to || '');
  if (/^uid:\d+$/.test(raw)) return raw;
  for (const c of clients) {
    if ((c.deviceId || c.id) === raw && c.account && accounts[c.account]) {
      return 'uid:' + accounts[c.account].uid;
    }
  }
  return raw;
}
// 私信会话键：双方身份排序后拼起来，同一会话只有一把键
function dmKey(a, b) {
  return 'dm:' + [a, b].sort().join('|');
}
function dmFile(key) {
  return path.join(DM_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
}
const dmLoaded = new Set();
function loadDm(key) {
  if (history.has(key)) return history.get(key);
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(dmFile(key), 'utf8')) || []; } catch (e) { arr = []; }
  history.set(key, arr);
  dmLoaded.add(key);
  return arr;
}
const dmDirty = new Set();
function saveDm(key) {
  if (!dmDirty.has(key)) {
    dmDirty.add(key);
    setTimeout(function () {
      dmDirty.delete(key);
      try {
        const arr = history.get(key) || [];
        fs.writeFileSync(dmFile(key), JSON.stringify(arr.slice(-HIST_MAX)));
      } catch (e) { console.log('[dm] 保存失败', e.message); }
    }, 300);
  }
}
function roomHistory(key) {
  if (key.indexOf('dm:') === 0) return loadDm(key);
  if (!history.has(key)) history.set(key, []);
  return history.get(key);
}
/* ------------------------- 图片存取 ------------------------- */
function saveImage(base64, ext) {
  const id = uid();
  const name = id + '.' + ext;
  fs.writeFileSync(path.join(IMG_DIR, name), Buffer.from(base64, 'base64'));
  gcImages();
  return '/img/' + name;
}
function gcImages() {
  try {
    const files = fs.readdirSync(IMG_DIR);
    if (files.length <= IMG_KEEP) return;
    const stats = files.map(f => ({ f, t: fs.statSync(path.join(IMG_DIR, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const s of stats.slice(0, files.length - IMG_KEEP)) {
      try { fs.unlinkSync(path.join(IMG_DIR, s.f)); } catch (e) {}
    }
  } catch (e) {}
}
/* ------------------------- 文件存取 ------------------------- */
function safeExt(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : 'bin';
}
// 没有扩展名时按 mime 补一个，播放器和下载器都靠它认类型
function extFor(name, mime) {
  let e = safeExt(name);
  if (e !== 'bin') return e;
  const m = String(mime || '').toLowerCase();
  if (m.indexOf('audio/webm') === 0) return 'webm';
  if (m.indexOf('audio/mp4') === 0 || m.indexOf('audio/aac') === 0) return 'm4a';
  if (m.indexOf('audio/mpeg') === 0) return 'mp3';
  if (m.indexOf('audio/ogg') === 0) return 'ogg';
  if (m.indexOf('audio/wav') === 0 || m.indexOf('audio/x-wav') === 0) return 'wav';
  if (m.indexOf('image/') === 0) return 'img';
  if (m.indexOf('video/') === 0) return 'mp4';
  if (m.indexOf('text/plain') === 0) return 'txt';
  if (m.indexOf('application/pdf') === 0) return 'pdf';
  return 'bin';
}
const EXT_MIME = {
  webm: 'audio/webm', m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  wav: 'audio/wav', m4r: 'audio/mp4', mp4: 'video/mp4', txt: 'text/plain; charset=utf-8',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', img: 'image/png',
  zip: 'application/zip', apk: 'application/vnd.android.package-archive'
};
/* ------------------------- 群聊 ------------------------- */
const GROUP_FILE = path.join(DATA_DIR, 'groups.json');
let groups = {};
try { groups = JSON.parse(fs.readFileSync(GROUP_FILE, 'utf8')) || {}; } catch (e) { groups = {}; }
function saveGroups() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GROUP_FILE, JSON.stringify(groups, null, 1));
  } catch (e) { console.log('[group] 保存失败', e.message); }
}
function groupPublic(g) {
  return { id: g.id, name: g.name, owner: g.owner, members: g.members.slice(), created: g.created };
}
function myGroups(who) {
  const keys = new Set([who]);
  // 兼容老数据：老成员记的是设备号，按设备号也认一次
  if (who.indexOf('uid:') === 0) { for (const c of clients) if (c.account && accounts[c.account] && ('uid:' + accounts[c.account].uid) === who && c.deviceId) keys.add(c.deviceId); }
  return Object.keys(groups).map(k => groups[k]).filter(g => g.members.some(m => keys.has(m))).map(groupPublic);
}
// 群里某个成员的私聊身份（uid:N）→ 该账号当前在线的连接
function clientsOfMember(id) {
  if (id.indexOf('uid:') === 0) {
    const key = uidIndex[id.slice(4)];
    return key ? [...clients].filter(c => c.account === key) : [];
  }
  return clientsById(id);
}
function groupKey(id) { return 'g:' + id; }
function notifyGroup(g, obj) {
  for (const c of clients) {
    const me = dmIdOf(c);
    const dev = c.deviceId || c.id;
    if (g.members.indexOf(me) < 0 && g.members.indexOf(dev) < 0) continue;
    const acc = c.account && accounts[c.account] ? ensureFriendFields(accounts[c.account]) : null;
    // 拉黑了这个群就不再推送它的消息
    if (acc && Array.isArray(acc.blockedGroups) && acc.blockedGroups.indexOf(g.id) >= 0) continue;
    send(c, obj);
  }
}

const uploads = new Map();   // 分片上传中转
function saveFile(base64, ext) {
  const id = uid();
  const name = id + '.' + ext;
  fs.writeFileSync(path.join(FILE_DIR, name), Buffer.from(base64, 'base64'));
  gcDir(FILE_DIR, FILE_KEEP);
  return '/file/' + name;
}
function gcDir(dir, keep) {
  try {
    const files = fs.readdirSync(dir);
    if (files.length <= keep) return;
    const stats = files.map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const s of stats.slice(0, files.length - keep)) { try { fs.unlinkSync(path.join(dir, s.f)); } catch (e) {} }
  } catch (e) {}
}
function parseFile(d) {
  // 允许 audio/webm;codecs=opus 这类带参数的类型
  const m = /^data:([\w.+-]+\/[\w.+-]+)(;[^,;]*)*;base64,([A-Za-z0-9+/=]+)$/.exec(String(d.data || ''));
  if (!m) return null;
  const buf = Buffer.from(m[3], 'base64');
  if (!buf.length) return null;
  if (buf.length > FILE_MAX_BYTES) return { tooBig: true };
  return { mime: m[1] || 'application/octet-stream', data: m[3] };
}
function humanSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function parseImage(d) {
  const raw = String(d.data || '');
  const m = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(raw);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > IMG_MAX_BYTES) return { tooBig: true };
  return { ext: m[1] === 'jpeg' ? 'jpg' : m[1], data: m[2] };
}
function isOwner(msg, c) {
  return msg.from === c.id || (!!c.deviceId && msg.deviceId === c.deviceId);
}
function publicMessage(msg) {
  const { ownerKey, ...visible } = msg;
  return visible;
}
function pressPresence(roomId) {
  broadcast(roomId, { t: 'presence', room: roomId, online: onlineIn(roomId) });
  broadcast(roomId, { t: 'members', room: roomId, members: membersIn(roomId) });
}

/* ------------------------- WebSocket 帧 ------------------------- */
function writeFrame(socket, opcode, payload) {
  if (socket.destroyed) return;
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  head[0] = 0x80 | opcode;
  try { socket.write(Buffer.concat([head, payload])); } catch (e) { /* ignore */ }
}

// 从缓冲区里尽量多解析出完整帧，返回 [帧数组, 剩余缓冲]
function readFrames(buf) {
  const frames = [];
  for (;;) {
    if (buf.length < 2) break;
    const b0 = buf[0], b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      const hi = buf.readUInt32BE(2), lo = buf.readUInt32BE(6);
      if (hi !== 0) { throw new Error('frame too large'); }
      len = lo; off = 10;
    }
    if (len > 1 << 20) throw new Error('frame too large');
    let mask = null;
    if (masked) {
      if (buf.length < off + 4) break;
      mask = buf.slice(off, off + 4); off += 4;
    }
    if (buf.length < off + len) break;
    const data = Buffer.from(buf.slice(off, off + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    frames.push({ fin, opcode, data });
    buf = buf.slice(off + len);
  }
  return [frames, buf];
}

/* ------------------------- 连接处理 ------------------------- */
function onConnection(socket) {
  const c = { socket, id: uid().slice(0, 6), deviceId: null, name: '路人', room: null, buf: Buffer.alloc(0), alive: true, frag: null, fragOp: 0, hits: [] };
  clients.add(c);

  socket.on('data', chunk => {
    c.buf = Buffer.concat([c.buf, chunk]);
    let frames;
    try {
      [frames, c.buf] = readFrames(c.buf);
    } catch (e) {
      socket.destroy();
      return;
    }
    for (const f of frames) {
      if (f.opcode === 0x8) {                       // close
        try { writeFrame(socket, 0x8, Buffer.alloc(0)); } catch (e) {}
        socket.destroy();
        return;
      }
      if (f.opcode === 0x9) { writeFrame(socket, 0xA, f.data); continue; }  // ping
      if (f.opcode === 0xA) { c.alive = true; continue; }                   // pong
      if (f.opcode === 0x0) {                                              // continuation
        if (c.frag) { c.frag = Buffer.concat([c.frag, f.data]); if (f.fin) { handleMessage(c, c.frag, c.fragOp); c.frag = null; } }
        continue;
      }
      if (f.opcode === 0x1 || f.opcode === 0x2) {
        if (!f.fin) { c.frag = f.data; c.fragOp = f.opcode; continue; }
        handleMessage(c, f.data, f.opcode);
      }
    }
  });

  socket.on('error', () => { socket.destroy(); });
  socket.on('close', () => {
    const wasRoom = c.room;
    if (wwGame) { try { wwGame.onDisconnect(wwApi(), c); } catch (e) {} }
    clients.delete(c);
    if (wasRoom) pressPresence(wasRoom);
    pressPeople();
  });
}

function handleMessage(c, buf, opcode) {
  if (opcode !== 0x1) return;
  let d;
  try { d = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
  if (!d || typeof d !== 'object') return;

  // 简单限流：1 秒最多 8 条（分片上传是正常的大流量，单独放行）
  const isUploadChunk = d.t === 'file_part' || d.t === 'file_start' || d.t === 'file_end';
  if (!isUploadChunk) {
    const t = now();
    c.hits = c.hits.filter(x => t - x < 1000);
    if (c.hits.length > 8) { send(c, { t: 'error', message: '慢一点，消息太密了' }); return; }
    c.hits.push(t);
  }

  if (typeof d.t === 'string' && d.t.indexOf('ww_') === 0) {
    if (!wwGame) { send(c, { t: 'ww_error', message: '这个服务器没有安装游戏模块' }); return; }
    wwGame.handle(c, d, wwApi());
    return;
  }

  // 改昵称：账号名不变，只改显示名（用户接入用它把面板里的「名称」同步给账号）
  if (d.t === 'nick') {
    const nick = clean(d.nick, MAX_NAME);
    if (!nick) { send(c, { t: 'error', message: '名称不能为空' }); return; }
    const acc = c.account && accounts[c.account] ? ensureFriendFields(accounts[c.account]) : null;
    if (acc) { acc.nick = nick; saveAccounts(); }
    c.name = nick;
    pressPeople();
    pressPresence(c.room);
    send(c, { t: 'nick_ok', nick });
    return;
  }

  if (d.t === 'join') {
    c.name = clean(d.name, MAX_NAME) || ('路人' + Math.floor(Math.random() * 900 + 100));
    c.deviceId = /^[a-f0-9]{32}$/i.test(d.device || '') ? d.device.toLowerCase() : null;
    c.room = roomIds.has(d.room) ? d.room : 'lobby';
    send(c, {
      t: 'welcome', you: { id: c.id, name: c.name },
      rooms: roomList(), room: c.room, history: publicHistory(c.room), members: membersIn(c.room)
    });
    pressPresence(c.room);
    pressPeople();
    console.log('[join]', c.name, '#' + c.id, '→', c.room, '在线', onlineIn(c.room));
    return;
  }

  if (d.t === 'room') {
    const next = roomIds.has(d.room) ? d.room : 'lobby';
    if (c.room === next) { send(c, { t: 'welcome', you: { id: c.id, name: c.name }, rooms: roomList(), room: next, history: publicHistory(next), members: membersIn(next) }); return; }
    const prev = c.room;
    c.room = next;
    send(c, {
      t: 'welcome', you: { id: c.id, name: c.name },
      rooms: roomList(), room: next, history: publicHistory(next), members: membersIn(next)
    });
    if (prev) pressPresence(prev);
    pressPresence(next);
    return;
  }

  if (d.t === 'msg') {
    if (!c.room) return;
    const text = clean(d.text, MAX_TEXT);
    if (!text) return;
    const acct = (c.account && accounts[c.account]) || null;
    const msg = {
      id: uid(), room: c.room, from: c.id, name: c.name, text, ts: now(),
      avatar: (acct && acct.avatar) || '',
      uid: acct ? acct.uid : 0,
      tempId: d.tempId ? clean(d.tempId, 40) : null,
      deviceId: c.deviceId,
      ownerKey: null,
      big: !!d.big,
      replyTo: null,
      mentions: []
    };
    if (d.replyTo && typeof d.replyTo === 'object') {
      const quoted = (history.get(c.room) || []).find(m => m.id === clean(d.replyTo.id, 32) && !m.retracted);
      if (quoted) msg.replyTo = { id: quoted.id, from: quoted.from, name: quoted.name, text: clean(quoted.text, 180) };
    }
    if (Array.isArray(d.mentions)) {
      const ids = new Set(d.mentions.slice(0, 16).map(v => clean(typeof v === 'object' ? v.id : v, 64)));
      msg.mentions = membersIn(c.room).filter(m => ids.has(m.id));
    }
    const arr = history.get(c.room);
    arr.push(msg);
    if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX);
    broadcast(c.room, { t: 'msg', msg: publicMessage(msg) });
    return;
  }

  if (d.t === 'retract') {
    if (!c.room) return;
    const messageId = clean(d.id, 32);
    const key = typeof d.room === 'string' && d.room.indexOf('dm:') === 0 ? d.room : c.room;
    const arr = roomHistory(key);
    const msg = arr.find(m => m.id === messageId);
    if (!msg) { send(c, { t: 'error', message: '消息不存在或已不在记录中' }); return; }
    if (!isOwner(msg, c)) { send(c, { t: 'error', message: '只能撤回自己发送的消息' }); return; }
    if (now() - msg.ts > 5 * 60 * 1000) { send(c, { t: 'error', message: '消息发送已超过 5 分钟，不能撤回' }); return; }
    msg.text = '';
    msg.retracted = true;
    msg.replyTo = null;
    msg.mentions = [];
    msg.retractedAt = now();
    for (const peer of clients) {
      if (peer.room === c.room || key.indexOf('dm:') === 0) {
        if (key.indexOf('dm:') === 0 && !key.includes(peer.deviceId || peer.id)) continue;
        send(peer, { t: 'retract', room: key, id: msg.id, from: c.id, ts: msg.retractedAt });
      }
    }
    return;
  }

  // ---------- 私信 ----------
  if (d.t === 'pm_open') {
    const asked = clean(d.with, 64);
    if (!asked) return;
    const me = dmIdOf(c);
    const other = normalizePeer(asked);
    const key = dmKey(me, other);
    const peerKey = other.indexOf('uid:') === 0 ? uidIndex[other.slice(4)] : null;
    const peer = peerKey ? [...clients].find(x => x.account === peerKey) : clientsById(other)[0];
    const peerAcc = other.indexOf('uid:') === 0 ? accountByUid(other.slice(4)) : null;
    send(c, {
      t: 'pm_history', room: key, with: other,
      peer: { id: other, name: peer ? peer.name : (clean(d.withName, MAX_NAME) || '对方'), uid: peerAcc ? peerAcc.uid : 0, dev: peer ? (peer.deviceId || peer.id) : null },
      history: roomHistory(key).map(publicMessage)
    });
    return;
  }

  // ---------- 反馈箱 ----------
  if (d.t === 'fb') {
    const text = clean(d.text, MAX_TEXT);
    if (!text) return;
    const acc = c.account && accounts[c.account] ? accounts[c.account] : null;
    const fb = {
      id: uid(), from: dmIdOf(c), fromUid: (acc && acc.uid) || 0, name: c.name || '',
      text: text, ts: now(), replied: false, dmRoom: ''
    };
    feedback.push(fb);
    saveFeedback();
    pushFeedback(fb, c);
    send(c, { t: 'fb_ok', id: fb.id, ts: fb.ts });
    return;
  }
  if (d.t === 'fb_list') {
    const acc = c.account && accounts[c.account] ? accounts[c.account] : null;
    if (!isDevAccount(acc)) { send(c, { t: 'fb_list', items: [] }); return; }
    const items = feedback.slice(Math.max(0, feedback.length - 300)).map(fbPublic);
    send(c, { t: 'fb_list', items: items });
    return;
  }
  if (d.t === 'fb_reply') {
    const acc = c.account && accounts[c.account] ? accounts[c.account] : null;
    if (!isDevAccount(acc)) { send(c, { t: 'error', message: '只有开发者能回复反馈' }); return; }
    const text = clean(d.text, MAX_TEXT);
    const toUid = Number(d.toUid || 0);
    if (!text || !toUid) return;
    if (DEV_UIDS.indexOf(toUid) >= 0) { send(c, { t: 'error', message: '不能把反馈回复给开发者自己' }); return; }
    const target = accountByUid(toUid);
    if (!target) { send(c, { t: 'error', message: '这个用户已经不在了' }); return; }
    const fb = feedback.find(x => Number(x.fromUid) === toUid && !x.replied) || null;
    if (fb) { fb.replied = true; fb.reply = text; saveFeedback(); }
    // 回复以私信送回用户（离线也能收到，下次登录拉历史即可）
    const me = 'uid:' + DEV_UID;
    const other = 'uid:' + target.uid;
    const key = dmKey(me, other);
    const msg = {
      id: uid(), room: key, from: me, name: c.name || '开发者', text: text, ts: now(),
      avatar: '', tempId: null, deviceId: me, fromUid: DEV_UID, replyTo: null, mentions: []
    };
    const arr = roomHistory(key);
    arr.push(msg);
    if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX);
    saveDm(key);
    const out = { t: 'pm', msg: publicMessage(msg), room: key, with: other };
    const peerKey = uidIndex[String(target.uid)];
    const targets = peerKey ? [...clients].filter(x => x.account === peerKey) : [];
    for (const peer of targets) send(peer, out);
    send(c, { t: 'fb_ok', id: fb ? fb.id : '', ts: msg.ts, reply: true });
    return;
  }

  if (d.t === 'pm') {
    const asked = clean(d.to, 64);
    if (!asked) return;
    const me = dmIdOf(c);
    const other = normalizePeer(asked);
    if (other === me) { send(c, { t: 'error', message: '不能给自己发私信' }); return; }
    const text = clean(d.text, MAX_TEXT);
    if (!text) return;
    const peerAcc = other.indexOf('uid:') === 0 ? accountByUid(other.slice(4)) : null;
    const myAcc = c.account && accounts[c.account] ? accounts[c.account] : null;
    if (peerAcc && myAcc && eitherBlocked(ensureFriendFields(myAcc), ensureFriendFields(peerAcc))) {
      send(c, { t: 'error', message: '你们之间已拉黑，消息发不出去' });
      return;
    }
    const key = dmKey(me, other);
    const msg = {
      id: uid(), room: key, from: me, name: c.name, text, ts: now(),
      avatar: (myAcc && myAcc.avatar) || '',
      tempId: d.tempId ? clean(d.tempId, 40) : null,
      deviceId: me, fromUid: myAcc ? myAcc.uid : 0, replyTo: null, mentions: []
    };
    if (d.replyTo && typeof d.replyTo === 'object') {
      const quoted = roomHistory(key).find(m => m.id === clean(d.replyTo.id, 32) && !m.retracted);
      if (quoted) msg.replyTo = { id: quoted.id, from: quoted.from, name: quoted.name, text: clean(quoted.text, 180) };
    }
    const arr = roomHistory(key);
    arr.push(msg);
    if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX);
    saveDm(key);
    // 发给开发者的私信 = 反馈：进反馈库，开发者登录/在线都能收到
    if (peerAcc && DEV_UIDS.indexOf(Number(peerAcc.uid)) >= 0) {
      const fb = {
        id: msg.id, from: me, fromUid: (myAcc && myAcc.uid) || 0, name: c.name || '',
        text: text, ts: msg.ts, replied: false, dmRoom: key
      };
      feedback.push(fb);
      saveFeedback();
      pushFeedback(fb, c);
    }
    const peerKey = other.indexOf('uid:') === 0 ? uidIndex[other.slice(4)] : null;
    const targets = peerKey ? [...clients].filter(x => x.account === peerKey) : clientsById(other);
    const out = { t: 'pm', msg: publicMessage(msg), room: key, with: other };
    send(c, out);
    for (const peer of targets) send(peer, out);
    if (!targets.length) send(c, { t: 'pm_saved', room: key, with: other, message: '对方不在线，消息已存到服务器' });
    return;
  }

  // ---------- 图片 / 表情 ----------
  if (d.t === 'img') {
    const to = d.to ? clean(d.to, 64) : '';
    const me = c.deviceId || c.id;
    let imagePath = null;
    let w = 0, h = 0;

    // 复用已有图片（收藏的表情直接再发一次）
    if (typeof d.ref === 'string' && /^\/img\/[a-f0-9]{16}\.(jpg|png|webp|gif)$/.test(d.ref)) {
      imagePath = d.ref;
    } else {
      const parsed = parseImage(d);
      if (!parsed) { send(c, { t: 'error', message: '图片格式不支持' }); return; }
      if (parsed.tooBig) { send(c, { t: 'error', message: '图片太大，请压缩后再发' }); return; }
      imagePath = saveImage(parsed.data, parsed.ext);
    }
    w = Math.max(0, Math.min(4096, Number(d.w) || 0));
    h = Math.max(0, Math.min(4096, Number(d.h) || 0));

    const gid = d.gid ? clean(d.gid, 32) : '';
    const grp = gid ? groups[gid] : null;
    if (gid && (!grp || grp.members.indexOf(me) < 0)) { send(c, { t: 'error', message: '你不在这个群里' }); return; }
    const key = grp ? groupKey(grp.id) : (to ? dmKey(me, to) : c.room);
    if (!key) return;

    const msg = {
      id: uid(), room: key, from: grp ? me : (to ? me : c.id), deviceId: grp ? me : (to ? me : c.deviceId),
      name: c.name, text: clean(d.caption || '', 120), ts: now(),
      tempId: d.tempId ? clean(d.tempId, 40) : null,
      image: imagePath, w, h, sticker: !!d.sticker, replyTo: null, mentions: []
    };
    const arr = roomHistory(key);
    arr.push(msg);
    if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX);

    if (grp) {
      notifyGroup(grp, { t: 'group_msg', msg: publicMessage(msg), gid: grp.id });
      return;
    }
    const out = { t: to ? 'pm' : 'msg', msg: publicMessage(msg) };
    if (to) { out.room = key; out.with = to; }
    send(c, out);
    if (to) {
      for (const peer of clientsById(to)) send(peer, out);
    } else {
      broadcast(c.room, out);
    }
    return;
  }

  // ---------- 账号 ----------
  if (d.t === 'register') {
    const user = clean(d.user, 16);
    const pass = String(d.pass || '');
    const question = clean(d.question, 40);
    const answer = clean(d.answer, 40);
    if (!validUser(user)) { send(c, { t: 'auth', ok: false, err: '用户名要 2–16 位，只能是中文、字母、数字或下划线' }); return; }
    if (findUser(user)) { send(c, { t: 'auth', ok: false, err: '这个用户名已经被注册了，换一个吧' }); return; }
    if (pass.length < 4 || pass.length > 64) { send(c, { t: 'auth', ok: false, err: '密码至少 4 位' }); return; }
    if (!question || !answer) { send(c, { t: 'auth', ok: false, err: '请设置密保问题并填写答案，忘记账号时要用' }); return; }
    const salt = newSalt(), aSalt = newSalt();
    const nextUid = (function () {
      let max = UID_BASE - 1;
      for (const k of Object.keys(accounts)) if (accounts[k].uid > max) max = accounts[k].uid;
      return max + 1;
    })();
    accounts[user] = {
      user: user,
      uid: nextUid,
      friends: [], reqIn: [], reqOut: [],
      nick: clean(d.nick, MAX_NAME) || user,
      salt, hash: hash(pass, salt),
      question, aSalt, aHash: hash(answer.toLowerCase(), aSalt),
      devices: (function(dev){ return dev ? [dev] : []; })(deviceOf(c, d)),
      created: now()
    };
    saveAccounts();
    c.account = user;
    c.name = accounts[user].nick;
    ensureFriendFields(accounts[user]);
    accounts[user].token = crypto.randomBytes(24).toString('hex');
    saveAccounts();
    uidIndex[String(nextUid)] = user;
    send(c, { t: 'auth', ok: true, action: 'register', user: user, nick: c.name, uid: nextUid, token: accounts[user].token, question: question, dev: DEV_UIDS.indexOf(Number(nextUid)) >= 0, devUids: DEV_UIDS });
    pressPeople();
    return;
  }

  if (d.t === 'login') {
    const user = clean(d.user, 16);
    const key = findUser(user);
    if (!key) { send(c, { t: 'auth', ok: false, err: '没有这个账号' }); return; }
    const acc = accounts[key];
    if (hash(String(d.pass || ''), acc.salt) !== acc.hash) { send(c, { t: 'auth', ok: false, err: '密码不对' }); return; }
    const dev = deviceOf(c, d);
    if (dev && acc.devices.indexOf(dev) < 0) {
      acc.devices.push(dev);
      if (acc.devices.length > 10) acc.devices = acc.devices.slice(-10);
      saveAccounts();
    }
    c.account = key;
    c.name = acc.nick || key;
    ensureFriendFields(acc);
    if (!acc.uid) rebuildUidIndex();
    if (!acc.token) { acc.token = crypto.randomBytes(24).toString('hex'); saveAccounts(); }
    send(c, { t: 'auth', ok: true, action: 'login', user: key, nick: c.name, uid: acc.uid, token: acc.token, dev: isDevAccount(acc), devUids: DEV_UIDS });
    pressPeople();
    return;
  }

  // 用令牌恢复登录（重启 App、换网络都不用重新输入密码）
  if (d.t === 'resume') {
    const token = String(d.token || '');
    if (!token || token.length < 16) { send(c, { t: 'auth', ok: false, action: 'resume', err: '没有令牌' }); return; }
    let hit = null;
    for (const k of Object.keys(accounts)) {
      if (accounts[k].token === token) { hit = k; break; }
    }
    if (!hit) { send(c, { t: 'auth', ok: false, action: 'resume', err: '令牌已失效' }); return; }
    const acc = ensureFriendFields(accounts[hit]);
    if (!acc.uid) rebuildUidIndex();
    const dev = deviceOf(c, d);
    if (dev && acc.devices.indexOf(dev) < 0) {
      acc.devices.push(dev);
      if (acc.devices.length > 10) acc.devices = acc.devices.slice(-10);
      saveAccounts();
    }
    c.account = hit;
    c.name = acc.nick || hit;
    send(c, { t: 'auth', ok: true, action: 'resume', user: hit, nick: c.name, uid: acc.uid, token: acc.token, dev: isDevAccount(acc), devUids: DEV_UIDS });
    pressPeople();
    return;
  }

  // 忘记账号：用本机绑定过的账号 + 密保答案找回
  if (d.t === 'recover') {
    const answer = clean(d.answer, 40).toLowerCase();
    const dev = deviceOf(c, d);
    const mine = Object.keys(accounts).filter(k => dev && accounts[k].devices && accounts[k].devices.indexOf(dev) >= 0);
    if (!mine.length) { send(c, { t: 'recover', ok: false, err: '这台手机上没有登录过任何账号，试试用用户名登录' }); return; }
    const hit = mine.find(k => hash(answer, accounts[k].aSalt) === accounts[k].aHash);
    if (!hit) { send(c, { t: 'recover', ok: false, err: '密保答案不对' }); return; }
    send(c, { t: 'recover', ok: true, user: hit, masked: maskUser(hit), question: accounts[hit].question });
    return;
  }

  // 用用户名 + 密保答案重置密码
  if (d.t === 'resetpass') {
    const key = findUser(clean(d.user, 16));
    if (!key) { send(c, { t: 'error', message: '没有这个账号' }); return; }
    const acc = accounts[key];
    if (hash(clean(d.answer, 40).toLowerCase(), acc.aSalt) !== acc.aHash) { send(c, { t: 'error', message: '密保答案不对' }); return; }
    const pass = String(d.pass || '');
    if (pass.length < 4 || pass.length > 64) { send(c, { t: 'error', message: '密码至少 4 位' }); return; }
    acc.salt = newSalt();
    acc.hash = hash(pass, acc.salt);
    saveAccounts();
    send(c, { t: 'auth', ok: true, action: 'reset', user: key, nick: acc.nick || key });
    return;
  }

  if (d.t === 'question') {
    const key = findUser(clean(d.user, 16));
    if (!key) { send(c, { t: 'error', message: '没有这个账号' }); return; }
    send(c, { t: 'question', user: key, question: accounts[key].question });
    return;
  }

  // ---------- 群聊 ----------
  if (d.t === 'group_create') {
    const me = dmIdOf(c);
    const name = clean(d.name, 20) || (c.name + '的群');
    const members = new Set([me]);
    (Array.isArray(d.members) ? d.members : []).slice(0, 60).forEach(function (v) {
      const id = clean(typeof v === 'object' ? v.id : v, 64);
      if (id) members.add(id);
    });
    const g = { id: uid(), name: name, owner: me, members: Array.from(members), created: now() };
    groups[g.id] = g;
    saveGroups();
    if (history.has(groupKey(g.id))) history.delete(groupKey(g.id));
    send(c, { t: 'group_created', group: groupPublic(g) });
    notifyGroup(g, { t: 'groups', groups: myGroups(me) });
    for (const id of g.members) {
      if (id === me) continue;
      for (const peer of clientsOfMember(id)) send(peer, { t: 'groups', groups: myGroups(id) });
    }
    return;
  }

  if (d.t === 'groups') {
    const me = dmIdOf(c);
    send(c, { t: 'groups', groups: myGroups(me) });
    return;
  }

  if (d.t === 'group_open') {
    const me = dmIdOf(c);
    const g = groups[clean(d.id, 32)];
    if (!g || (g.members.indexOf(me) < 0 && g.members.indexOf(c.deviceId || c.id) < 0)) { send(c, { t: 'error', message: '你不在这个群里' }); return; }
    send(c, {
      t: 'group_history', group: groupPublic(g),
      history: (history.get(groupKey(g.id)) || []).map(publicMessage)
    });
    return;
  }

  if (d.t === 'group_msg') {
    const me = dmIdOf(c);
    const g = groups[clean(d.id, 32)];
    if (!g || (g.members.indexOf(me) < 0 && g.members.indexOf(c.deviceId || c.id) < 0)) return;
    const text = clean(d.text, MAX_TEXT);
    if (!text) return;
    const msg = {
      id: uid(), room: groupKey(g.id), from: me, name: c.name, text, ts: now(),
      tempId: d.tempId ? clean(d.tempId, 40) : null, deviceId: me,
      image: null, file: null, big: !!d.big, replyTo: null, mentions: []
    };
    if (d.replyTo && typeof d.replyTo === 'object') {
      const quoted = (history.get(groupKey(g.id)) || []).find(m => m.id === clean(d.replyTo.id, 32) && !m.retracted);
      if (quoted) msg.replyTo = { id: quoted.id, from: quoted.from, name: quoted.name, text: clean(quoted.text, 180) };
    }
    if (Array.isArray(d.mentions)) {
      const ids = new Set(d.mentions.slice(0, 16).map(v => clean(typeof v === 'object' ? v.id : v, 64)));
      msg.mentions = g.members.filter(id => ids.has(id)).map(id => {
        const p = clientsById(id)[0];
        return { id: id, name: p ? p.name : id };
      });
    }
    const arr = roomHistory(groupKey(g.id));
    arr.push(msg);
    if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX);
    notifyGroup(g, { t: 'group_msg', msg: publicMessage(msg), gid: g.id });
    return;
  }

  if (d.t === 'group_invite') {
    const me = dmIdOf(c);
    const g = groups[clean(d.id, 32)];
    if (!g || g.members.indexOf(me) < 0) return;
    if (g.owner !== me) { send(c, { t: 'error', message: '只有群主可以拉人进群' }); return; }
    (Array.isArray(d.members) ? d.members : []).slice(0, 40).forEach(function (v) {
      const id = clean(typeof v === 'object' ? v.id : v, 64);
      if (id && g.members.indexOf(id) < 0) g.members.push(id);
    });
    saveGroups();
    for (const id of g.members) for (const peer of clientsOfMember(id)) send(peer, { t: 'groups', groups: myGroups(id) });
    notifyGroup(g, { t: 'group_update', group: groupPublic(g) });
    return;
  }

  if (d.t === 'group_kick') {
    const me = c.deviceId || c.id;
    const g = groups[clean(d.id, 32)];
    if (!g) return;
    if (g.owner !== me) { send(c, { t: 'error', message: '只有群主可以踢人' }); return; }
    const target = clean(d.member, 64);
    if (target === g.owner) { send(c, { t: 'error', message: '不能踢自己' }); return; }
    if (g.members.indexOf(target) < 0) { send(c, { t: 'error', message: '这个人不在群里' }); return; }
    g.members = g.members.filter(id => id !== target);
    saveGroups();
    for (const peer of clientsById(target)) send(peer, { t: 'group_kicked', gid: g.id, by: me });
    for (const id of g.members) for (const peer of clientsById(id)) send(peer, { t: 'groups', groups: myGroups(id) });
    notifyGroup(g, { t: 'group_update', group: groupPublic(g) });
    return;
  }

  if (d.t === 'group_leave') {
    const me = dmIdOf(c);
    const g = groups[clean(d.id, 32)];
    if (!g) return;
    g.members = g.members.filter(id => id !== me);
    if (!g.members.length) delete groups[g.id];
    saveGroups();
    send(c, { t: 'groups', groups: myGroups(me) });
    notifyGroup(g, { t: 'group_update', group: groupPublic(g) });
    return;
  }

  // ---------- 分片上传（大文件） ----------
  if (d.t === 'file_start') {
    const id = clean(d.id, 32);
    if (!id) return;
    if (Number(d.size) > FILE_MAX_BYTES) {
      send(c, { t: 'error', message: '文件超过 ' + (FILE_MAX_BYTES / 1048576).toFixed(0) + ' MB' });
      return;
    }
    uploads.set(id, { c, parts: [], size: 0, meta: d });
    send(c, { t: 'file_ack', id, seq: 0 });
    return;
  }

  if (d.t === 'file_part') {
    const u = uploads.get(clean(d.id, 32));
    if (!u || u.c !== c) return;
    const chunk = String(d.data || '');
    if (chunk.length > PART_MAX) { uploads.delete(d.id); send(c, { t: 'error', message: '分片太大' }); return; }
    u.parts.push(chunk);
    u.size += chunk.length;
    if (u.size > (FILE_MAX_BYTES * 1.4)) { uploads.delete(d.id); send(c, { t: 'error', message: '文件太大' }); return; }
    send(c, { t: 'file_ack', id: clean(d.id, 32), seq: Number(d.seq) || 0 });
    return;
  }

  if (d.t === 'file_end') {
    const id = clean(d.id, 32);
    const u = uploads.get(id);
    if (!u || u.c !== c) { send(c, { t: 'error', message: '上传已失效，请重发' }); return; }
    uploads.delete(id);
    const b64 = u.parts.join('');
    d.data = 'data:' + (u.meta.mime || 'application/octet-stream') + ';base64,' + b64;
    d.name = u.meta.name; d.size = u.meta.size; d.mime = u.meta.mime;
    d.voice = u.meta.voice; d.duration = u.meta.duration;
    d.to = u.meta.to; d.tempId = u.meta.tempId;
    d.t = 'file';
    // 落到下面的单次处理
  }

  // ---------- 文件 / 语音 ----------
  if (d.t === 'file') {
    const to = d.to ? clean(d.to, 64) : '';
    const me = c.deviceId || c.id;
    const parsed = parseFile(d);
    if (!parsed) { send(c, { t: 'error', message: '文件内容读不出' }); return; }
    if (parsed.tooBig) { send(c, { t: 'error', message: '文件超过 8 MB，先压缩或分卷' }); return; }
    const rawName = clean(d.name, 80) || ('文件.' + extFor('', parsed.mime));
    const savedPath = saveFile(parsed.data, extFor(rawName, parsed.mime));
    const gid2 = d.gid ? clean(d.gid, 32) : '';
    const grp2 = gid2 ? groups[gid2] : null;
    if (gid2 && (!grp2 || grp2.members.indexOf(me) < 0)) { send(c, { t: 'error', message: '你不在这个群里' }); return; }
    const key = grp2 ? groupKey(grp2.id) : (to ? dmKey(me, to) : c.room);
    if (!key) return;
    const msg = {
      id: uid(), room: key, from: to ? me : c.id, deviceId: to ? me : c.deviceId,
      avatar: (c.account && accounts[c.account] && accounts[c.account].avatar) || '',
      name: c.name, text: '', ts: now(),
      tempId: d.tempId ? clean(d.tempId, 40) : null,
      file: savedPath, fileName: rawName, fileSize: Number(d.size) || 0,
      mime: clean(d.mime, 60) || parsed.mime,
      voice: !!d.voice, duration: Number(d.duration) || 0,
      replyTo: null, mentions: []
    };
    const arr = roomHistory(key);
    arr.push(msg);
    if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX);
    if (grp2) {
      notifyGroup(grp2, { t: 'group_msg', msg: publicMessage(msg), gid: grp2.id });
      return;
    }
    const out = { t: to ? 'pm' : 'msg', msg: publicMessage(msg) };
    if (to) { out.room = key; out.with = to; }
    send(c, out);
    if (to) { for (const peer of clientsById(to)) send(peer, out); }
    else { broadcast(c.room, out); }
    return;
  }

  // ---------- 好友 ----------
  if (d.t === 'contacts') {
    const acc = c.account && ensureFriendFields(accounts[c.account]);
    if (!acc) { send(c, { t: 'contacts', uid: 0, friends: [], pendingIn: [], pendingOut: [] }); return; }
    send(c, contactsPayload(acc));
    return;
  }

  if (d.t === 'contact_search') {
    const n = Number(d.uid);
    const acc = c.account && ensureFriendFields(accounts[c.account]);
    if (!acc) { send(c, { t: 'error', message: '请先登录' }); return; }
    const hit = accountByUid(n);
    if (!hit) { send(c, { t: 'contact_result', found: false, uid: n }); return; }
    send(c, { t: 'contact_result', found: true, uid: hit.uid, name: hit.nick || hit.user });
    return;
  }

  if (d.t === 'contact_add') {
    const n = Number(d.uid);
    const acc = c.account && ensureFriendFields(accounts[c.account]);
    if (!acc) { send(c, { t: 'error', message: '请先登录' }); return; }
    const target = accountByUid(n);
    if (!target) { send(c, { t: 'error', message: '没有这个 ID 的用户' }); return; }
    if (target.uid === acc.uid) { send(c, { t: 'error', message: '不能加自己' }); return; }
    ensureFriendFields(target);
    if (blockedBy(target, acc.uid)) { send(c, { t: 'error', message: '对方已拒绝接收好友申请' }); return; }
    if (blockedBy(acc, target.uid)) { send(c, { t: 'error', message: '你已把对方拉黑，先解除拉黑' }); return; }
    if (acc.friends.indexOf(target.uid) >= 0) { send(c, { t: 'error', message: '你们已经是好友了' }); return; }
    if (acc.reqOut.some(r => r.uid === target.uid)) { send(c, { t: 'error', message: '申请已经发过了，等对方通过' }); return; }
    // 对方已经申请过我：直接互为好友
    const back = target.reqOut.find(r => r.uid === acc.uid);
    if (back) {
      target.reqOut = target.reqOut.filter(r => r.uid !== acc.uid);
      acc.reqIn = acc.reqIn.filter(r => r.uid !== target.uid);
      becomeFriends(acc, target);
      saveAccounts();
      send(c, contactsPayload(acc));
      pushToAccount(target.uid, { t: 'contact_event', message: (acc.nick || acc.user) + ' 已通过你的好友申请' });
      pushToAccount(target.uid, contactsPayload(target));
      return;
    }
    ensureFriendFields(target);
    acc.reqOut.push({ uid: target.uid, ts: now() });
    if (!target.reqIn.some(r => r.uid === acc.uid)) target.reqIn.push({ uid: acc.uid, ts: now() });
    saveAccounts();
    send(c, { t: 'contact_event', message: '好友申请已发送' });
    send(c, contactsPayload(acc));
    pushToAccount(target.uid, { t: 'contact_event', message: (acc.nick || acc.user) + ' 请求加你为好友' });
    pushToAccount(target.uid, contactsPayload(target));
    return;
  }

  if (d.t === 'contact_accept' || d.t === 'contact_decline') {
    const n = Number(d.uid);
    const acc = c.account && ensureFriendFields(accounts[c.account]);
    if (!acc) { send(c, { t: 'error', message: '请先登录' }); return; }
    const req = acc.reqIn.find(r => r.uid === n);
    if (!req) { send(c, { t: 'error', message: '没有这个好友申请' }); return; }
    const other = accountByUid(n);
    acc.reqIn = acc.reqIn.filter(r => r.uid !== n);
    if (other) {
      ensureFriendFields(other);
      other.reqOut = other.reqOut.filter(r => r.uid !== acc.uid);
      if (d.t === 'contact_accept') becomeFriends(acc, other);
    }
    saveAccounts();
    send(c, contactsPayload(acc));
    if (other) {
      pushToAccount(other.uid, { t: 'contact_event', message: d.t === 'contact_accept'
        ? (acc.nick || acc.user) + ' 通过了你的好友申请' : (acc.nick || acc.user) + ' 拒绝了你的好友申请' });
      pushToAccount(other.uid, contactsPayload(other));
    }
    return;
  }

  if (d.t === 'contact_block' || d.t === 'contact_unblock') {
    const n = Number(d.uid);
    const acc = c.account && ensureFriendFields(accounts[c.account]);
    if (!acc) { send(c, { t: 'error', message: '请先登录' }); return; }
    const other = accountByUid(n);
    if (!other) { send(c, { t: 'error', message: '没有这个 ID' }); return; }
    ensureFriendFields(other);
    if (d.t === 'contact_block') {
      if (acc.blocked.indexOf(n) < 0) acc.blocked.push(n);
      acc.friends = acc.friends.filter(x => x !== n);
      acc.reqIn = acc.reqIn.filter(r => r.uid !== n);
      acc.reqOut = acc.reqOut.filter(r => r.uid !== n);
      other.friends = other.friends.filter(x => x !== acc.uid);
      other.reqIn = other.reqIn.filter(r => r.uid !== acc.uid);
      other.reqOut = other.reqOut.filter(r => r.uid !== acc.uid);
      saveAccounts();
      send(c, contactsPayload(acc));
      pushToAccount(other.uid, contactsPayload(other));
      send(c, { t: 'contact_event', message: '已拉黑，对方不能再加你或给你发消息' });
      return;
    }
    acc.blocked = acc.blocked.filter(x => x !== n);
    saveAccounts();
    send(c, contactsPayload(acc));
    send(c, { t: 'contact_event', message: '已解除拉黑' });
    return;
  }

  if (d.t === 'blocked_list') {
    const acc = c.account && ensureFriendFields(accounts[c.account]);
    if (!acc) { send(c, { t: 'blocked', users: [], groups: [] }); return; }
    send(c, {
      t: 'blocked',
      users: acc.blocked.map(u => publicFriend(u)).filter(Boolean),
      groups: (acc.blockedGroups || []).map(id => groups[id] ? { id: id, name: groups[id].name } : null).filter(Boolean)
    });
    return;
  }

  if (d.t === 'group_block' || d.t === 'group_unblock') {
    const me = dmIdOf(c);
    const acc = c.account && ensureFriendFields(accounts[c.account]);
    if (!acc) { send(c, { t: 'error', message: '请先登录' }); return; }
    const g = groups[clean(d.id, 32)];
    if (!g) { send(c, { t: 'error', message: '群不存在' }); return; }
    if (d.t === 'group_block') {
      if (acc.blockedGroups.indexOf(g.id) < 0) acc.blockedGroups.push(g.id);
      g.members = g.members.filter(x => x !== me);
      saveAccounts(); saveGroups();
      send(c, { t: 'groups', groups: myGroups(me) });
      notifyGroup(g, { t: 'group_update', group: groupPublic(g) });
      send(c, { t: 'contact_event', message: '已拉黑该群，不再接收它的消息' });
      return;
    }
    acc.blockedGroups = acc.blockedGroups.filter(x => x !== g.id);
    saveAccounts();
    send(c, { t: 'contact_event', message: '已解除拉黑该群' });
    return;
  }

  if (d.t === 'contact_remove') {
    const n = Number(d.uid);
    const acc = c.account && ensureFriendFields(accounts[c.account]);
    if (!acc) return;
    acc.friends = acc.friends.filter(x => x !== n);
    const other = accountByUid(n);
    if (other) { ensureFriendFields(other); other.friends = other.friends.filter(x => x !== acc.uid); }
    saveAccounts();
    send(c, contactsPayload(acc));
    if (other) pushToAccount(other.uid, contactsPayload(other));
    return;
  }

  if (d.t === 'avatar_set') {
    const acc = c.account && ensureFriendFields(accounts[c.account]);
    if (!acc) { send(c, { t: 'error', message: '请先登录' }); return; }
    const parsed = parseImage(d);
    if (!parsed) { send(c, { t: 'error', message: '头像图片读不出' }); return; }
    if (parsed.tooBig) { send(c, { t: 'error', message: '头像太大' }); return; }
    const p2 = saveImage(parsed.data, parsed.ext);
    acc.avatar = p2;
    saveAccounts();
    send(c, { t: 'avatar_ok', avatar: p2 });
    const ev = { t: 'avatar', user: acc.user, nick: acc.nick || acc.user, uid: acc.uid, avatar: p2 };
    for (const cl of clients) send(cl, ev);
    return;
  }

  if (d.t === 'version_check') {
    loadVersionInfo();
    const code = Number(d.code) || 0;
    send(c, {
      t: 'version_info',
      code: versionInfo.code,
      name: versionInfo.name,
      notes: versionInfo.notes || '',
      url: versionInfo.url || ('http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT + '/download/apk'),
      size: versionInfo.size || 0,
      needUpdate: code > 0 && versionInfo.code > code
    });
    return;
  }

  if (d.t === 'ping') send(c, { t: 'pong', ts: now() });
}

/* ------------------------- 静态文件（用浏览器也能聊） ------------------------- */
function wwwRoot() {
  const local = path.join(__dirname, 'www');
  if (fs.existsSync(local)) return local;
  const inRepo = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
  if (fs.existsSync(inRepo)) return inRepo;
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = (() => {
  const reqHandler = (req, res) => {
    const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    // 版本信息：客户端检查更新用
    if (u.pathname === '/version') {
      loadVersionInfo();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(versionInfo));
      return;
    }
    // 安装包下载
    if (u.pathname === '/download/apk' || u.pathname.indexOf('/download/') === 0) {
      const f = path.join(APK_DIR, 'zhiyuan.apk');
      fs.stat(f, (err, st) => {
        if (err) { res.writeHead(404); res.end('no apk'); return; }
        res.writeHead(200, {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Length': st.size,
          'Content-Disposition': 'attachment; filename="zhiyuan-' + versionInfo.name + '.apk"',
          'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(f).pipe(res);
      });
      return;
    }
    if (u.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, clients: clients.size, rooms: roomList() }));
      return;
    }
    // 文件下载（带原始文件名）
    if (u.pathname.indexOf('/file/') === 0) {
      const name = u.pathname.slice(6);
      if (!/^[a-f0-9]{16}\.\w{1,8}$/.test(name)) { res.writeHead(400); res.end('bad'); return; }
      const disp = u.searchParams.get('name') || name;
      const forceDl = u.searchParams.get('dl') === '1';
      const ext = name.split('.').pop().toLowerCase();
      const mime = EXT_MIME[ext] || 'application/octet-stream';
      const isAudio = mime.indexOf('audio/') === 0;
      fs.readFile(path.join(FILE_DIR, name), (err, data) => {
        if (err) { res.writeHead(404); res.end('404'); return; }
        const headers = {
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Accept-Ranges': 'bytes'
        };
        if (!isAudio || forceDl) {
          headers['Content-Disposition'] = 'attachment; filename="' + encodeURIComponent(disp).replace(/"/g, '') + '"';
        }
        if (isAudio) {
          res.writeHead(200, headers);
          res.end(data);
          return;
        }
        res.writeHead(200, headers);
        res.end(data);
      });
      return;
    }
    // 图片资源
    if (u.pathname.indexOf('/img/') === 0) {
      const name = u.pathname.slice(5);
      if (!/^[a-f0-9]{16}\.(jpg|png|webp|gif)$/.test(name)) { res.writeHead(400); res.end('bad'); return; }
      const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[name.split('.').pop()];
      fs.readFile(path.join(IMG_DIR, name), (err, data) => {
        if (err) { res.writeHead(404); res.end('404'); return; }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' });
        res.end(data);
      });
      return;
    }
    const root = wwwRoot();
    if (!root) { res.writeHead(404); res.end('no www'); return; }
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.join(root, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(root)) { res.writeHead(403); res.end('no'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  };

  // 有证书就走 HTTPS（wss://），没有就走 HTTP（ws://）
  const CERT = process.env.CERT, KEY = process.env.KEY;
  if (CERT && KEY) {
    return require('https').createServer(
      { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, reqHandler);
  }
  return http.createServer(reqHandler);
})();

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  onConnection(socket);
});

// 游戏阶段推进：每秒检查一次超时
setInterval(() => {
  if (!wwGame) return;
  try { wwGame.tick(wwApi()); } catch (e) { }
}, 1000).unref();

// 心跳：30 秒 ping 一次，回不来就断开
setInterval(() => {
  for (const c of clients) {
    writeFrame(c.socket, 0x9, Buffer.from('hb'));
  }
}, 30000).unref();

rebuildUidIndex();
server.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const ips = [];
  for (const k of Object.keys(nets)) {
    for (const ni of nets[k] || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  const secure = !!(process.env.CERT && process.env.KEY);
  const scheme = secure ? 'https' : 'http';
  const wsScheme = secure ? 'wss' : 'ws';
  console.log('纸鸢服务端已启动' + (secure ? '（HTTPS / wss 加密）' : '（HTTP / ws 明文）'));
  console.log('  本机浏览器：' + scheme + '://localhost:' + PORT);
  ips.forEach(ip => console.log('  手机里填：  ' + wsScheme + '://' + ip + ':' + PORT));
  if (!ips.length) console.log('  （没检测到局域网 IP，检查是否连了 WiFi）');
  if (!secure) console.log('  提示：放到公网请配 CERT/KEY 用 wss://，见 部署说明.md');
});
