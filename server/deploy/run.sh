#!/usr/bin/env bash
# 前台快速启动（本机/局域网试用）
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "没装 Node，请先装 Node 16+"; exit 1; }
NODE_MAJOR=$(node -v | sed 's/v//; s/\..*//')
[ "$NODE_MAJOR" -ge 16 ] || { echo "Node 版本太低：$(node -v)，需要 >= 16"; exit 1; }
PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"
echo "纸鸢服务端启动中：端口 $PORT"
echo "同一 WiFi 下，手机 App 填：ws://<本机局域网IP>:$PORT"
echo "本机 IP："
node -e "const n=require('os').networkInterfaces();for(const k in n)for(const i of n[k])if(i.family==='IPv4'&&!i.internal)console.log('  '+i.address)"
echo "按 Ctrl+C 停止"
PORT=$PORT HOST=$HOST exec node server.js
