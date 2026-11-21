# 狼人杀（内置游戏）设计方案

> 目标：在纸鸢里内置一个能多人玩的狼人杀，复用现有账号、好友和 WebSocket 通道，
> 不改动聊天逻辑，游戏数据与聊天房间隔离。

---

## 1. 范围

### 第一版（MVP）

- 人数 6–12 人，房主开局；不足 6 人不允许开始
- 角色：狼人 ×2、预言家、女巫、平民 ×N（按人数自动配比）
- 流程：等待 → 夜晚 → 天亮公布 → 依次发言（文字）→ 投票放逐 → 循环 → 结算
- 胜负：屠边（狼人杀光神职或杀光平民）或好人放逐全部狼人
- 私密信息只通过单发通道给对应玩家：狼队友、验人结果、女巫用药结果、被刀目标
- 掉线保留座位 60 秒，超时视为弃票/放弃行动；房主掉线自动转移

### 后续迭代

警长竞选、猎人开枪、白痴翻牌、发言计时、语音发言、观战、战绩与统计、自定义板子。

---

## 2. 角色与规则

| 角色 | 阵营 | 实现批次 | 技能 |
|---|---|---|---|
| 狼人 | 狼 | 首批 | 夜晚集体选择一人击杀；知道彼此身份 |
| 狼王 | 狼 | 首批 | 狼人；出局时可开枪带走一人（被毒不能） |
| 狼美人 | 狼 | 第二批 | 狼人；每晚可魅惑一人，自己出局时对方殉情 |
| 预言家 | 神 | 首批 | 夜晚查验一人，得知「好人 / 狼人」 |
| 女巫 | 神 | 首批 | 解药一瓶（救当晚死者）、毒药一瓶（毒杀一人），同一晚只能用药一次 |
| 猎人 | 神 | 首批 | 被狼刀或投票出局时可开枪带走一人（被女巫毒死不能开枪，可配） |
| 白痴 | 神 | 首批 | 被投票出局时翻牌，不死但失去投票权，之后被刀/被毒才真正出局 |
| 守卫 | 神 | 首批 | 每晚守护一人，不能连守；同守同救该人死亡 |
| 骑士 | 神 | 第二批 | 白天可决斗一名玩家：对方是狼则狼死，否则骑士死 |
| 丘比特 | 神 | 第二批 | 首夜连接两人为情侣（可能跨阵营） |
| 平民 | 神 | 首批 | 无技能，白天投票 |

### 角色库（与板子解耦）

引擎按**角色库**实现，每个角色是一个独立插件式定义；板子只是「角色 + 数量」的组合表。
新增板子 = 在表里加一行，不改引擎代码。

```js
// server/game/roles.js —— 每个角色只声明它在哪些阶段、能做什么
const ROLES = {
  wolf:     { camp:'wolf', night:{ order:10, action:'kill' }, team:true },
  wolfking: { camp:'wolf', night:{ order:10, action:'kill' }, team:true, onDeath:'shoot' },
  seer:     { camp:'good', night:{ order:20, action:'check' }, priv:'check_result' },
  witch:    { camp:'good', night:{ order:30, action:'witch' }, priv:'witch_info' },
  guard:    { camp:'good', night:{ order:15, action:'guard' }, priv:'guard_info' },
  hunter:   { camp:'good', onDeath:'shoot' },
  fool:     { camp:'good', onVoteOut:'flip' },
  knight:   { camp:'good', day:{ action:'duel' } },
  cupid:    { camp:'good', night:{ order:5, action:'link', firstNightOnly:true } },
  villager: { camp:'good' },
};
```

**为什么先做角色库而不是先堆板子**：板子数量会一直长，但角色种类有限。
把技能、阶段、私密信息都挂到角色定义上，后面新增板子只填数字，不需要再动状态机和协议。

**首批实现全部角色**（含第二批的狼美人、骑士、丘比特），板子先开放 6/8/9/10/12 六种，
其余板子后续只加配置。这样「后面还能新增其他板子」是确定的，而不是留个坑。

### 板子（模式）

板子是「固定人数 + 固定角色组合」的配板表，开局前由房主选择。
不做「按人数自动猜板子」——人数与板子必须严格匹配，否则角色数量会对不上。

