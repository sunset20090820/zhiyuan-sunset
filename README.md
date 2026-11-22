# 纸鸢 · 轻量自建聊天

一个可以自己部署、自己用的聊天 App：Android 客户端 + 零依赖 Node 服务端。
不依赖任何第三方 IM 服务，账号、消息、图片全部在你自己的服务器上。

- **客户端**：Android（WebView 外壳 + 纯前端界面，无第三方库，APK 约 85 KB）
- **服务端**：单文件 Node，零 npm 依赖，WebSocket 协议自己实现

## 功能

聊天 / 群聊 / 私聊 / 数字 ID 加好友 / 表情与图片 / 语音 / 文件 / @提及 /
未读与通知 / 置顶 / 左滑或菜单删除会话 / 拉黑 / 深色模式 / 检查更新 /
多服务器切换（每台服务器一套独立数据）。

### Agent 接入（两条互不影响的通道）

| 通道 | 默认端口 | 说明 |
| --- | --- | --- |
| 本地用户 | 6721 | Agent 连进来，消息只在本机会话里，不经过服务器 |
| 用户接入 | 6722 | Agent 用服务器真账号上线，别人能加好友/私聊/拉群；私聊回私聊，群里被 @ 才回 |

两条通道各有自己的 TCP 端口、状态和开关，开一条不影响另一条；`hello` 里带 `channel`
字段（`local` / `user`），同一个 Agent 同时连两条也能分清。协议见
[`docs/local-agent.md`](docs/local-agent.md)。

### 界面（12.x：安卓 16 风格）

- **原生安卓 16 皮肤**：Material 3 Expressive —— 大圆角分组列表、药丸按钮、
  弹簧式按压、M3 导航栏选中药丸、Material 图标（不再是 emoji 图标）
- 配色跟随「主题色」：选 M3 主题色时直接用真实 M3 角色（surfaceContainer 层次）
- 「我的 → 美化设置 → 安卓 16 风格」可一键关掉，回到原来的小清新外观
- **玻璃加强**：顶栏/底栏/输入条/面板/列表都换成厚玻璃（跟随「液态玻璃强度」滑块），关掉液态玻璃自动退回实底
- **果冻动效**：底栏选中药丸会先拉长再弹到位，图标跟着抖一下，切页内容也有回弹
- **玻璃药丸**：底栏那块彩色底本身是玻璃——半透明容器色 + 背后模糊 + 渐变玻璃边框（上亮下带色）+ 滑动时扫一道光
- 玻璃与果冻**不分皮肤**：关掉「安卓 16 风格」回到小清新，玻璃和果冻照样生效（药丸会自动缩到 emoji 图标的尺寸）

### 界面（9.x / 10.x）

- **小清新 · 温馨**主题：柔和紫粉配色、大圆角、软阴影
- **液态玻璃**：顶栏 / 底栏 / 输入栏 / 面板统一玻璃质感，强度 0–100 可调，可整体关闭
- **胶囊玻璃列表**：会话列表与联系人列表为半透明胶囊卡片
- **美化设置**：集中在一个可展开面板里 —— 背景（其它界面 / 聊天页分别设置，6 套底色 + 相册图 + 明暗 0–90% + 模糊 0–40px）、主题色（6 套）、顶栏文字（自动 / 白字 / 黑字，单击顶部标题即可切换）、液态玻璃开关与强度
- 动效：气泡弹入、列表逐条浮现、面板上滑、按钮扫光，并尊重系统「减少动态效果」

## 目录结构

```
client/                 Android 客户端
  AndroidManifest.xml
  src/app/paperlite/chat/
    MainActivity.java   WebView 外壳、原生桥（通知/下载/权限）
    KeepAliveService.java  前台服务：托管两条 Agent 通道
    LocalAgentServer.java  TCP + 每行一个 JSON 的 Agent 服务
    AgentUserRelay.java    「用户接入」：Agent 账号上线与双向转发
    MiniWs.java / MiniJson.java  极小 WebSocket 客户端与 JSON 解析（无第三方依赖）
  app/                  网页层：index.html + app.js + style.css（全部逻辑在这）
  res/                  图标与主题
  build.sh              一键构建 + 签名
server/                 Node 服务端
  server.js             全部服务端逻辑（约 1900 行）
  deploy/               自助部署脚本
  data/version.json     版本信息模板
docs/                   协议与实现说明
```

