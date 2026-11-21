#!/data/data/com.termux/files/usr/bin/bash
# 在安卓上用 Termux 跑服务端（手机自己当服务器）
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "先装 Node：pkg install nodejs-lts"; exit 1; }
echo "启动后手机 App 填：ws://127.0.0.1:8080（同一台手机）"
echo "别的设备填：ws://<这台手机的局域网IP>:8080"
echo "提示：Termux 设置里打开「获取唤醒锁」，避免后台被杀"
PORT=8080 HOST=0.0.0.0 exec node server.js
