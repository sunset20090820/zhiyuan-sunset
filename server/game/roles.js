'use strict';
/**
 * 狼人杀 · 角色库
 * 每个角色只声明：阵营、夜间顺序与行动、出局时触发、私密信息类型。
 * 板子只是「角色 + 数量」组合，新增板子不需要改引擎。
 */
const ROLES = {
  wolf: {
    name: '狼人', camp: 'wolf', team: true,
    night: { order: 10, action: 'kill' },
    desc: '夜晚与狼队友共同选择一人击杀',
  },
  wolfking: {
    name: '狼王', camp: 'wolf', team: true,
    night: { order: 10, action: 'kill' },
    onDeath: 'shoot', notOnPoison: true,
    desc: '狼人；出局时可开枪带走一人（被毒不能）',
  },
  wolfbeauty: {
    name: '狼美人', camp: 'wolf', team: true,
    night: { order: 11, action: 'charm' },
    desc: '狼人；每晚魅惑一人，自己出局时对方殉情',
  },
  seer: {
    name: '预言家', camp: 'good',
    night: { order: 20, action: 'check' }, priv: 'check_result',
    desc: '夜晚查验一人身份',
  },
  witch: {
    name: '女巫', camp: 'good',
    night: { order: 30, action: 'witch' }, priv: 'witch_info',
    desc: '解药与毒药各一瓶',
  },
  guard: {
    name: '守卫', camp: 'good',
    night: { order: 15, action: 'guard' }, priv: 'guard_info',
    desc: '每晚守护一人，不能连守；同守同救该人死亡',
  },
  hunter: {
    name: '猎人', camp: 'good', onDeath: 'shoot', notOnPoison: true,
    desc: '被刀或被票出可开枪（被毒不能）',
  },
  fool: {
    name: '白痴', camp: 'good', onVoteOut: 'flip',
    desc: '被票出翻牌不死，但失去投票权',
  },
  knight: {
    name: '骑士', camp: 'good', day: { action: 'duel' },
    desc: '白天可决斗一人：对方是狼则狼死，否则骑士死',
  },
  cupid: {
    name: '丘比特', camp: 'good',
    night: { order: 5, action: 'link', firstNightOnly: true }, priv: 'lover_info',
    desc: '首夜连接两人为情侣',
  },
  villager: {
    name: '平民', camp: 'good',
    desc: '无技能，靠发言与投票',
  },
};

const CAMP_OF = (role) => (ROLES[role] && ROLES[role].camp) || 'good';
const isGod = (role) => !!(ROLES[role] && ROLES[role].camp === 'good' && role !== 'villager');
const isWolf = (role) => CAMP_OF(role) === 'wolf';

module.exports = { ROLES, CAMP_OF, isGod, isWolf };
