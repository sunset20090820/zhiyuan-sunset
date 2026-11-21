/* 纸鸢 运行时配置（构建时会按环境变量重写本文件）
 *
 * server       登录页默认的服务器地址，例如 'ws://chat.example.com:8080'
 *              留空则要求用户自己填；写 http(s):// 也可以，客户端会自动转成 ws(s)
 * updateServer 检查更新用的服务器（放 APK 的那台），http(s):// 或 ws(s):// 都行
 *              留空 = 不检查更新，避免任何第三方服务器给你的用户推送安装包
 */
window.ZY_CONFIG = {
  server: '',
  updateServer: ''
};
