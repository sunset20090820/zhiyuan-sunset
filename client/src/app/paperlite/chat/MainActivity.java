package app.paperlite.chat;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.app.DownloadManager;

public class MainActivity extends Activity {

    private static final String TAG = "PaperLite";
    private static final int REQ_MIC = 1001;
    private static final int REQ_NOTIF = 1002;
    private static final int REQ_FILE = 1003;
    private static final String CH_ID = "chat";        // 普通消息
    private static final String CH_MENTION = "mention"; // 被 @
    private static final String CH_FRIEND = "friend";   // 好友申请
    private static final String CH_ALIVE = "alive";

    private WebView web;
    private PermissionRequest pendingMic;
    private android.webkit.ValueCallback<Uri[]> fileCallback;
    private String pendingJump = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        takeIntent(getIntent());

        web = new WebView(this);
        setContentView(web);
        web.setBackgroundColor(Color.WHITE);
        web.setInitialScale(0);
        web.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        // 关键：overview 模式会把页面再缩放一次，缩放比不是 1 时触控坐标就会和画面错位
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setLayoutAlgorithm(WebSettings.LayoutAlgorithm.NORMAL);
        s.setMinimumFontSize(1);
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        web.addJavascriptInterface(new Bridge(this), "PaperNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                try {
                    String st = getSharedPreferences("paperlite", MODE_PRIVATE).getString("state", "");
                    if (st != null && st.length() > 2) {
                        String js = "try{window.__nativeRestore&&window.__nativeRestore("
                                + org.json.JSONObject.quote(st) + ")}catch(e){}";
                        view.evaluateJavascript(js, null);
                    }
                } catch (Exception e) { Log.w(TAG, "restore 失败: " + e); }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override public void run() { grantWebPermission(request); }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView v, android.webkit.ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = cb;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    startActivityForResult(Intent.createChooser(i, "选择文件"), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.d(TAG, cm.message());
                return true;
            }
        });

        web.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long len) {
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.addRequestHeader("User-Agent", userAgent);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                        android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType));
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                dm.enqueue(req);
                Toast.makeText(MainActivity.this, "开始下载", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(MainActivity.this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
        });

        createChannels();
        ensureNotificationPermission();
        startAlive();

        // 每次启动清一次缓存，避免旧 assets 被 WebView 复用
        try {
            web.clearCache(true);
            web.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
        } catch (Exception e) { }
        web.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        takeIntent(intent);
        if (web != null) {
            web.evaluateJavascript("window.PaperOnJump && window.PaperOnJump()", null);
        }
    }

    private void takeIntent(Intent intent) {
        if (intent == null) return;
        String j = intent.getStringExtra("jump");
        if (j != null) {
            pendingJump = j;
            intent.removeExtra("jump");
        }
    }

    /* ---------------- 麦克风 / 通知权限 ---------------- */
    private void grantWebPermission(PermissionRequest request) {
        String[] res = request.getResources();
        boolean wantsAudio = false;
        for (String r : res) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsAudio = true;
        }
        if (!wantsAudio) { request.deny(); return; }

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            return;
        }
        pendingMic = request;
        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_MIC);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_MIC) {
            boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            if (pendingMic != null) {
                if (ok) pendingMic.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                else pendingMic.deny();
                pendingMic = null;
            }
            if (!ok) Toast.makeText(this, "没有麦克风权限，无法录音", Toast.LENGTH_LONG).show();
        }
    }

    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, REQ_NOTIF);
            }
        }
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        NotificationChannel chat = new NotificationChannel(CH_ID, "聊天消息", NotificationManager.IMPORTANCE_HIGH);
        chat.setDescription("新消息提醒");
        chat.enableVibration(true);
        chat.enableLights(true);
        chat.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        nm.createNotificationChannel(chat);

        NotificationChannel mention = new NotificationChannel(CH_MENTION, "有人 @我", NotificationManager.IMPORTANCE_HIGH);
        mention.setDescription("群里有人 @你");
        mention.enableVibration(true);
        mention.enableLights(true);
        mention.setVibrationPattern(new long[] { 0, 180, 120, 180 });
        mention.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        nm.createNotificationChannel(mention);

        NotificationChannel friend = new NotificationChannel(CH_FRIEND, "好友申请", NotificationManager.IMPORTANCE_DEFAULT);
        friend.setDescription("新的好友申请");
        friend.enableVibration(true);
        friend.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        nm.createNotificationChannel(friend);

        NotificationChannel alive = new NotificationChannel(CH_ALIVE, "保持连接", NotificationManager.IMPORTANCE_MIN);
        alive.setShowBadge(false);
        nm.createNotificationChannel(alive);
    }

    private String channelFor(String kind) {
        if ("mention".equals(kind)) return CH_MENTION;
        if ("friend".equals(kind)) return CH_FRIEND;
        return CH_ID;
    }

    private void startAlive() {
        try {
            Intent i = new Intent(this, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        } catch (Exception e) {
            Log.w(TAG, "保活服务启动失败: " + e);
        }
    }

    /* ---------------- 给网页用的桥 ---------------- */
    public static class Bridge {
        private final MainActivity act;
        Bridge(MainActivity a) { this.act = a; }

        @JavascriptInterface
        public void notify(String title, String body, String tag, String jump) {
            act.postNotification(title, body, tag, jump, "msg");
        }

        /** kind: msg / mention / friend */
        @JavascriptInterface
        public void notifyEx(String title, String body, String tag, String jump, String kind) {
            act.postNotification(title, body, tag, jump, kind == null ? "msg" : kind);
        }

        /** 通知是否可用（系统权限 + 渠道未关闭） */
        @JavascriptInterface
        public boolean canNotify() {
            return act.notificationsAllowed();
        }

        @JavascriptInterface
        public String takeJump() {
            String j = act.pendingJump;
            act.pendingJump = null;
            return j == null ? "" : j;
        }

        @JavascriptInterface
        public void saveState(String json) {
            try {
                act.getSharedPreferences("paperlite", MODE_PRIVATE).edit()
                    .putString("state", json).commit();
            } catch (Exception e) { Log.w("PaperLite", "saveState prefs: " + e); }
            try {
                java.io.File f = new java.io.File(act.getFilesDir(), "session.json");
                java.io.FileOutputStream fo = new java.io.FileOutputStream(f);
                fo.write(json.getBytes("UTF-8"));
                fo.close();
            } catch (Exception e) { Log.w("PaperLite", "saveState file: " + e); }
        }

        @JavascriptInterface
        public String loadState() {
            String a = "";
            try {
                a = act.getSharedPreferences("paperlite", MODE_PRIVATE).getString("state", "");
            } catch (Exception e) { }
            if (a != null && a.length() > 2) return a;
            try {
                java.io.File f = new java.io.File(act.getFilesDir(), "session.json");
                if (f.exists()) {
                    byte[] b = new byte[(int) f.length()];
                    java.io.FileInputStream in = new java.io.FileInputStream(f);
                    in.read(b); in.close();
                    return new String(b, "UTF-8");
                }
            } catch (Exception e) { }
            return "";
        }

        @JavascriptInterface
        public int versionCode() {
            try {
                android.content.pm.PackageInfo pi = act.getPackageManager()
                        .getPackageInfo(act.getPackageName(), 0);
                return pi.versionCode;
            } catch (Exception e) { return 0; }
        }

        @JavascriptInterface
        public void downloadApk(String url) {
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setMimeType("application/vnd.android.package-archive");
                req.setTitle("纸鸢 新版本");
                req.setDescription("下载完成后点通知即可安装");
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "zhiyuan-update.apk");
                DownloadManager dm = (DownloadManager) act.getSystemService(Context.DOWNLOAD_SERVICE);
                dm.enqueue(req);
            } catch (Exception e) {
                Log.w(TAG, "下载安装包失败: " + e);
            }
        }

        private void notifyUpdate(final String json) {
            act.runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        act.web.evaluateJavascript(
                            "try{window.__updateResult&&window.__updateResult("
                            + org.json.JSONObject.quote(json == null ? "" : json) + ")}catch(e){}", null);
                    } catch (Exception e) { }
                }
            });
        }

        @JavascriptInterface
        public void checkUpdate(final String baseUrl) {
            new Thread(new Runnable() {
                @Override public void run() {
                    try {
                        java.net.URL u = new java.net.URL(baseUrl + "/version");
                        java.net.HttpURLConnection conn = (java.net.HttpURLConnection) u.openConnection();
                        conn.setConnectTimeout(6000);
                        conn.setReadTimeout(6000);
                        conn.setRequestProperty("User-Agent", "ZhiYuan/" + versionCode());
                        int code = conn.getResponseCode();
                        if (code != 200) { conn.disconnect(); notifyUpdate(""); return; }
                        java.io.InputStream in = conn.getInputStream();
                        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                        byte[] buf = new byte[4096];
                        int n;
                        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                        in.close(); conn.disconnect();
                        final String json = new String(bo.toByteArray(), "UTF-8");
                        act.runOnUiThread(new Runnable() {
                            @Override public void run() {
                                try {
                                    act.web.evaluateJavascript(
                                        "try{window.__updateInfo&&window.__updateInfo(" 
                                        + org.json.JSONObject.quote(json) + ")}catch(e){}", null);
                                } catch (Exception e) { }
                            }
                        });
                    } catch (Exception e) {
                        Log.w("PaperLite", "checkUpdate: " + e);
                        notifyUpdate("");
                    }
                }
            }).start();
        }

        @JavascriptInterface
        public void toast(String msg) {
            act.runOnUiThread(new Runnable() {
                @Override public void run() { Toast.makeText(act, msg, Toast.LENGTH_SHORT).show(); }
            });
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            try {
                android.os.Vibrator v = (android.os.Vibrator) act.getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null) v.vibrate(ms);
            } catch (Exception e) { }
        }
    }

    private boolean notificationsAllowed() {
        try {
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return false;
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = nm.getNotificationChannel(CH_ID);
                if (ch == null) return true;
                if (nm.areNotificationsEnabled() == false) return false;
            } else {
                return nm.areNotificationsEnabled();
            }
            return true;
        } catch (Exception e) { return true; }
    }

    private void postNotification(String title, String body, String tag, String jump, String kind) {
        try {
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                return;   // 用户没给通知权限，安静跳过，不崩
            }
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            if (jump != null && jump.length() > 0) open.putExtra("jump", jump);
            int flags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                                                    : PendingIntent.FLAG_UPDATE_CURRENT;
            // 用 tag 生成固定 requestCode，同一会话的通知复用同一个 PendingIntent，点击能带对 jump
            int reqCode = (tag == null ? "msg" : tag).hashCode();
            PendingIntent pi = PendingIntent.getActivity(this, reqCode, open, flags);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, channelFor(kind))
                    : new Notification.Builder(this);
            b.setContentTitle(title == null ? "纸鸢" : title)
             .setContentText(body == null ? "" : body)
             .setSmallIcon(R.mipmap.ic_launcher)
             .setAutoCancel(true)
             .setContentIntent(pi)
             .setWhen(System.currentTimeMillis());
            if (Build.VERSION.SDK_INT >= 21) {
                b.setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body));
                b.setVisibility(Notification.VISIBILITY_PRIVATE);
            }
            if (Build.VERSION.SDK_INT < 26) {
                // 8.0 以下没有渠道，靠 priority + defaults 保证响铃/震动
                b.setPriority("mention".equals(kind) || "msg".equals(kind)
                        ? Notification.PRIORITY_HIGH : Notification.PRIORITY_DEFAULT);
                b.setDefaults(Notification.DEFAULT_ALL);
            } else if ("mention".equals(kind)) {
                b.setDefaults(Notification.DEFAULT_ALL);
            }
            if ("friend".equals(kind)) b.setCategory(Notification.CATEGORY_SOCIAL);
            else b.setCategory(Notification.CATEGORY_MESSAGE);
            int id = (tag == null ? "msg" : tag).hashCode();
            nm.notify(id, b.build());
        } catch (Exception e) {
            Log.w(TAG, "通知失败: " + e);
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILE) {
            if (fileCallback == null) return;
            Uri[] out = null;
            if (res == RESULT_OK && data != null && data.getData() != null) {
                out = new Uri[] { data.getData() };
            }
            fileCallback.onReceiveValue(out);
            fileCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("(function(){try{return window.PaperBack?!!window.PaperBack():false}catch(e){return false}})()",
                new android.webkit.ValueCallback<String>() {
                    @Override public void onReceiveValue(String value) {
                        if (!"true".equals(value)) {
                            runOnUiThread(new Runnable() {
                                @Override public void run() { moveTaskToBack(true); }
                            });
                        }
                    }
                });
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 切后台前把网页状态同步到原生（杀进程时不会丢）
        try {
            if (web != null) {
                web.evaluateJavascript("try{window.__flushState&&window.__flushState()}catch(e){}", null);
            }
        } catch (Exception e) { }
    }

    @Override
    protected void onDestroy() {
        try { stopService(new Intent(this, KeepAliveService.class)); } catch (Exception e) { }
        if (web != null) {
            try { web.stopLoading(); } catch (Exception e) { }
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
