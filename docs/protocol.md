# 协议说明

自定义协议：**JSON over WebSocket**。一个连接 = 一个设备；登录后绑定到账号（`uid`）。

## 连接与身份

```
ws://host:8080
```

未登录也能连（游客），可收发公共房间消息。登录/注册通过 `auth` 流程：

| 客户端 → 服务端 | 说明 |
|---|---|
| `{t:'register', user, pass, nick, question, answer}` | 注册（带密保问题） |
| `{t:'login', user, pass}` | 登录 |
| `{t:'resume', token, device}` | 用令牌恢复登录态 |
| `{t:'resetpass', user, answer, pass}` | 用密保重置密码 |
| `{t:'recover', answer}` | 按本机记录找回用户名 |

服务端统一回 `{t:'auth', ok, uid, token, ...}`；失败回 `{t:'auth', ok:false, err}`。

## 房间与消息

| 方向 | 消息 |
|---|---|
| C→S | `{t:'join', name, room, device}` 进房间 |
| S→C | `{t:'welcome'}`, `{t:'rooms'}`, `{t:'history'}`, `{t:'members'}`, `{t:'presence'}` |
| C→S | `{t:'msg', text, tempId, replyTo, mentions}` 发房间消息 |
| S→C | `{t:'msg', msg}` 广播 |

`msg` 结构：`{id, room, from, name, text, ts, deviceId, fromUid, image, file, replyTo, mentions}`。

撤回：`{t:'retract', id}`。

## 私聊（点对点）

| 方向 | 消息 |
|---|---|
| C→S | `{t:'pm_open', with}` 打开会话，回 `{t:'pm_history', room, peer, history}` |
| C→S | `{t:'pm', to, text, tempId, replyTo}` |
| S→C | `{t:'pm', msg, room, with}`；对方离线时 `{t:'pm_saved'}` |

会话键由双方身份排序拼接：`dm:<a>|<b>`，其中身份优先用 `uid:<数字>`，没有账号时用设备号。

## 好友与拉黑

`contact_search` / `contact_add` / `contact_accept` / `contact_decline` / `contact_remove` /
`contact_block` / `contact_unblock` / `contacts` / `blocked_list`。

服务端回 `{t:'contacts', friends, pendingIn, pendingOut}`，
`{t:'contact_event', message}` 用于提示类事件。

## 群聊

`group_create` / `group_invite` / `group_leave` / `group_kick` / `group_open` /
`group_msg` / `group_block` / `group_unblock` / `groups`。

## 图片与文件

- 图片：`{t:'img', tempId, w, h, data|ref, to|gid}`，服务端存盘后回 `{t:'img_ack'}` 并广播带 `image` 路径的消息。
- 文件：`file_start` / `file_part` / `file_end` 分片上传，回 `file_ack`。

## 版本

`{t:'version_check', code}` → `{t:'version_info', code, name, notes, url, needUpdate}`。
也提供 HTTP：`GET /version`、`GET /download/apk`。

## 心跳

`{t:'ping'}` → `{t:'pong'}`，客户端 20 秒一次，50 秒无回音重连。

## 限流

单连接每秒最多 8 条消息（分片上传单独放行），超出回 `{t:'error', message:'慢一点，消息太密了'}`。