| 板子 | 人数 | 狼 | 预言家 | 女巫 | 猎人 | 白痴 | 平民 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 6 人标准局 | 6 | 2 | 1 | 1 | 0 | 0 | 2 | 新手板，无猎人 |
| 8 人预女猎 | 8 | 2 | 1 | 1 | 1 | 0 | 3 | 最常见的入门板 |
| 9 人预女猎白 | 9 | 3 | 1 | 1 | 1 | 1 | 2 | 经典 9 人板 |
| 10 人预女猎白 | 10 | 3 | 1 | 1 | 1 | 1 | 3 | 抗推空间大 |
| 12 人标准 4 狼 | 12 | 4 | 1 | 1 | 1 | 1 | 4 | 高配，节奏快 |
| 12 人狼王守卫 | 12 | 4 | 1 | 1 | 1（猎人） | 1（白痴） | 4 | 含守卫，见下 |
| 自定义 | 4–18 | 任意 | 任意 | 任意 | 任意 | 任意 | 任意 | 房主逐项调，需满足校验规则 |

**板子校验规则**（服务端强制，客户端也提示）

1. 狼人 ≥ 1，好人总数 ≥ 狼人数
2. 神职数量 ≥ 1（否则首夜无人可验）
3. 总人数 = 狼 + 神 + 民，且与所选的「人数」一致
4. 任何板子下：预言家 ≤ 1、女巫 ≤ 1、猎人 ≤ 1、白痴 ≤ 1、守卫 ≤ 1
5. 人数区间：4 ≤ 人数 ≤ 18（MVP 客户端只开放 6–12，超出走自定义）
6. 女巫解药只允许首夜自救（板子可关掉这条，见「板子选项」）

### 板子选项（可调开关）

| 选项 | 默认 | 说明 |
|---|---|---|
| `witchSelfSave` | 仅首夜 | 女巫能否用解药救自己（`none` / `first` / `always`） |
| `witchSameNight` | false | 女巫同一晚能否同时用解药和毒药 |
| `sheriff` | false | 是否启用警长竞选 |
| `hunterShoot` | true | 猎人被刀/被毒能否开枪（被毒默认不能） |
| `speechTime` | 45 | 每人发言秒数，30–120 |
| `voteMode` | 公开 | 投票是否公开（公开 / 匿名） |
| `revealOnDeath` | false | 出局是否公开身份 |

板子的配置在服务端只认一份白名单，客户端传来的板子名/配置必须能通过同一个校验函数，
避免「客户端改板子 → 服务端按错误人数发牌」。

### 阵营判定

| 板子类型 | 胜负条件 |
|---|---|
| 屠边（默认） | 狼人杀光全部神职，或杀光全部平民 → 狼胜 |
| 屠城（可选） | 狼人数 ≥ 存活人数的 1/3（或板子自定义比例）→ 狼胜 |
| 好人 | 放逐全部狼人 → 好人胜 |

**夜晚结算顺序**（关键，避免争议）

1. 狼人投票刀人（多人分歧时随机取一票，平票随机）
2. 预言家查验
3. 女巫行动（看到当晚被刀的人；可用解药/毒药/不用）
4. 汇总死亡：被刀且未被救 + 被毒

**白天**

1. 公布死讯（不公布死因）
2. 从死亡者下一位开始依次发言，每人一次
3. 投票：可投在场任意玩家或弃票；得票最多者出局，平票则本轮无人出局
4. 结算胜负

**胜负判定**（每晚/每次放逐后都判定，先判狼胜）

- 狼人数 = 0 → 好人胜
- 狼人数 ≥ 剩余存活的一半（屠城）或神职全灭、或平民全灭（屠边）→ 狼胜

---

## 3. 状态机

```
waiting ──start（≥6人）──> night ──全部行动/超时──> dawn
   ↑                                                   │
   └──────────── 房主解散/全部离开 ── settlement ←──────┘
                                          │
                                    speech ──全部发言/超时──> vote
                                        ↑                    │
                                        └──── 未分胜负 ───────┘
```

每个阶段都有截止时间（服务端计时，避免卡死）：

| 阶段 | 超时 |
|---|---|
| night | 60 s（所有人行动完提前结束） |
| speech | 每人 45 s |
| vote | 30 s |

---

## 4. 数据模型（服务端，内存）

