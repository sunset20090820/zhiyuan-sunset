'use strict';
/**
 * 狼人杀 · 板子（模式）
 * 板子 = 固定人数 + 固定角色组合。客户端只能选 id，自定义板子必须过 validateBoard。
 */
const { ROLES } = require('./roles');

const DEFAULT_OPTS = {
  witchSelfSave: 'first',   // none | first | always
  witchSameNight: false,    // 女巫同夜能否双药
  sheriff: false,
  hunterShoot: true,
  speechTime: 45,
  voteMode: 'public',       // public | secret
  revealOnDeath: false,
  winMode: 'side',          // side(屠边) | city(屠城)
};

const BOARDS = [
  { id: 'ww6',  name: '6 人标准局',    size: 6,  roles: { wolf: 2, seer: 1, witch: 1, villager: 2 }, desc: '新手板，节奏快' },
  { id: 'ww8',  name: '8 人预女猎',    size: 8,  roles: { wolf: 2, seer: 1, witch: 1, hunter: 1, villager: 3 }, desc: '最常见的入门板' },
  { id: 'ww9',  name: '9 人预女猎白',  size: 9,  roles: { wolf: 3, seer: 1, witch: 1, hunter: 1, fool: 1, villager: 2 }, desc: '经典 9 人板' },
  { id: 'ww9g', name: '9 人守卫局',    size: 9,  roles: { wolf: 3, seer: 1, witch: 1, guard: 1, hunter: 1, villager: 2 }, desc: '带守卫，考验夜里配合' },
  { id: 'ww10', name: '10 人预女猎白', size: 10, roles: { wolf: 3, seer: 1, witch: 1, hunter: 1, fool: 1, villager: 3 }, desc: '抗推空间大' },
  { id: 'ww12', name: '12 人标准 4 狼',size: 12, roles: { wolf: 4, seer: 1, witch: 1, hunter: 1, fool: 1, villager: 4 }, desc: '高配，节奏快' },
  { id: 'ww12w', name: '12 人狼王守卫',size: 12, roles: { wolf: 3, wolfking: 1, seer: 1, witch: 1, guard: 1, hunter: 1, villager: 4 }, desc: '狼王 + 守卫' },
  { id: 'ww12b', name: '12 人狼美人局',size: 12, roles: { wolf: 3, wolfbeauty: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 }, desc: '狼美人魅惑，情侣殉情' },
  { id: 'ww10k', name: '10 人骑士局',  size: 10, roles: { wolf: 3, seer: 1, witch: 1, knight: 1, hunter: 1, villager: 3 }, desc: '骑士决斗' },
  { id: 'ww12c', name: '12 人丘比特',  size: 12, roles: { wolf: 4, cupid: 1, seer: 1, witch: 1, hunter: 1, villager: 4 }, desc: '首夜连线情侣' },
];

const ROLE_KEYS = Object.keys(ROLES);

/** 校验板子；返回 '' 表示合法，否则返回中文原因 */
function validateBoard(size, roles, opts) {
  const n = ROLE_KEYS.reduce((a, k) => a + Number((roles && roles[k]) || 0), 0);
  if (!Number.isInteger(size) || size < 4 || size > 18) return '人数需要 4–18';
  if (n !== size) return `角色总数 ${n} 与人数 ${size} 不一致`;
  if (!roles.wolf && !roles.wolfking && !roles.wolfbeauty) return '至少要有一个狼人';
  const wolves = (roles.wolf || 0) + (roles.wolfking || 0) + (roles.wolfbeauty || 0);
  const good = size - wolves;
  if (good < wolves) return '好人不能少于狼人';
  if (!(roles.seer || roles.witch || roles.hunter || roles.fool || roles.guard || roles.knight || roles.cupid)) return '至少要有一个神职';
  for (const k of ['seer', 'witch', 'hunter', 'fool', 'guard', 'knight', 'cupid', 'wolfking', 'wolfbeauty']) {
    if (Number(roles[k] || 0) > 1) return `${ROLES[k].name} 最多一个`;
  }
  if (opts && opts.speechTime != null && (opts.speechTime < 15 || opts.speechTime > 180)) return '发言时长 15–180 秒';
  return '';
}

function getBoard(id) {
  return BOARDS.find(b => b.id === id) || null;
}

/** 合并选项（只接受白名单字段） */
function mergeOpts(opts) {
  const out = Object.assign({}, DEFAULT_OPTS);
  if (!opts || typeof opts !== 'object') return out;
  if (['none', 'first', 'always'].includes(opts.witchSelfSave)) out.witchSelfSave = opts.witchSelfSave;
  if (typeof opts.witchSameNight === 'boolean') out.witchSameNight = opts.witchSameNight;
  if (typeof opts.sheriff === 'boolean') out.sheriff = opts.sheriff;
  if (typeof opts.hunterShoot === 'boolean') out.hunterShoot = opts.hunterShoot;
  if (Number.isFinite(opts.speechTime)) out.speechTime = Math.max(15, Math.min(180, Math.round(opts.speechTime)));
  if (['public', 'secret'].includes(opts.voteMode)) out.voteMode = opts.voteMode;
  if (typeof opts.revealOnDeath === 'boolean') out.revealOnDeath = opts.revealOnDeath;
  if (['side', 'city'].includes(opts.winMode)) out.winMode = opts.winMode;
  return out;
}

module.exports = { BOARDS, DEFAULT_OPTS, ROLE_KEYS, validateBoard, getBoard, mergeOpts };
