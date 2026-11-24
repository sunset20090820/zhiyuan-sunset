#!/usr/bin/env bash
# 生成自签证书（或给已有域名用 Let's Encrypt，见 README）
#   用法：bash gen-cert.sh <域名或IP>
set -e
HOST="${1:-$(curl -s -m 3 ifconfig.me || echo 127.0.0.1)}"
DIR="$(cd "$(dirname "$0")" && pwd)/../certs"
mkdir -p "$DIR"
openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -subj "/CN=$HOST" \
  -addext "subjectAltName=DNS:$HOST,IP:$HOST" 2>/dev/null || \
openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" -subj "/CN=$HOST"
chmod 600 "$DIR/key.pem"
echo "证书已生成：$DIR/cert.pem  $DIR/key.pem"
echo
echo "注意：自签证书 WebView 不认（WebSocket 的 TLS 校验无法覆盖），只适合："
echo "  · 前面挂 nginx/caddy 用正式证书；"
echo "  · 手机手动装了这个自签 CA（不推荐）；"
echo "  · 或者直接用 Tailscale / Cloudflare Tunnel 给的域名证书。"
echo
echo "配好正式证书后，服务端这样起（同时保留明文 8080 方便局域网）："
echo "  CERT=$DIR/cert.pem KEY=$DIR/key.pem TLS_PORT=8443 node server.js"