```js
Game = {
  id: 'ww_xxx',              // 游戏 ID
  hostUid: 100001,           // 房主账号 uid
  state: 'waiting',          // waiting|night|dawn|speech|vote|settlement
  round: 1,
  board: 'ww8',              // 板子 ID
  boardName: '8 人预女猎',
  size: 8,
  opts: { witchSelfSave:'first', witchSameNight:false, sheriff:false, hunterShoot:true, speechTime:45, voteMode:'public', revealOnDeath:false },
  players: [{
    uid: 100001,             // 账号 uid（未登录游客用 deviceId 代替）
    key: 'uid:100001',       // 统一身份键
    name: '南哲北笛',
    seat: 1,                 // 座位号，1 起
    role: 'wolf',            // wolf|seer|witch|villager
    alive: true,
    connected: true,
    offlineAt: 0,            // 掉线时间，用于 60 s 判定
    deadReason: '',          // killed|poisoned|voted|quit
  }],
  night: {
    wolfTarget: null,        // 狼刀目标 key
    wolfVotes: {},           // { voterKey: targetKey }
    seerTarget: null,
    seerResult: null,        // 'wolf'|'good'
    witchSave: false,
    witchPoison: null,
    acted: {},               // 已行动玩家，加快提前结算
  },
  votes: {},                 // { voterKey: targetKey|'skip' }
  speechOrder: [],           // 发言顺序的 key 数组
  speechIndex: 0,
  deadline: 0,               // 当前阶段截止时间戳
  log: [],                   // 公开事件流，供回放
}
```

**持久化**：游戏态只放内存（进程重启即丢弃），与聊天历史分离，避免污染 `data/dm`。
如需「战绩」再单独落 `data/games.json`，第一版不做。

---

## 5. 通信协议

所有消息走现有 WebSocket，统一前缀 `ww_`。服务端按「谁能看见」分三个投递级别：

| 级别 | 说明 |
|---|---|
| `toGame` | 发给该游戏全部玩家（含观众位，第一版无观众） |
| `toPlayer` | 只发给某位玩家（私密：身份、验人、狼队友） |
| `toAll` | 大厅广播（游戏列表变化） |

### 5.1 大厅

| 方向 | 消息 | 说明 |
|---|---|---|
| C→S | `{t:'ww_list'}` | 拉游戏列表 |
| S→C | `{t:'ww_rooms', rooms:[{id,host,hostName,players,max,state,board,boardName,opts}]}` | 列表（带板子，方便筛选） |
| S→C | `{t:'ww_rooms_changed'}` | 有房间增减/状态变化（触发客户端刷新） |

### 5.2 房间

| 方向 | 消息 | 说明 |
|---|---|---|
| C→S | `{t:'ww_create', board:'ww8', name?, opts?}` | 创建，`board` 为板子 ID 或 `custom`（需带 `size`/`roles`），创建者自动入座 1 号 |
| C→S | `{t:'ww_boards'}` | 拉可取板子列表与默认选项 |
| S→C | `{t:'ww_boards', boards:[{id,name,size,roles,opts,desc}]}` | 板子清单（客户端做「模式选择」用） |
| C→S | `{t:'ww_join', id}` | 加入，分配最小空座 |
| C→S | `{t:'ww_leave', id}` | 离开（游戏中视为死亡退出） |
| C→S | `{t:'ww_kick', id, seat}` | 房主踢人（仅 waiting） |
| C→S | `{t:'ww_start', id}` | 房主开局，校验人数与在线 |
| S→C | `{t:'ww_room', game:{id,board,boardName,size,opts,state,players}, you:{seat,role,alive}}` | 进房同步（`role` 只给自己） |
| S→C | `{t:'ww_players', players:[...]}` | 座位/存活/在线变化 |

**公开字段**：座位、昵称、是否存活、是否在线、房主。**绝不下发**他人角色。

### 5.3 夜晚

