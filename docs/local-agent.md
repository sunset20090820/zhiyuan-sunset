# 本地用户（Agent 接入）

在 App 的「我的 → 本地用户」里开启后：

- 会话列表会出现一个 **本地用户** 会话
- App 在本机开放一个 TCP 端口（默认 `6721`，默认只监听 `127.0.0.1`）
- 你本地的 Agent（例如 astrbot）连上这个端口，就能和 App 里这个会话互通
- 这个会话**不经过服务器**：消息只在本机 App 与 Agent 之间流转
- 它是私聊性质的会话，**不能拉进群聊**、不能加好友、不能拉黑；删除菜单只清空本机记录

## 协议

TCP + 每行一个 UTF-8 JSON（`\n` 分隔）。

### 服务端 → Agent

```json
{"type":"hello","app":"zhiyuan","conv":"local","botName":"本地用户"}
{"type":"message","text":"用户说的话","ts":1690000000000}
{"type":"pong","ts":1690000000000}
```

### Agent → 服务端

```json
{"type":"send","text":"Agent 要回复的话"}
{"type":"ping"}
```

- 收到 `hello` 说明握手成功，之后可以随时 `send`
- 用户每条消息都会推送一次 `message`
- 一次连接可以连续收发，不需要重连

## 最小示例（Python）

```python
import json, socket

s = socket.create_connection(("127.0.0.1", 6721))
f = s.makefile("rwb")

for line in f:
    msg = json.loads(line)
    if msg.get("type") == "hello":
        print("已连接", msg)
    elif msg.get("type") == "message":
        text = msg.get("text", "")
        print("用户:", text)
        reply = "我收到了：" + text
        f.write((json.dumps({"type": "send", "text": reply}) + "\n").encode())
        f.flush()
```

## astrbot 接入思路

astrbot 侧不需要跑 QQ/微信协议，只要写一个很小的「平台适配器」：

1. 用上面的 socket 连 `127.0.0.1:6721`
2. 把 `message` 事件包装成平台消息（会话 id 固定用 `local`）
3. 把 astrbot 的回复通过 `{"type":"send","text":...}` 写回

这样 astrbot 的全部能力（人格、工具、插件、记忆）都能在纸鸢的「本地用户」会话里直接使用。

如果 astrbot 跑在同一台手机上（Termux），直接连 `127.0.0.1:6721`；
如果跑在同一局域网的电脑上，在设置里勾选「允许局域网连接」，用手机局域网 IP + 端口连接。

## 安全提示

- 默认只绑定 `127.0.0.1`，外部设备连不上
- 勾选「允许局域网连接」后，同一网络内的设备都能连这个端口，请在可信网络里使用
- 端口无鉴权，仅适合本机/可信局域网；不要做端口转发暴露到公网

## 端口归谁（重要）

`6721` 是**纸鸢自己 listen** 的。Agent 只能是客户端：`connect` 进去，不要自己 bind/listen 这个端口 —— 任何程序在 6721 上监听都会得到「端口已被占用」，因为纸鸢已经占着了。

从 7.4 起，这个监听挪进了前台服务（`KeepAliveService`）：

- App 退到后台不会被当成 cached 进程冻结，端口仍然能 accept；
- 退出界面（页面销毁）后端口照样在；进程被杀的话前台服务会重建并自动按保存的端口重新监听；
- Agent 发来的消息在页面不在时先存队列，回到 App 补发，并弹一条通知，不会漏。

如果还是连不上，先看系统省电策略：**设置 → 应用管理 → 纸鸢 → 省电策略 → 无限制**（小米/澎湃默认会冻后台）。

## 自测

```sh
python3 /sdcard/Download/DSH-Go/纸鸢-agent客户端.py
```

纸鸢开着「本地用户」时应在 1 秒内打印 `握手成功`；把纸鸢退到后台再跑一次，7.4 起同样能握手上（旧版会一直挂着直到把纸鸢切回前台）。
