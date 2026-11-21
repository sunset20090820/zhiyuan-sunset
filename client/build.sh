#!/usr/bin/env bash
# 构建并签名纸鸢 APK
# 依赖：JDK 17+、Android SDK（build-tools + platform android-34）
# 用法：
#   ANDROID_HOME=/opt/android-sdk KEYSTORE=./my.jks KS_PASS=xxx \
#     ./build.sh 5.6 56
# 说明：不提供签名时只产出未签名包；签名口令一律走环境变量，不要写进脚本。
set -euo pipefail
cd "$(dirname "$0")"

VER_NAME="${1:-dev}"
VER_CODE="${2:-1}"
# 服务器地址：SERVER / UPDATE_SERVER 环境变量写进 app/config.js
#   SERVER="ws://chat.example.com:8080" 登录页默认服务器（留空则让用户自己填）
#   UPDATE_SERVER="http://chat.example.com:8080" 更新源（留空=不检查更新）
: "${ANDROID_HOME:?请设置 ANDROID_HOME（内含 build-tools 与 platforms/android-34）}"

BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
PLATFORM="$ANDROID_HOME/platforms/android-34/android.jar"
D8="$BT/lib/d8.jar"
[ -f "$PLATFORM" ] || { echo "找不到 $PLATFORM"; exit 1; }

export PATH="$BT:$PATH"
mkdir -p build/gen build/obj build/dex build/assets
echo "window.APP_VERSION = \"$VER_NAME\";" > app/version.js

sed -i.bak -E "s/android:versionCode=\"[0-9]+\"/android:versionCode=\"$VER_CODE\"/; s/android:versionName=\"[^\"]*\"/android:versionName=\"$VER_NAME\"/" AndroidManifest.xml
rm -f AndroidManifest.xml.bak

# 生成运行时配置（不把地址写死在 app.js 里）
cat > app/config.js <<CFG
/* 由 build.sh 生成；提交到仓库的是空模板 */
window.ZY_CONFIG = {
  server: '${SERVER:-}',
  updateServer: '${UPDATE_SERVER:-}'
};
CFG
rm -rf build/assets/www && mkdir -p build/assets && cp -r app build/assets/www
aapt2 compile --dir res -o build/gen/res.zip >/dev/null 2>&1 || true
aapt package -f -m -M AndroidManifest.xml -S res -A build/assets -I "$PLATFORM" -J build/gen -F build/base.apk
javac -source 8 -target 8 -bootclasspath "$PLATFORM" -d build/obj $(find src build/gen -name '*.java')
java -cp "$D8" com.android.tools.r8.D8 --min-api 21 --lib "$PLATFORM" --output build/dex $(find build/obj -name '*.class')
aapt package -f -M AndroidManifest.xml -S res -A build/assets -I "$PLATFORM" -F build/base.apk
python3 - "$VER_NAME" <<'PY'
import sys, zipfile, os
ver = sys.argv[1]
zin = zipfile.ZipFile('build/base.apk')
with zipfile.ZipFile('build/packed.apk', 'w', zipfile.ZIP_DEFLATED) as zo:
    for i in zin.infolist():
        comp = zipfile.ZIP_STORED if i.filename == 'resources.arsc' else zipfile.ZIP_DEFLATED
        zo.writestr(i.filename, zin.read(i.filename), comp)
    zo.write('build/dex/classes.dex', 'classes.dex', compress_type=zipfile.ZIP_DEFLATED)
PY
zipalign -f -p 4 build/packed.apk build/aligned.apk
OUT="../dist/zhiyuan-$VER_NAME.apk"
mkdir -p ../dist
if [ -n "${KEYSTORE:-}" ]; then
  : "${KS_PASS:?设置了 KEYSTORE 就要给 KS_PASS}"
  apksigner sign --ks "$KEYSTORE" --ks-pass "env:KS_PASS" ${KS_ALIAS:+--ks-key-alias "$KS_ALIAS"} --out "$OUT" build/aligned.apk
  apksigner verify "$OUT" >/dev/null && echo "已签名：$OUT"
else
  cp build/aligned.apk "$OUT"
  echo "未签名：$OUT（机器上装不了，需要签名）"
fi
ls -l "$OUT"