| 方向 | 消息 | 说明 |
|---|---|---|
| S→C | `{t:'ww_night', round, deadline, you:{role, targets:[...]}}` | 天黑，附自己可操作的目标列表 |
| S→C | `{t:'ww_wolves', mates:[{seat,name}]}` | 仅狼人：队友名单 |
| C→S | `{t:'ww_action', kind:'kill'|'check'|'save'|'poison'|'none', target}` | 夜晚行动 |
| S→C | `{t:'ww_check_result', target, result:'wolf'|'good'}` | 仅预言家 |
| S→C | `{t:'ww_witch_info', killed, canSave, canPoison, canSelfSave}` | 仅女巫 |
| S→C | `{t:'ww_guard_info', lastGuard}` | 仅守卫：上一晚守了谁（不能连守） |
| C→S | `{t:'ww_action', kind:'guard', target}` | 守卫守护 |
| S→C | `{t:'ww_hunter', canShoot:true, deadline}` | 猎人出局，可开枪（超时视为放弃） |
| C→S | `{t:'ww_shoot', target}` | 猎人开枪 |
| S→C | `{t:'ww_action_ack', kind, target}` | 行动确认（回显，防误触） |
| S→C | `{t:'ww_night_end'}` | 夜晚结束，进入天亮 |

**防作弊**：夜晚行动一律服务端校验「你是不是这个角色 / 是否还活着 / 是否本阶段 / 目标是否合法」，客户端传来的 `role` 一律忽略。

### 5.4 白天

| 方向 | 消息 | 说明 |
|---|---|---|
| S→C | `{t:'ww_dawn', round, deaths:[{seat,name,reason}], deadline}` | 天亮公布死讯 |
| S→C | `{t:'ww_speech', seat, name, deadline}` | 当前发言者 |
| C→S | `{t:'ww_say', text}` | 发言内容（限 500 字） |
| S→C | `{t:'ww_said', seat, name, text}` | 广播发言 |
| S→C | `{t:'ww_vote_start', candidates:[...], deadline}` | 进入投票 |
| C→S | `{t:'ww_vote', target:seat|'skip'}` | 投票（可改票，截止前有效） |
| S→C | `{t:'ww_vote_result', tally:[{seat,votes}], out:seat|null}` | 投票结果 |
| S→C | `{t:'ww_over', winner:'wolf'|'good', reveal:[{seat,role}]}` | 结算，公开所有身份 |

### 5.5 系统

| 方向 | 消息 | 说明 |
|---|---|---|
| S→C | `{t:'ww_error', message}` | 操作不合法（非本阶段、越权、目标非法等） |
| S→C | `{t:'ww_player_conn', seat, connected}` | 掉线/重连通知（延时缓冲用） |

---

## 6. 客户端界面

新增一个全屏页面 `#gamePage`，与聊天页同级，入口放在「新建对话」面板里加一行「🎮 狼人杀」。

| 界面 | 内容 |
|---|---|
| 游戏入口 | 「新建对话」面板里的「🎮 狼人杀」，进入大厅 |
| 大厅 | 房间列表（房主、人数、**板子名**、状态）、「创建房间」「快速加入」、刷新 |
| 创建房间 | **模式选择**：板子卡片列表（6人标准局 / 8人预女猎 / 9人预女猎白 / 10人 / 12人标准 / 12人狼王守卫 / 自定义），选中后显示角色配比预览 + 选项开关（女巫自救、同守同救、警长、发言时长、投票公开性）；自定义板子用加减按钮配角色 |
| 加入房间 | 若房间板子人数已满则按钮置灰；板子不符时提示 |
| 等待厅 | 座位九宫格、房主标记、邀请好友按钮（复用联系人列表）、开始按钮（仅房主） |
| 夜晚 | 自己的角色卡、可点选的目标头像；狼人显示队友；预言家显示上次验人结果；女巫显示「今晚 X 号被刀」+ 解药/毒药按钮 |
| 天亮 | 死讯动画、昨晚结果（不显示死因） |
| 发言 | 当前发言者高亮、输入框「发言」（仅轮到自己可输入）、其他人只读 |
| 投票 | 存活者头像可点、弃票按钮、实时票数（可选：截止后公布） |
| 结算 | 胜负横幅、身份全公开、再来一局/退出 |

**视角差异**：同一页面按 `you.role` 渲染不同面板，服务端不下发的信息客户端根本拿不到，因此界面无法「看穿」身份。

---

## 7. 与现有系统的集成

| 位置 | 改动 |
|---|---|
| `server/game/werewolf.js`（新增） | 游戏引擎：`create/join/start/action/vote/tick` + 状态机 + 广播 |
| `server.js` | 顶部 `require('./game/werewolf')`；在消息分发处加 `if (d.t.startsWith('ww_')) return ww.handle(c, d);`；`setInterval` 里加 `ww.tick()`（每秒检查超时，与现有心跳并行） |
| `client/app/game.js`（新增） | 页面渲染与交互，暴露 `WW.open()/close()` |
| `client/app/index.html` | 加 `<section id="gamePage">` 与 `<script src="game.js">` |
| `client/app/app.js` | `onServer` 里加 `ww_*` 分支转发到 `WW.onMessage`；`openDmSheet` 加「狼人杀」入口 |
| `client/app/style-v48.css` | 游戏页样式（复用现有变量与 `.action-*` 组件） |