## 客户端构建

需要 JDK 17+ 和 Android SDK（build-tools、platform android-34）。

```bash
cd client
ANDROID_HOME=/path/to/android-sdk \
SERVER=ws://chat.example.com:8080 \
UPDATE_SERVER=http://chat.example.com:8080 \
KEYSTORE=/path/to/my.jks KS_PASS=你的口令 \
./build.sh 5.7 57
```

产物在仓库根 `dist/zhiyuan-5.7.apk`。

| 环境变量 | 作用 |
|---|---|
| `SERVER` | 写进登录页默认的服务器地址（留空 = 让用户自己填） |
| `UPDATE_SERVER` | 检查更新的服务器（留空 = 不检查更新） |
| `KEYSTORE` / `KS_PASS` / `KS_ALIAS` | 签名用；不提供则产出未签名包 |

服务器地址**不写死在代码里**，由 `build.sh` 生成 `app/config.js`；仓库里提交的是空模板
`client/app/config.js`，所以源码公开不会泄露你的服务器地址。

> 签名口令只从环境变量读取，不要写进仓库。第一次签名：
> `keytool -genkeypair -keystore my.jks -alias zy -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=ZhiYuan"`

**换默认服务器**：不用改代码，构建时传 `SERVER` / `UPDATE_SERVER` 即可（见上表）。
也可以直接编辑 `client/app/config.js`：

```js
window.ZY_CONFIG = {
  server: 'ws://chat.example.com:8080',
  updateServer: 'http://chat.example.com:8080'
};
```

用户同样可以在登录页自己填别的服务器；本机数据按服务器隔离，换服务器不会串数据。

## 服务端部署

```bash
cd server/deploy
bash run.sh                 # 局域网快速试用
sudo bash install.sh        # 装成 systemd 服务
bash termux.sh              # 安卓 Termux 当服务器
docker compose up -d        # Docker
```

手机端在登录页填 `ws://服务器IP:8080` 即可注册使用。详见 [server/deploy/README.md](server/deploy/README.md)。

## 数据与隐私

服务端数据全在 `server/data/`：

| 文件 | 内容 |
|---|---|
| `accounts.json` | 账号、好友、拉黑名单 |
| `groups.json` | 群与成员 |
| `dm/` | 私聊记录（按会话分文件） |
| `img/`、`files/` | 上传的图片与文件 |
| `version.json` | 版本信息（默认 code=0，不推送更新） |

`data/` 已在 `.gitignore` 里，不会误提交。客户端本地按服务器隔离存储，切换服务器不会串数据。

## 说明

- 协议是自定义 JSON over WebSocket，细节见 [docs/protocol.md](docs/protocol.md)。
- 内置游戏「狼人杀」的设计与协议草案见 [docs/werewolf.md](docs/werewolf.md)。
- 本地用户 / Agent 接入（astrbot 等）见 [docs/local-agent.md](docs/local-agent.md)。
- 服务端默认明文 `ws://`，公网部署建议用 Nginx/Caddy 反代成 `wss://`（`CERT`/`KEY` 环境变量可直接开 TLS）。
- 项目按现状提供，自行部署时请自行做好备份、防火墙和账号安全。

## License

MIT

## 自动构建（可选）

仓库自带 `.github/workflows/build.yml`：推 `v*` tag 或手动触发时自动构建 APK。
需要在仓库设置里配置：

- Variables：`ZY_SERVER`（默认服务器）、`ZY_UPDATE_SERVER`（更新源）
- Secrets：`KEYSTORE_BASE64`（`base64 -w0 my.jks`）、`KS_PASS`、`KS_ALIAS`

不配 keystore 也能跑，只是产出的是未签名包。
