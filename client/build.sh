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

# 工具路径：默认从 ANDROID_HOME 取，也可以直接用环境变量覆盖
# （例如在 arm64 机器上用系统自带的 aapt/zipalign/apksigner + 任意一个 d8.jar）
BT="$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
AAPT="${AAPT:-${BT:+$BT/aapt}}"
AAPT2="${AAPT2:-${BT:+$BT/aapt2}}"
ZIPALIGN="${ZIPALIGN:-$(command -v zipalign || true)}"
APKSIGNER="${APKSIGNER:-$(command -v apksigner || true)}"
[ -n "${ZIPALIGN:-}" ] || ZIPALIGN="${BT:+$BT/zipalign}"
[ -n "${APKSIGNER:-}" ] || APKSIGNER="${BT:+$BT/apksigner}"

PLATFORM="$ANDROID_HOME/platforms/android-34/android.jar"
[ -f "$PLATFORM" ] || PLATFORM="$(ls /usr/lib/android-sdk/platforms/*/android.jar 2>/dev/null | tail -1 || true)"
D8="${D8:-${BT:+$BT/lib/d8.jar}}"

for t in AAPT ZIPALIGN APKSIGNER; do
  eval "v=\$$t"
  [ -n "${v:-}" ] && [ -x "$v" ] || { echo "缺少 $t：请安装 Android build-tools，或显式设置 $t=/path/to/$t"; exit 1; }
done
[ -f "$PLATFORM" ] || { echo "缺少 android.jar：请把 platform android-34 放到 \$ANDROID_HOME/platforms/"; exit 1; }
[ -f "$D8" ] || { echo "缺少 d8.jar：请设置 D8=/path/to/d8.jar"; exit 1; }
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
"$AAPT2" compile --dir res -o build/gen/res.zip >/dev/null 2>&1 || true
"$AAPT" package -f -m -M AndroidManifest.xml -S res -A build/assets -I "$PLATFORM" -J build/gen -F build/base.apk
javac -source 8 -target 8 -bootclasspath "$PLATFORM" -d build/obj $(find src build/gen -name '*.java')
java -cp "$D8" com.android.tools.r8.D8 --min-api 21 --lib "$PLATFORM" --output build/dex $(find build/obj -name '*.class')
"$AAPT" package -f -M AndroidManifest.xml -S res -A build/assets -I "$PLATFORM" -F build/base.apk
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
"$ZIPALIGN" -f -p 4 build/packed.apk build/aligned.apk
OUT="../dist/zhiyuan-$VER_NAME.apk"
mkdir -p ../dist
if [ -n "${KEYSTORE:-}" ]; then
  : "${KS_PASS:?设置了 KEYSTORE 就要给 KS_PASS}"
  "$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass "env:KS_PASS" ${KS_ALIAS:+--ks-key-alias "$KS_ALIAS"} --out "$OUT" build/aligned.apk
  "$APKSIGNER" verify "$OUT" >/dev/null && echo "已签名：$OUT"
else
  cp build/aligned.apk "$OUT"
  echo "未签名：$OUT（机器上装不了，需要签名）"
fi
ls -l "$OUT"