**隔离性**：游戏不使用 `history`/`data/dm`，不占用房间 ID，不影响未读、免打扰和通知逻辑（游戏内消息不触发系统通知）。

---

## 7.5 游戏模块独立安装 / 卸载

游戏做成**可选资源模块**，不随 APK 内置：

| 状态 | 表现 |
|---|---|
| 未安装 | 「新建对话」里有「🎮 狼人杀」入口，点进去是说明页 + 「下载 (x MB)」按钮 |
| 安装中 | 进度条 + 可取消 |
| 已安装 | 正常进入大厅 |
| 已卸载 | 回到未安装状态，入口保留（方便再装） |

### 为什么这样拆

- 主包体积不涨（游戏引擎 + 界面约 150–200 KB）
- 不想玩的人不占空间
- 游戏可以独立更新，不用整包发版

### 存储与加载

```
/data/data/app.paperlite.chat/files/modules/
  werewolf/
    module.json      { id, name, version, size, files:[...], hash }
    game.js          客户端游戏逻辑
    werewolf.js      服务端引擎（下发到自建服务器时用）
```

- 客户端启动时检查 `modules/werewolf/module.json` 是否存在 → 决定入口显示「下载」还是「进入」
- 已安装则用 `<script>` 动态注入 `game.js`（`document.createElement('script')`，走本地文件路径，不联网）
- 卸载 = 删除整个 `modules/werewolf/` 目录 + 清理 `localStorage` 里的游戏缓存

### 下载来源

| 来源 | 说明 |
|---|---|
| 官方服务器 | `GET /modules/werewolf/module.json` + `GET /modules/werewolf/game.js` |
| 自建服务器 | 自建服务器目录下放同样的文件即可；客户端按当前服务器地址取 |
| 校验 | 下载后比对 `sha256`，不一致则丢弃并提示重试 |

协议沿用现有 HTTP 通道，服务端加两条静态路由即可（`/modules/...`），不需要 WebSocket 消息。

### 设置 → 资源管理

现有「存储管理」页面扩展为「资源管理」，列出：

| 项目 | 显示 | 操作 |
|---|---|---|
| 聊天记录 | 各会话占用 | 清理单个会话 / 全部 |
| 表情收藏 | 数量与占用 | 清空 |
| 游戏模块 · 狼人杀 | 版本 + 占用（如 `v1.0 · 186 KB`） | **删除**（二次确认） |

**删除的确切语义**：只删除客户端已下载的模块资源（`files/modules/werewolf/` 整个目录 + 本地游戏缓存），
数据可随时重新下载回来；不保留战绩、不做云端备份。删除后入口显示「未安装 · 下载」，
聊天数据、账号、图片等与游戏无关的内容一律不动。
| 本机缓存 | 大小 | 清理缓存 |

删除按钮点击 → 确认弹窗「删除后需要重新下载，游戏数据（战绩）也会清空」→ 删除并刷新页面状态。

### 服务端配合

- `server.js` 启动时若 `modules/werewolf/werewolf.js` 存在则 `require`，不存在就跳过（`ww_*` 消息回 `ww_error: 服务器未安装游戏模块`）
- 这样别人自建服务器也可以选择装不装游戏，与客户端解耦

### 与主包的关系

| 内容 | 位置 |
|---|---|
| 游戏入口占位页、下载器、资源管理项 | 主包（客户端） |
| 游戏界面与逻辑 `game.js` | 模块，可下载 |
| 游戏引擎 `werewolf.js` | 服务端模块，可选安装 |

---

## 8. 边界与异常

