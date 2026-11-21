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
