# 纸鸢 · 轻量自建聊天

一个可以自己部署、自己用的聊天 App：Android 客户端 + 零依赖 Node 服务端。
不依赖任何第三方 IM 服务，账号、消息、图片全部在你自己的服务器上。

- **客户端**：Android（WebView 外壳 + 纯前端界面，无第三方库，APK 约 85 KB）
- **服务端**：单文件 Node，零 npm 依赖，WebSocket 协议自己实现

## 功能

聊天 / 群聊 / 私聊 / 数字 ID 加好友 / 表情与图片 / 语音 / 文件 / @提及 /
未读与通知 / 置顶 / 左滑或菜单删除会话 / 拉黑 / 深色模式 / 检查更新 /
多服务器切换（每台服务器一套独立数据）。

## 目录结构

```
client/                 Android 客户端
  AndroidManifest.xml
  src/app/paperlite/chat/
    MainActivity.java   WebView 外壳、原生桥（通知/下载/权限）
    KeepAliveService.java
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
- 服务端默认明文 `ws://`，公网部署建议用 Nginx/Caddy 反代成 `wss://`（`CERT`/`KEY` 环境变量可直接开 TLS）。
- 项目按现状提供，自行部署时请自行做好备份、防火墙和账号安全。

## License

MIT
