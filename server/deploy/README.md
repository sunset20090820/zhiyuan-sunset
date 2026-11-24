# 服务端部署

零依赖，Node 16+ 即可。整套服务 = `server.js` + `data/`。

## 1. 局域网试用
```bash
bash run.sh
```
会打印本机局域网 IP；手机连同一 WiFi，登录页填 `ws://192.168.x.x:8080`。

## 2. 装成系统服务（VPS）
```bash
sudo bash install.sh
```
装到 `/opt/zhiyuan`，注册 systemd（开机自启、崩溃拉起）。
云主机记得在安全组放行端口。

## 3. 安卓 Termux
```bash
pkg install nodejs-lts && bash termux.sh
```
同一台手机填 `ws://127.0.0.1:8080`；其他设备填这台手机局域网 IP。
Termux 里打开「获取唤醒锁」，否则息屏会被杀。

## 4. Docker
```bash
docker compose up -d
```

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `CERT` / `KEY` | 空 | 填了就直接开 wss（PEM 路径） |

## 备份
```bash
tar czf zhiyuan-data-$(date +%F).tar.gz -C /opt/zhiyuan data
```

## 更新推送
`data/version.json` 默认 `code: 0`，不会推送安装包。调高 `code` 并把 APK 放到
`data/apk/zhiyuan.apk`，可在自己的服务器上做内部分发。

## 4. 加密（wss）+ 限流

服务端已经内置：按连接限流（消息 12 条/5 秒、图片 3 张/10 秒、反馈 5 条/分钟、
同 IP 注册 6 次/分钟、登录 10 次/分钟），超了只回一句错误，不封连接。

要加密，需要一张**正式证书**（自签的 WebView 不认 —— WebSocket 的 TLS 校验
在 Chromium 里没法覆盖）：

```bash
# 有域名：用 certbot / acme.sh 签，然后把证书路径给服务端
CERT=/etc/letsencrypt/live/你的域名/fullchain.pem \
KEY=/etc/letsencrypt/live/你的域名/privkey.pem \
TLS_PORT=8443 node server.js
```

这样会同时监听：`:8080`（明文，局域网用）+ `:8443`（wss，公网用）。
App 里把服务器填成 `wss://你的域名:8443` 即可。

没有域名的话，两条可行路线：
- **Tailscale**：`tailscale serve --bg --https=443 http://127.0.0.1:8080`，
  它会给你一个带正式证书的 `*.ts.net` 域名，App 里填 `wss://xxx.ts.net`。
- **Cloudflare Tunnel**：`cloudflared tunnel --url http://127.0.0.1:8080`，
  同样给你一个可用的 https/wss 域名。
- 只在局域网用：继续用 `ws://192.168.x.x:8080`，不暴露公网就没这个问题。

自签证书可以用 `bash gen-cert.sh 114.55.230.190` 生成，适合你自己在前面挂
nginx/caddy 的场景（浏览器/WebView 看到的是 nginx 的证书）。