| 场景 | 处理 |
|---|---|
| 游戏中掉线 | 保留座位，60 s 内重连可恢复；超时白天视为弃票，夜晚视为不行动 |
| 房主退出（等待中） | 转移给下一位在线玩家；无人则销毁房间 |
| 房主退出（游戏中） | 游戏继续，房主标记转移，不影响流程 |
| 全部玩家离开 | 销毁房间并清理定时器 |
| 重复行动 | 同一阶段同一玩家只认第一次，后续回 `ww_action_ack` 但不改结果（女巫明确允许改一次） |
| 阶段超时 | 服务端强制推进，未行动者按「不行动/弃票」处理 |
| 恶意刷消息 | 沿用现有每秒 8 条限流 |
| 进程重启 | 游戏全部丢弃（第一版接受），客户端重连后收到 `ww_room` 不存在 → 回大厅 |
| 撞角/越权 | 所有 `ww_action`/`ww_vote` 由服务端按角色与阶段校验，非法直接 `ww_error` |

---

## 9. 测试计划

**引擎单测（node 脚本直接调引擎，不开 socket）**
1. 板子配比：6–12 人各角色数量正确
2. 夜晚结算：狼刀+女巫救人 → 无人死；狼刀+女巫毒人 → 死两人；女巫救自己仅首夜
3. 胜负判定：狼全灭 / 神职全灭 / 平民全灭 / 狼数过半
4. 平票不出局；弃票不计入
5. 越权：平民发 `kill`、死人发 `vote` 均被拒

**协议联调（多连接模拟）**
6. 6 个连接加入 → 开局 → 每人收到正确角色，互不可见
7. 夜晚全员行动 → 天亮死讯正确
8. 掉线 60 s 后超时推进

**界面（无头浏览器）**
9. 各角色夜晚面板差异
10. 投票页只能点存活玩家
11. 结算页身份公开正确

---

## 10. 工作量拆分

| 阶段 | 内容 | 预估 |
|---|---|---|
| M0 | 角色库 `roles.js`（10 个角色定义）+ 板子表 + 校验函数 | 50 min |
| M0b | 客户端模式选择页（板子卡片 + 选项 + 自定义编辑器） | 40 min |
| M1 | 引擎骨架 + 发牌 + 等待厅（按板子显示座位数） | 40 min |
| M2 | 夜晚行动（狼/预言家/女巫）+ 结算 + 天亮 | 50 min |
| M3 | 发言轮转 + 投票 + 放逐 + 胜负 | 40 min |
| M4 | 客户端四类界面 + 视角差异 | 60 min |
| M5 | 掉线/超时/房主转移等边界 | 30 min |
| M6 | 联调 + 无头测试 + 打包上线 | 30 min |

| M7 | 猎人/白痴/守卫/狼王 技能与结算 | 70 min |
| M8 | 狼美人/骑士/丘比特 + 自定义板子编辑器 | 60 min |
| M9 | 模块化：打包 `game.js`/`werewolf.js`、下载器、资源管理删除、服务端可选加载 | 60 min |

**合计约 7–7.5 小时**，分三次交付：

1. **能玩**（约 3.5 h）：M0–M3 + M4，6/8 人板 + 首批角色，主包内置先跑通
2. **完整角色**（约 2 h）：M7–M8，全部 10 个角色 + 自定义板子
3. **模块化**（约 1.5 h）：M9，拆成可下载/可删除的独立模块

> 建议顺序：先按「内置」跑通（第 1、2 步），最后再拆模块（第 3 步）。
> 好处是前期联调不用处理下载/版本/校验，出问题范围小；拆模块只动加载与存储层。

---

## 11. 风险

| 风险 | 说明 | 应对 |
|---|---|---|
| 状态机复杂易卡死 | 阶段超时依赖定时器 | 统一 `tick()` 驱动，任何阶段都有 deadline |
| 信息泄露 | 角色发错人等于游戏毁了 | 只走 `toPlayer`，且服务端永不把 role 放进广播 |
| 手机上操作繁琐 | 小屏点选目标 | 目标用大号头像九宫格，单手可点 |
| 与聊天抢占屏幕 | 游戏期间来消息 | 游戏页内不弹通知，退出后统一提示未读 |
| 人数不足 | 冷启动没人玩 | 提供「人机陪练」作为后续项，第一版先不做 |

---

## 12. 已确定与仍待确认

**已按你的意见确定**

- 角色库一次做全（狼人、狼王、狼美人、预言家、女巫、猎人、白痴、守卫、骑士、丘比特、平民）
- 板子只是配置，后续新增板子不改代码
- 游戏作为可选模块：可单独下载、可在「设置 → 资源管理」单独删除

**仍需你确认两点**

