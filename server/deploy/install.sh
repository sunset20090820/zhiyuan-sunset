#!/usr/bin/env bash
# 一键装成系统服务（Debian/Ubuntu/CentOS 通用，需要 root）
set -e
cd "$(dirname "$0")"
[ "$(id -u)" = "0" ] || { echo "请用 root 运行：sudo bash install.sh"; exit 1; }
command -v node >/dev/null || { echo "没装 Node，请先安装 Node 16+（apt install nodejs 或 nvm）"; exit 1; }
DIR=/opt/zhiyuan
PORT="${PORT:-8080}"
echo "安装到 $DIR，端口 ${PORT}"
mkdir -p "$DIR"
cp -f server.js package.json "$DIR"/
mkdir -p "$DIR/data"/{apk,img,files,dm}
[ -f "$DIR/data/version.json" ] || cp -f data/version.json "$DIR/data/version.json"
id -u zhiyuan >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin zhiyuan
chown -R zhiyuan:zhiyuan "$DIR"
cat > /etc/systemd/system/zhiyuan.service <<UNIT
[Unit]
Description=ZhiYuan Chat Server
After=network.target

[Service]
Type=simple
User=zhiyuan
WorkingDirectory=$DIR
ExecStart=$(command -v node) server.js
Environment=PORT=$PORT
Environment=HOST=0.0.0.0
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable zhiyuan >/dev/null
systemctl restart zhiyuan
sleep 1
systemctl is-active zhiyuan && echo "已启动：systemctl status zhiyuan"
echo "客户端填：ws://<你的公网IP或域名>:${PORT}"
echo "防火墙放行示例：ufw allow ${PORT}/tcp   （云主机还要在安全组放行）"