1. **模块下载源**：只走「当前连接的服务器」（自建服务器自带模块文件），还是再加一个官方源兜底？
   建议：只走当前服务器，逻辑简单、离线环境也能用。
2. ~~删除时是否连战绩一起清~~ → **已确认**：删除客户端模块资源即可，可重新下载。

---

## 附录 A：板子配置结构（服务端白名单）

板子表是服务端唯一权威来源，客户端只能选 ID，不能篡改角色数量。

```js
// server/game/boards.js
const BOARDS = [
  { id:'ww6',  name:'6 人标准局',   size:6,  roles:{wolf:2,seer:1,witch:1,villager:2}, desc:'新手板，节奏快' },
  { id:'ww8',  name:'8 人预女猎',   size:8,  roles:{wolf:2,seer:1,witch:1,hunter:1,villager:3}, desc:'最常见的入门板' },
  { id:'ww9',  name:'9 人预女猎白', size:9,  roles:{wolf:3,seer:1,witch:1,hunter:1,fool:1,villager:2} },
  { id:'ww10', name:'10 人预女猎白',size:10, roles:{wolf:3,seer:1,witch:1,hunter:1,fool:1,villager:3} },
  { id:'ww12', name:'12 人标准 4 狼',size:12,roles:{wolf:4,seer:1,witch:1,hunter:1,fool:1,villager:4} },
  { id:'ww12g',name:'12 人狼王守卫',size:12,roles:{wolf:4,seer:1,witch:1,hunter:1,guard:1,fool:1,villager:3}, opts:{hunterShoot:'always'} },
];

const DEFAULT_OPTS = {
  witchSelfSave: 'first',   // none | first | always
  witchSameNight: false,    // 女巫同夜可否双药
  sheriff: false,           // 警长竞选
  hunterShoot: true,        // 猎人可开枪（被毒除外）
  speechTime: 45,
  voteMode: 'public',       // public | secret
  revealOnDeath: false,
};

// 板子合法性校验：客户端自定义板子、以及内置板子入库前都走这里
function validateBoard(size, roles, opts) {
  const n = ['wolf','seer','witch','hunter','fool','guard','villager']
    .reduce((a, k) => a + (roles[k] || 0), 0);
  if (size < 4 || size > 18) return '人数需要 4–18';
  if (n !== size) return `角色总数 ${n} 与人数 ${size} 不一致`;
  if (!roles.wolf) return '至少要有一个狼人';
  const good = size - (roles.wolf || 0);
  if (good < roles.wolf) return '好人不能少于狼人';
  if (!(roles.seer || roles.witch || roles.hunter || roles.fool || roles.guard)) return '至少要有一个神职';
  for (const k of ['seer','witch','hunter','fool','guard']) if ((roles[k] || 0) > 1) return `${k} 最多一个`;
  if (roles.guard && roles.guard > 1) return '守卫最多一个';
  if (opts && opts.speechTime != null && (opts.speechTime < 15 || opts.speechTime > 180)) return '发言时长 15–180 秒';
  return '';   // 空串 = 合法
}
```

## 附录 B：配板发牌算法

```js
function deal(game) {
  const pool = [];
  for (const [k, v] of Object.entries(game.boardRoles)) for (let i = 0; i < v; i++) pool.push(k);
  // Fisher–Yates 洗牌，避免座位与角色相关
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  game.players.forEach((p, i) => { p.role = pool[i]; });
}
```

发牌后立刻给每位玩家单独下发 `ww_room`（含 `you.role`），狼人额外收 `ww_wolves`。
广播里永不出现 `role` 字段。

## 附录 C：模式选择界面的数据结构（客户端）

```js
// 大厅点「创建房间」后拉取
{ t:'ww_boards', boards:[
  { id:'ww8', name:'8 人预女猎', size:8,
    roles:{wolf:2,seer:1,witch:1,hunter:1,villager:3},
    opts:{...DEFAULT_OPTS},
    desc:'最常见的入门板' }
]}
```

客户端渲染成卡片：板子名 + 人数 + 角色图标行（🐺×2 🔮×1 🧪×1 🏹×1 👤×3）+ 一句话说明。
选中后展开选项开关区；「自定义」卡片额外提供人数加减与角色加减，实时显示校验结果，
不合法时「创建」按钮置灰并给出原因（与服务端 `validateBoard` 文案保持一致）。
