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
import android.webkit.CookieManager;
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

    /** 本地用户：消息/状态由前台服务推上来，页面只负责显示 */
    private final KeepAliveService.Listener agentUi = new KeepAliveService.Listener() {
        @Override public boolean onAgentMessage(final String text, final String from) {
            if (web == null) return false;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        String js = "try{window.__agentOnMessage&&window.__agentOnMessage("
                            + org.json.JSONObject.quote(text) + ")}catch(e){}";
                        if (web != null) web.evaluateJavascript(js, null);
                    } catch (Exception e) { }
                }
            });
            return true;
        }
        @Override public void onAgentStatus(final String json) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        String js = "try{window.__agentOnStatus&&window.__agentOnStatus("
                            + org.json.JSONObject.quote(json) + ")}catch(e){}";
                        if (web != null) web.evaluateJavascript(js, null);
                    } catch (Exception e) { }
                }
            });
        }
    };

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
                    if (st == null || st.length() < 3) {
                        try {
                            java.io.File f = new java.io.File(getFilesDir(), "session.json");
                            if (f.exists()) {
                                byte[] b = new byte[(int) f.length()];
                                java.io.FileInputStream in = new java.io.FileInputStream(f);
                                in.read(b); in.close();
                                st = new String(b, "UTF-8");
                            }
                        } catch (Exception e2) { }
                    }
                    if (st != null && st.length() > 2) {
                        String js = "try{window.__nativeRestore&&window.__nativeRestore("
                                + org.json.JSONObject.quote(st) + ")}catch(e){}";
                        view.evaluateJavascript(js, null);
                    }
                } catch (Exception e) { Log.w(TAG, "restore 失败: " + e); }
                // 页面就绪，把后端服务攒下的 Agent 消息补发上来
                KeepAliveService.setListener(agentUi);
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
        // 本地用户（Agent 接入）：之前开过就自动拉起
        try {
            android.content.SharedPreferences sp = getSharedPreferences("paperlite", MODE_PRIVATE);
            if (sp.getBoolean("agent_enabled", false)) {
                int port = sp.getInt("agent_port", 6721);
                boolean lan = sp.getBoolean("agent_lan", false);
                startLocalAgent(port, lan);
            }
        } catch (Exception e) { }
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
        // 正在跑的流式请求：rid → 连接，aiAbort / 退出页面时用来掐断
        private final java.util.Map<String, java.net.HttpURLConnection> aiConns =
                new java.util.concurrent.ConcurrentHashMap<String, java.net.HttpURLConnection>();

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

        /** 取可用模型列表：GET {base}/models，key 从本机保险箱取 */
        @JavascriptInterface
        public void aiModels(final String base) {
            new Thread(new Runnable() {
                @Override public void run() {
                    String out;
                    try {
                        out = aiModelsRequest(base);
                    } catch (Exception e) {
                        out = "{\"ok\":false,\"error\":\"" + esc4j(String.valueOf(e.getMessage())) + "\"}";
                    }
                    final String payload = out;
                    try {
                        act.runOnUiThread(new Runnable() {
                            @Override public void run() {
                                try {
                                    act.web.evaluateJavascript(
                                        "try{window.__aiModelsReply&&window.__aiModelsReply("
                                        + org.json.JSONObject.quote(payload) + ")}catch(e){}", null);
                                } catch (Exception e) { }
                            }
                        });
                    } catch (Exception e) { }
                }
            }).start();
        }

        private String aiModelsRequest(String base) throws Exception {
            String key = secretPick("ai_key");
            String url = base.replaceAll("/+$", "") + "/models";
            java.net.HttpURLConnection conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(30000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "okhttp/4.12.0");
            if (key != null && key.length() > 0) conn.setRequestProperty("Authorization", "Bearer " + key);
            int code = conn.getResponseCode();
            java.io.InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            java.io.BufferedReader br = new java.io.BufferedReader(new java.io.InputStreamReader(is, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            br.close();
            if (code >= 400) {
                String r = sb.toString();
                return "{\"ok\":false,\"error\":\"HTTP " + code + " " + esc4j(r.length() > 160 ? r.substring(0, 160) : r) + "\"}";
            }
            org.json.JSONObject j = new org.json.JSONObject(sb.toString());
            org.json.JSONArray data = j.optJSONArray("data");
            StringBuilder ids = new StringBuilder();
            if (data != null) {
                for (int i = 0; i < data.length(); i++) {
                    org.json.JSONObject m = data.optJSONObject(i);
                    if (m == null) continue;
                    String id = m.optString("id", "");
                    if (id.length() == 0) continue;
                    if (ids.length() > 0) ids.append(',');
                    ids.append(org.json.JSONObject.quote(id));
                }
            }
            return "{\"ok\":true,\"ids\":[" + ids + "]}";
        }

        /**
         * 自带 AI 助手：把请求交给原生发（WebView 里 fetch 会被 CORS 和 file:// 拦住）。
         * base/model/messages 由 JS 给，key 从本机保险箱取，不回传 JS。
         */
        @JavascriptInterface
        public void aiAsk(final String base, final String model, final String messagesJson, final String rid, final String optsJson) {
            boolean stream = false;
            try {
                if (optsJson != null && optsJson.length() > 0)
                    stream = new org.json.JSONObject(optsJson).optBoolean("stream", false);
            } catch (Exception e) { stream = false; }
            if (stream) { aiStream(base, model, messagesJson, rid, optsJson); return; }
            new Thread(new Runnable() {
                @Override public void run() {
                    String out;
                    try {
                        out = aiRequest(base, model, messagesJson, optsJson);
                    } catch (Exception e) {
                        out = "{\"ok\":false,\"error\":\"" + esc4j(String.valueOf(e.getMessage())) + "\"}";
                    }
                    // 带上请求号，JS 那边按号对账，避免一次丢包后面全错位
                    if (rid != null && rid.length() > 0 && out.endsWith("}")) {
                        out = out.substring(0, out.length() - 1) + ",\"rid\":" + org.json.JSONObject.quote(rid) + "}";
                    }
                    final String payload = out;
                    try {
                        act.runOnUiThread(new Runnable() {
                            @Override public void run() {
                                try {
                                    act.web.evaluateJavascript(
                                        "try{window.__aiReply&&window.__aiReply("
                                        + org.json.JSONObject.quote(payload) + ","
                                        + org.json.JSONObject.quote(rid == null ? "" : rid) + ")}catch(e){}", null);
                                } catch (Exception e) { }
                            }
                        });
                    } catch (Exception e) { }
                }
            }).start();
        }

        /** 打断一个正在跑的流式请求 */
        @JavascriptInterface
        public void aiAbort(String rid) {
            try {
                java.net.HttpURLConnection c = aiConns.remove(rid == null ? "" : rid);
                if (c != null) c.disconnect();
            } catch (Exception e) { }
        }

        private void aiJs(final String js) {
            try {
                act.runOnUiThread(new Runnable() {
                    @Override public void run() {
                        try { act.web.evaluateJavascript(js, null); } catch (Exception e) { }
                    }
                });
            } catch (Exception e) { }
        }
        private void aiCall(String fn, String rid, String arg) {
            aiJs("try{window." + fn + "&&window." + fn + "("
                    + org.json.JSONObject.quote(rid == null ? "" : rid) + ","
                    + org.json.JSONObject.quote(arg == null ? "" : arg) + ")}catch(e){}");
        }

        /**
         * 流式请求（SSE）。每来一段就回调 __aiOnDelta，结束回 __aiOnDone，
         * 出错回 __aiOnError。首个能连上的地址就用它，后面不再换。
         */
        private void aiStream(final String base, final String model, final String messagesJson,
                              final String rid, final String optsJson) {
            final String ridKey = rid == null ? "" : rid;
            new Thread(new Runnable() {
                @Override public void run() {
                    String key;
                    try {
                        key = secretPick("ai_key");
                    } catch (Exception e) { key = ""; }
                    if (key == null || key.length() == 0) { aiCall("__aiOnError", ridKey, "还没填 API key"); return; }

                    String effort = "";
                    double temp = 0.85;
                    int maxTokens = 0;
                    try {
                        org.json.JSONObject o = new org.json.JSONObject(optsJson == null ? "{}" : optsJson);
                        effort = o.optString("effort", "");
                        temp = o.optDouble("temperature", 0.85);
                        maxTokens = o.optInt("maxTokens", 0);
                    } catch (Exception e) { }

                    org.json.JSONArray msgs;
                    try { msgs = new org.json.JSONArray(messagesJson == null ? "[]" : messagesJson); }
                    catch (Exception e) { aiCall("__aiOnError", ridKey, "消息格式不对"); return; }

                    java.util.List<String> urls = aiUrlCandidates(base, "/chat/completions");
                    String firstErr = null;
                    for (int ui = 0; ui < urls.size(); ui++) {
                        String url = urls.get(ui);
                        java.net.HttpURLConnection conn = null;
                        try {
                            org.json.JSONObject body = new org.json.JSONObject();
                            body.put("model", model);
                            body.put("messages", msgs);
                            body.put("stream", true);
                            try { body.put("temperature", temp); } catch (Exception e) { }
                            if (maxTokens > 0) body.put("max_tokens", maxTokens);
                            if ("none".equals(effort)) {
                                org.json.JSONObject think = new org.json.JSONObject();
                                think.put("type", "disabled");
                                body.put("thinking", think);
                                body.put("enable_thinking", false);
                            } else if ("low".equals(effort) || "medium".equals(effort) || "high".equals(effort)) {
                                body.put("reasoning_effort", effort);
                            }
                            byte[] bytes = body.toString().getBytes("UTF-8");

                            conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                            conn.setConnectTimeout(12000);
                            conn.setReadTimeout(120000);
                            conn.setRequestMethod("POST");
                            conn.setDoOutput(true);
                            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                            conn.setRequestProperty("Accept", "text/event-stream");
                            conn.setRequestProperty("User-Agent", "okhttp/4.12.0");
                            conn.setRequestProperty("Authorization", "Bearer " + key);
                            conn.setFixedLengthStreamingMode(bytes.length);
                            aiConns.put(ridKey, conn);
                            java.io.OutputStream os = conn.getOutputStream();
                            os.write(bytes); os.flush(); os.close();

                            int code = conn.getResponseCode();
                            if (code >= 400) {
                                String head = readAll(code >= 400 ? conn.getErrorStream() : null, 400);
                                if (code == 400 && effort.length() > 0) {
                                    // 对方不认思考参数：去掉再试一次这个地址
                                    aiConns.remove(ridKey);
                                    conn.disconnect();
                                    org.json.JSONObject plain = new org.json.JSONObject();
                                    plain.put("model", model);
                                    plain.put("messages", msgs);
                                    plain.put("stream", true);
                                    byte[] b2 = plain.toString().getBytes("UTF-8");
                                    conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                                    conn.setConnectTimeout(12000);
                                    conn.setReadTimeout(120000);
                                    conn.setRequestMethod("POST");
                                    conn.setDoOutput(true);
                                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                                    conn.setRequestProperty("Accept", "text/event-stream");
                                    conn.setRequestProperty("User-Agent", "okhttp/4.12.0");
                                    conn.setRequestProperty("Authorization", "Bearer " + key);
                                    conn.setFixedLengthStreamingMode(b2.length);
                                    aiConns.put(ridKey, conn);
                                    os = conn.getOutputStream();
                                    os.write(b2); os.flush(); os.close();
                                    code = conn.getResponseCode();
                                    if (code >= 400) head = readAll(conn.getErrorStream(), 400);
                                }
                                if (code >= 400) {
                                    if (code == 401 || code == 403) firstErr = "HTTP " + code + " " + head;
                                    else if (firstErr == null) firstErr = "HTTP " + code + " " + head;
                                    aiConns.remove(ridKey);
                                    conn.disconnect();
                                    if (code == 401 || code == 403) break;
                                    continue;
                                }
                            }

                            StringBuilder all = new StringBuilder();
                            java.io.BufferedReader br = new java.io.BufferedReader(
                                    new java.io.InputStreamReader(conn.getInputStream(), "UTF-8"));
                            String line;
                            String usageJson = "";
                            boolean done = false;
                            while ((line = br.readLine()) != null) {
                                String t = line.trim();
                                if (t.length() == 0) continue;
                                if (t.startsWith("data:")) t = t.substring(5).trim();
                                if ("[DONE]".equals(t)) { done = true; break; }
                                if (t.indexOf('{') < 0) continue;
                                try {
                                    org.json.JSONObject j = new org.json.JSONObject(t);
                                    if (j.has("usage")) usageJson = j.getJSONObject("usage").toString();
                                    org.json.JSONArray ch = j.optJSONArray("choices");
                                    if (ch == null || ch.length() == 0) continue;
                                    org.json.JSONObject c0 = ch.getJSONObject(0);
                                    org.json.JSONObject delta = c0.optJSONObject("delta");
                                    String piece = delta == null ? "" : delta.optString("content", "");
                                    if (piece.length() == 0 && delta != null) {
                                        // 有的中转把增量放在 reasoning_content（思考内容），不显示但要吃掉
                                        piece = "";
                                    }
                                    if (piece.length() > 0) {
                                        all.append(piece);
                                        aiCall("__aiOnDelta", ridKey, piece);
                                    }
                                } catch (Exception e) { }
                            }
                            br.close();
                            String text = all.toString();
                            if (text.length() == 0) {
                                if (firstErr == null) firstErr = "模型没有返回内容（可能是对方不支持流式）";
                                aiConns.remove(ridKey);
                                conn.disconnect();
                                continue;
                            }
                            String urlOut = url.replaceFirst("^https?://", "");
                            String doneJson = "{\"ok\":true,\"text\":\"" + esc4j(text)
                                    + "\",\"url\":\"" + esc4j(urlOut) + "\"";
                            if (usageJson.length() > 0) doneJson = doneJson + ",\"usage\":" + usageJson;
                            doneJson = doneJson + "}";
                            aiConns.remove(ridKey);
                            try { conn.disconnect(); } catch (Exception e) { }
                            aiCall("__aiOnDone", ridKey, doneJson);
                            return;
                        } catch (Exception e) {
                            String m = String.valueOf(e.getMessage());
                            if (firstErr == null) firstErr = "连不上 " + url.replaceFirst("^https?://", "") + "：" + m;
                            aiConns.remove(ridKey);
                            try { if (conn != null) conn.disconnect(); } catch (Exception e2) { }
                        }
                    }
                    aiCall("__aiOnError", ridKey, firstErr == null ? "发不出去" : firstErr);
                }
            }).start();
        }

        private String readAll(java.io.InputStream is, int max) {
            StringBuilder sb = new StringBuilder();
            try {
                if (is == null) return "";
                java.io.BufferedReader br = new java.io.BufferedReader(new java.io.InputStreamReader(is, "UTF-8"));
                String line;
                while ((line = br.readLine()) != null && sb.length() < max) sb.append(line).append('\n');
                br.close();
            } catch (Exception e) { }
            String s = sb.toString();
            return s.length() > max ? s.substring(0, max) : s;
        }

        /* --- 本机键值存储：角色卡 / 世界包 / 卷 / 原文都放这里（不受清缓存影响） --- */
        private java.io.File kvFile(String k) {
            String name = String.valueOf(k).replaceAll("[^A-Za-z0-9._-]", "_");
            if (name.length() > 60) name = name.substring(0, 60);
            int h = String.valueOf(k).hashCode();
            java.io.File dir = new java.io.File(act.getFilesDir(), "kv");
            if (!dir.exists()) dir.mkdirs();
            return new java.io.File(dir, name + "_" + Integer.toHexString(h) + ".json");
        }

        @JavascriptInterface
        public void kvPut(String k, String v) {
            java.io.File f = kvFile(k);
            java.io.File tmp = new java.io.File(f.getAbsolutePath() + ".tmp");
            try {
                java.io.FileOutputStream fo = new java.io.FileOutputStream(tmp);
                fo.write(String.valueOf(v).getBytes("UTF-8"));
                fo.flush();
                try { fo.getFD().sync(); } catch (Exception e) { }
                fo.close();
                if (f.exists()) f.delete();
                tmp.renameTo(f);
            } catch (Exception e) { Log.w("PaperLite", "kvPut " + k + ": " + e); }
        }

        @JavascriptInterface
        public String kvGet(String k) {
            try {
                java.io.File f = kvFile(k);
                if (!f.exists()) return "";
                long n = f.length();
                if (n <= 0 || n > 8 * 1024 * 1024) return "";
                byte[] b = new byte[(int) n];
                java.io.FileInputStream in = new java.io.FileInputStream(f);
                int off = 0;
                while (off < b.length) {
                    int r = in.read(b, off, b.length - off);
                    if (r <= 0) break;
                    off += r;
                }
                in.close();
                return new String(b, 0, off, "UTF-8");
            } catch (Exception e) { return ""; }
        }

        @JavascriptInterface
        public void kvDel(String k) {
            try {
                java.io.File f = kvFile(k);
                if (f.exists()) f.delete();
            } catch (Exception e) { }
        }

        /** 一个地址试不通就换着试（少写 v1 / 多写 v1 / 带不带 /v1 前缀） */
        private java.util.List<String> aiUrlCandidates(String base, String tail) {
            java.util.List<String> out = new java.util.ArrayList<String>();
            String b = base == null ? "" : base.trim().replaceAll("/+$", "");
            if (b.length() == 0) b = "https://api.deepseek.com/v1";
            out.add(b + tail);
            String noVer = b.replaceAll("/v1$", "");
            if (!noVer.equals(b)) {
                out.add(noVer + tail);                              // 去掉 /v1 再试
                out.add(noVer + "/v1" + tail);                       // 换个写法
            } else {
                out.add(b + "/v1" + tail);                           // 补上 /v1
            }
            return out;
        }

        private String aiRequest(String base, String model, String messagesJson, String optsJson) throws Exception {
            String key = secretPick("ai_key");
            if (key == null || key.length() == 0) return "{\"ok\":false,\"error\":\"还没填 API key\"}";
            org.json.JSONArray msgs = new org.json.JSONArray(messagesJson == null ? "[]" : messagesJson);
            org.json.JSONObject body = new org.json.JSONObject();
            body.put("model", model);
            body.put("messages", msgs);
            body.put("stream", false);
            // 思考强度：关 → 明确禁用思考；低/中/高 → reasoning_effort。
            // 有些中转不认这些字段会直接忽略，也有少数会报 400，那种情况下面会重试一次「不带额外字段」。
            String effort = "";
            try {
                if (optsJson != null && optsJson.length() > 0) {
                    effort = new org.json.JSONObject(optsJson).optString("effort", "");
                }
            } catch (Exception e) { effort = ""; }
            if ("none".equals(effort)) {
                org.json.JSONObject think = new org.json.JSONObject();
                think.put("type", "disabled");
                body.put("thinking", think);
                body.put("enable_thinking", false);
            } else if ("low".equals(effort) || "medium".equals(effort) || "high".equals(effort)) {
                body.put("reasoning_effort", effort);
            }
            byte[] bytes = body.toString().getBytes("UTF-8");
            // 不带思考参数的一份：对方把额外字段当错误（400）时用它重试
            byte[] bytesPlain = null;
            if (effort != null && effort.length() > 0) {
                org.json.JSONObject plain = new org.json.JSONObject();
                plain.put("model", model);
                plain.put("messages", msgs);
                plain.put("stream", false);
                bytesPlain = plain.toString().getBytes("UTF-8");
            }
            java.util.List<String> urls = aiUrlCandidates(base, "/chat/completions");
            String firstErr = null, tried = "";
            for (int ui = 0; ui < urls.size(); ui++) {
                String url = urls.get(ui);
                if (tried.length() > 0) tried = tried + " → ";
                tried = tried + url.replaceFirst("^https?://", "");
                int code = -1;
                String resp = "";
                try {
                    String[] r1 = aiPost(url, key, bytes);
                    code = Integer.parseInt(r1[0]);
                    resp = r1[1];
                    if (code == 400 && bytesPlain != null) {
                        String[] r2 = aiPost(url, key, bytesPlain);   // 对方不认思考参数，去掉再试
                        if (Integer.parseInt(r2[0]) < 400) { code = Integer.parseInt(r2[0]); resp = r2[1]; }
                    }
                } catch (Exception e) {
                    String m = String.valueOf(e.getMessage());
                    firstErr = "连不上 " + url.replaceFirst("^https?://", "") + "：" + m;
                    continue;                       // 网络层失败，换下一个地址
                }
                if (code >= 400) {
                    String head = resp.length() > 200 ? resp.substring(0, 200) : resp;
                    boolean html = head != null && (head.indexOf("<html") >= 0 || head.indexOf("<!DOCTYPE") >= 0
                            || head.indexOf("error code:") >= 0 || head.trim().startsWith("<"));
                    String why = html
                        ? ("对方站点回的不是 JSON（网关/Cloudflare 错误页），说明是那个地址的服务或中转出了问题，不是手机这边：" + head)
                        : ("HTTP " + code + " " + head);
                    if (firstErr == null) firstErr = why + "（试过 " + tried + "）";
                    // 404/405/502/503 这类往往是路径不对，换下一个地址再试；401/403 是 key 或权限，别再乱试
                    if (code == 401 || code == 403) break;
                    continue;
                }
                // 2xx：解析回复
                org.json.JSONObject j = null;
                try { j = new org.json.JSONObject(resp); } catch (Exception pe) {
                    if (firstErr == null) firstErr = "返回的不是 JSON：" + (resp.length() > 200 ? resp.substring(0, 200) : resp);
                    continue;
                }
                String text = "";
                try {
                    text = j.getJSONArray("choices").getJSONObject(0).getJSONObject("message").optString("content", "");
                } catch (Exception e) {
                    if (firstErr == null) firstErr = "返回里没有 choices[0].message.content：" + (resp.length() > 200 ? resp.substring(0, 200) : resp);
                    continue;
                }
                if (text.length() == 0) {
                    if (firstErr == null) firstErr = "模型返回了空内容";
                    continue;
                }
                // 顺带把 token 用量带回去（有的中转不给 usage，前端会退回估算）
                String usageOut = "";
                try {
                    if (j.has("usage")) {
                        String u = j.getJSONObject("usage").toString();
                        if (u != null && u.length() > 2) usageOut = ",\"usage\":" + u;
                    }
                } catch (Exception e) { }
                return "{\"ok\":true,\"text\":\"" + esc4j(text) + "\",\"url\":\"" + esc4j(url.replaceFirst("^https?://", "")) + "\"" + usageOut + "}";
            }
            return "{\"ok\":false,\"error\":\"" + esc4j(firstErr == null ? "发不出去" : firstErr) + "\"}";
        }

        /** 发一次 POST，返回 {状态码, 响应体} */
        private String[] aiPost(String url, String key, byte[] bytes) throws Exception {
            java.net.HttpURLConnection conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(120000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            // 用正常客户端 UA：有些中转/Cloudflare 会把 Java/1.x 当机器人挡掉（502/403）
            conn.setRequestProperty("User-Agent", "okhttp/4.12.0");
            conn.setRequestProperty("Authorization", "Bearer " + key);
            conn.setFixedLengthStreamingMode(bytes.length);
            java.io.OutputStream os = conn.getOutputStream();
            os.write(bytes);
            os.flush();
            os.close();
            int code = conn.getResponseCode();
            java.io.InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            StringBuilder sb = new StringBuilder();
            if (is != null) {
                java.io.BufferedReader br = new java.io.BufferedReader(new java.io.InputStreamReader(is, "UTF-8"));
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
                br.close();
            }
            return new String[] { String.valueOf(code), sb.toString() };
        }

        private String esc4j(String s) {
            if (s == null) return "";
            return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "").replace("\t", "  ");
        }

        /* ---- 小保险箱：AES/GCM 加密后再写 SharedPreferences（密钥在 AndroidKeyStore 里） ---- */
        private static final String KS_ALIAS = "paperlite_secrets_key";
        private static final String ENC_TAG = "enc1:";

        private javax.crypto.SecretKey ksKey() throws Exception {
            java.security.KeyStore ks = java.security.KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (!ks.containsAlias(KS_ALIAS)) {
                javax.crypto.KeyGenerator kg = javax.crypto.KeyGenerator.getInstance(
                    android.security.keystore.KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                android.security.keystore.KeyGenParameterSpec.Builder b = new android.security.keystore.KeyGenParameterSpec.Builder(
                    KS_ALIAS, android.security.keystore.KeyProperties.PURPOSE_ENCRYPT | android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256);
                if (android.os.Build.VERSION.SDK_INT >= 23) b.setRandomizedEncryptionRequired(true);
                kg.init(b.build());
                kg.generateKey();
            }
            return (javax.crypto.SecretKey) ks.getKey(KS_ALIAS, null);
        }

        private String secretEncrypt(String plain) {
            try {
                javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
                c.init(javax.crypto.Cipher.ENCRYPT_MODE, ksKey());
                byte[] iv = c.getIV();
                byte[] ct = c.doFinal(plain.getBytes("UTF-8"));
                byte[] out = new byte[1 + iv.length + ct.length];
                out[0] = (byte) iv.length;
                System.arraycopy(iv, 0, out, 1, iv.length);
                System.arraycopy(ct, 0, out, 1 + iv.length, ct.length);
                return ENC_TAG + android.util.Base64.encodeToString(out, android.util.Base64.NO_WRAP);
            } catch (Throwable e) { return null; }
        }

        private String secretDecrypt(String stored) {
            try {
                byte[] raw = android.util.Base64.decode(stored.substring(ENC_TAG.length()), android.util.Base64.NO_WRAP);
                int ivLen = raw[0] & 0xff;
                byte[] iv = new byte[ivLen], ct = new byte[raw.length - 1 - ivLen];
                System.arraycopy(raw, 1, iv, 0, ivLen);
                System.arraycopy(raw, 1 + ivLen, ct, 0, ct.length);
                javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
                c.init(javax.crypto.Cipher.DECRYPT_MODE, ksKey(), new javax.crypto.spec.GCMParameterSpec(128, iv));
                return new String(c.doFinal(ct), "UTF-8");
            } catch (Throwable e) { return ""; }
        }

        /** 本机私有小保险箱：AI 助手的 API key 加密后存这里，不进 WebView 的 localStorage */
        @JavascriptInterface
        public void secretSet(String name, String value) {
            try {
                String plain = value == null ? "" : value;
                String out = plain.length() == 0 ? "" : secretEncrypt(plain);
                if (out == null || out.length() == 0) out = plain;      // Keystore 不可用才退回明文
                act.getSharedPreferences("paperlite_secrets", MODE_PRIVATE).edit()
                    .putString("s_" + name, out).apply();
            } catch (Exception e) { }
        }

        @JavascriptInterface
        public String secretGet(String name) {
            try {
                String v = act.getSharedPreferences("paperlite_secrets", MODE_PRIVATE)
                    .getString("s_" + name, "");
                if (v == null || v.length() == 0) return "";
                if (v.startsWith(ENC_TAG)) {
                    String plain = secretDecrypt(v);
                    return plain == null ? "" : plain;
                }
                // 老版本存的明文：读出来顺手加密回去
                String enc = secretEncrypt(v);
                if (enc != null && enc.length() > 0) {
                    act.getSharedPreferences("paperlite_secrets", MODE_PRIVATE).edit()
                        .putString("s_" + name, enc).apply();
                }
                return v;
            } catch (Exception e) { return ""; }
        }

        /** 原生内部取 key（可能是加密的，这里统一解密） */
        private String secretPick(String name) {
            try {
                String v = act.getSharedPreferences("paperlite_secrets", MODE_PRIVATE).getString("s_" + name, "");
                if (v == null || v.length() == 0) return "";
                if (v.startsWith(ENC_TAG)) { String p = secretDecrypt(v); return p == null ? "" : p; }
                return v;
            } catch (Exception e) { return ""; }
        }

        /* ---------------- 书源抓取：原生 HTTP（绕开 WebView 的跨域与编码问题） ---------------- */
        private static final int HTTP_MAX_BYTES = 4 * 1024 * 1024;

        private String decodeBody(byte[] bytes, String contentType, String encoding, String forceCharset) {
            if (bytes == null) return "";
            byte[] data = bytes;
            String enc = encoding == null ? "" : encoding.toLowerCase();
            if (enc.indexOf("gzip") >= 0) {
                try {
                    java.util.zip.GZIPInputStream gz = new java.util.zip.GZIPInputStream(
                        new java.io.ByteArrayInputStream(bytes));
                    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = gz.read(buf)) > 0) out.write(buf, 0, n);
                    gz.close();
                    data = out.toByteArray();
                } catch (Exception e) { }
            }
            String charset = (forceCharset != null && forceCharset.trim().length() > 0)
                ? forceCharset.trim() : null;
            if (charset == null) try {
                java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("charset=([\\w-]+)", java.util.regex.Pattern.CASE_INSENSITIVE)
                    .matcher(contentType == null ? "" : contentType);
                if (m.find()) charset = m.group(1);
            } catch (Exception e) { }
            if (charset == null) {
                String head = new String(data, 0, Math.min(2048, data.length),
                        java.nio.charset.StandardCharsets.ISO_8859_1);
                try {
                    java.util.regex.Matcher m2 = java.util.regex.Pattern
                        .compile("charset\\s*=\\s*[\"']?([\\w-]+)", java.util.regex.Pattern.CASE_INSENSITIVE)
                        .matcher(head);
                    if (m2.find()) charset = m2.group(1);
                } catch (Exception e) { }
            }
            if (charset != null) {
                String cs = charset.toLowerCase().replace("gb2312", "gbk").replace("gb18030", "gbk");
                try { return new String(data, cs); } catch (Exception e) { }
            }
            String utf8 = new String(data, java.nio.charset.StandardCharsets.UTF_8);
            if (utf8.indexOf('\uFFFD') < 0) return utf8;
            try { return new String(data, "GBK"); } catch (Exception e) { return utf8; }
        }

        /** 抓一个网页/接口：rid 由 JS 生成，回来了走 window.__httpDone(rid,status,text,err) */
        @JavascriptInterface
        public void httpGet(final String rid, final String url, final String headersJson) {
            httpGetEx(rid, url, headersJson, "GET", "", "");
        }

        /** 带方法/请求体/编码的版本：书源搜索里有不少是 POST + GBK */
        @JavascriptInterface
        public void httpGetEx(final String rid, final String url, final String headersJson,
                              final String method, final String body, final String charset) {
            final String id = rid == null ? "" : rid;
            new Thread(new Runnable() {
                @Override public void run() {
                    int status = 0;
                    String text = "", err = "";
                    java.net.HttpURLConnection conn = null;
                    try {
                        java.net.URL u = new java.net.URL(url);
                        conn = (java.net.HttpURLConnection) u.openConnection();
                        conn.setConnectTimeout(12000);
                        conn.setReadTimeout(20000);
                        conn.setInstanceFollowRedirects(true);
                        conn.setRequestProperty("User-Agent",
                            "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
                        conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml,application/json,text/plain,*/*");
                        conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
                        conn.setRequestProperty("Accept-Encoding", "gzip");
                        boolean isPost = method != null && method.toUpperCase().equals("POST");
                        if (isPost) {
                            conn.setRequestMethod("POST");
                            conn.setDoOutput(true);
                            byte[] bs = (body == null ? "" : body).getBytes(
                                charset != null && charset.length() > 0
                                    ? (charset.toLowerCase().replace("gb2312", "gbk")) : "UTF-8");
                            conn.setFixedLengthStreamingMode(bs.length);
                        }
                        if (headersJson != null && headersJson.length() > 2) {
                            try {
                                org.json.JSONObject h = new org.json.JSONObject(headersJson);
                                java.util.Iterator<String> it = h.keys();
                                while (it.hasNext()) {
                                    String k = it.next();
                                    try { conn.setRequestProperty(k, h.optString(k)); } catch (Exception e) { }
                                }
                            } catch (Exception e) { }
                        }
                        if (isPost) {
                            try {
                                java.io.OutputStream os = conn.getOutputStream();
                                os.write((body == null ? "" : body).getBytes(
                                    charset != null && charset.length() > 0
                                        ? (charset.toLowerCase().replace("gb2312", "gbk")) : "UTF-8"));
                                os.flush(); os.close();
                            } catch (Exception e) { }
                        }
                        status = conn.getResponseCode();
                        java.io.InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                        if (in != null) {
                            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                            byte[] buf = new byte[8192];
                            int n;
                            while ((n = in.read(buf)) > 0) {
                                bos.write(buf, 0, n);
                                if (bos.size() >= HTTP_MAX_BYTES) break;
                            }
                            try { in.close(); } catch (Exception e) { }
                            text = decodeBody(bos.toByteArray(), conn.getContentType(), conn.getContentEncoding(), charset);
                        }
                    } catch (Exception e) {
                        err = String.valueOf(e.getMessage());
                    } finally {
                        try { if (conn != null) conn.disconnect(); } catch (Exception e) { }
                    }
                    final String fText = text, fErr = err;
                    final int fStatus = status;
                    try {
                        act.runOnUiThread(new Runnable() {
                            @Override public void run() {
                                try {
                                    if (act.web == null) return;
                                    String js = "try{window.__httpDone&&window.__httpDone("
                                        + org.json.JSONObject.quote(id) + ","
                                        + fStatus + ","
                                        + org.json.JSONObject.quote(fText) + ","
                                        + org.json.JSONObject.quote(fErr) + ")}catch(e){}";
                                    act.web.evaluateJavascript(js, null);
                                } catch (Exception e) { }
                            }
                        });
                    } catch (Exception e) { }
                }
            }).start();
        }

        @JavascriptInterface
        public String agentStatus() {
            return act.agentStatusJson();
        }

        @JavascriptInterface
        public void agentEnable(boolean on, int port, boolean lan) {
            act.toggleLocalAgent(on, port, lan);
        }

        @JavascriptInterface
        public void agentSend(String text) {
            act.sendToAgent(text);
        }

        @JavascriptInterface
        public void agentName(String name) {
            act.applyAgentName(name);
        }

        @JavascriptInterface
        public void agentUserApply(boolean on, String user, String pass, String nick, String avatar,
                                   int port, boolean lan) {
            act.applyAgentUser(on, user, pass, nick, avatar, port, lan);
        }

        @JavascriptInterface
        public String agentUserStatus() {
            return KeepAliveService.statusJson();
        }

        @JavascriptInterface
        public String takeJump() {
            String j = act.pendingJump;
            act.pendingJump = null;
            return j == null ? "" : j;
        }

        /**
         * 导出文本到「下载/DSH-Go/纸鸢备份/」。
         * Android 10+ 走 MediaStore（不需要权限）；老系统退到应用外部私有目录。
         */
        @JavascriptInterface
        public void exportFile(final String name, final String text) {
            new Thread(new Runnable() {
                @Override public void run() {
                    String safe = String.valueOf(name == null ? "export.json" : name)
                            .replaceAll("[\\/:*?\"<>|]", "_");
                    String path = "";
                    boolean ok = false;
                    try {
                        if (Build.VERSION.SDK_INT >= 29) {
                            android.content.ContentValues cv = new android.content.ContentValues();
                            cv.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, safe);
                            cv.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "application/json");
                            cv.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH,
                                    Environment.DIRECTORY_DOWNLOADS + "/DSH-Go/纸鸢备份");
                            android.net.Uri uri = act.getContentResolver().insert(
                                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                            if (uri == null) throw new Exception("建不了文件");
                            java.io.OutputStream os = act.getContentResolver().openOutputStream(uri);
                            os.write(String.valueOf(text).getBytes("UTF-8"));
                            os.flush(); os.close();
                            path = "Download/DSH-Go/纸鸢备份/" + safe;
                            ok = true;
                        } else {
                            java.io.File dir = new java.io.File(Environment.getExternalStorageDirectory(),
                                    "Download/DSH-Go/纸鸢备份");
                            if (!dir.exists()) dir.mkdirs();
                            java.io.File f = new java.io.File(dir, safe);
                            java.io.FileOutputStream fo = new java.io.FileOutputStream(f);
                            fo.write(String.valueOf(text).getBytes("UTF-8"));
                            fo.flush();
                            try { fo.getFD().sync(); } catch (Exception e2) { }
                            fo.close();
                            path = f.getAbsolutePath();
                            ok = true;
                        }
                    } catch (Exception e) {
                        // 再退一步：应用自己的外部目录（一定能写）
                        try {
                            java.io.File dir = new java.io.File(act.getExternalFilesDir(null), "纸鸢备份");
                            if (!dir.exists()) dir.mkdirs();
                            java.io.File f = new java.io.File(dir, safe);
                            java.io.FileOutputStream fo = new java.io.FileOutputStream(f);
                            fo.write(String.valueOf(text).getBytes("UTF-8"));
                            fo.close();
                            path = f.getAbsolutePath();
                            ok = true;
                        } catch (Exception e3) { path = String.valueOf(e3.getMessage()); ok = false; }
                    }
                    final boolean okf = ok;
                    final String pathf = path;
                    try {
                        act.runOnUiThread(new Runnable() {
                            @Override public void run() {
                                try {
                                    act.web.evaluateJavascript(
                                        "try{window.__exportResult&&window.__exportResult(" + okf + ","
                                        + org.json.JSONObject.quote(pathf) + ")}catch(e){}", null);
                                } catch (Exception e) { }
                            }
                        });
                    } catch (Exception e) { }
                }
            }).start();
        }

        /**
         * 导出二进制（PNG 人设图卡等）到「下载/DSH-Go/纸鸢备份/」。
         * 和 exportFile 同一条落盘路径，只是按 base64 还原字节、用指定 MIME。
         */
        @JavascriptInterface
        public void exportBytes(final String name, final String base64, final String mime) {
            new Thread(new Runnable() {
                @Override public void run() {
                    String safe = String.valueOf(name == null ? "export.png" : name)
                            .replaceAll("[\\/:*?\"<>|]", "_");
                    String mimeType = (mime == null || mime.trim().length() == 0) ? "image/png" : mime.trim();
                    byte[] data;
                    try {
                        data = android.util.Base64.decode(String.valueOf(base64), android.util.Base64.DEFAULT);
                    } catch (Exception e) {
                        final String err = String.valueOf(e.getMessage());
                        act.runOnUiThread(new Runnable() { @Override public void run() {
                            try { act.web.evaluateJavascript("try{window.__exportResult&&window.__exportResult(false," + org.json.JSONObject.quote(err) + ")}catch(e){}", null); } catch (Exception e2) { } } });
                        return;
                    }
                    String path = "";
                    boolean ok = false;
                    try {
                        if (Build.VERSION.SDK_INT >= 29) {
                            android.content.ContentValues cv = new android.content.ContentValues();
                            cv.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, safe);
                            cv.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mimeType);
                            cv.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH,
                                    Environment.DIRECTORY_DOWNLOADS + "/DSH-Go/纸鸢备份");
                            android.net.Uri uri = act.getContentResolver().insert(
                                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                            if (uri == null) throw new Exception("建不了文件");
                            java.io.OutputStream os = act.getContentResolver().openOutputStream(uri);
                            os.write(data);
                            os.flush(); os.close();
                            path = "Download/DSH-Go/纸鸢备份/" + safe;
                            ok = true;
                        } else {
                            java.io.File dir = new java.io.File(Environment.getExternalStorageDirectory(),
                                    "Download/DSH-Go/纸鸢备份");
                            if (!dir.exists()) dir.mkdirs();
                            java.io.File f = new java.io.File(dir, safe);
                            java.io.FileOutputStream fo = new java.io.FileOutputStream(f);
                            fo.write(data);
                            fo.flush();
                            try { fo.getFD().sync(); } catch (Exception e2) { }
                            fo.close();
                            path = f.getAbsolutePath();
                            ok = true;
                        }
                    } catch (Exception e) {
                        try {
                            java.io.File dir = new java.io.File(act.getExternalFilesDir(null), "纸鸢备份");
                            if (!dir.exists()) dir.mkdirs();
                            java.io.File f = new java.io.File(dir, safe);
                            java.io.FileOutputStream fo = new java.io.FileOutputStream(f);
                            fo.write(data);
                            fo.close();
                            path = f.getAbsolutePath();
                            ok = true;
                        } catch (Exception e3) { path = String.valueOf(e3.getMessage()); ok = false; }
                    }
                    final boolean okf = ok;
                    final String pathf = path;
                    try {
                        act.runOnUiThread(new Runnable() {
                            @Override public void run() {
                                try {
                                    act.web.evaluateJavascript(
                                        "try{window.__exportResult&&window.__exportResult(" + okf + ","
                                        + org.json.JSONObject.quote(pathf) + ")}catch(e){}", null);
                                } catch (Exception e) { }
                            }
                        });
                    } catch (Exception e) { }
                }
            }).start();
        }

        /** 自动备份：写到应用私有目录，同名覆盖，不占 Downloads、不需要权限 */
        @JavascriptInterface
        public void exportFilePrivate(final String name, final String text) {
            new Thread(new Runnable() {
                @Override public void run() {
                    boolean ok = false;
                    String path = "";
                    try {
                        String safe = String.valueOf(name == null ? "auto.zybackup.json" : name)
                                .replaceAll("[\\/:*?\"<>|]", "_");
                        java.io.File dir = new java.io.File(act.getFilesDir(), "backups");
                        if (!dir.exists()) dir.mkdirs();
                        java.io.File f = new java.io.File(dir, safe);
                        java.io.File tmp = new java.io.File(f.getAbsolutePath() + ".tmp");
                        java.io.FileOutputStream fo = new java.io.FileOutputStream(tmp);
                        fo.write(String.valueOf(text).getBytes("UTF-8"));
                        fo.flush();
                        try { fo.getFD().sync(); } catch (Exception e2) { }
                        fo.close();
                        if (f.exists()) f.delete();
                        tmp.renameTo(f);
                        path = f.getAbsolutePath();
                        ok = true;
                    } catch (Exception e) { path = String.valueOf(e.getMessage()); }
                    final boolean okf = ok;
                    final String pathf = path;
                    try {
                        act.runOnUiThread(new Runnable() {
                            @Override public void run() {
                                try {
                                    act.web.evaluateJavascript(
                                        "try{window.__exportResult&&window.__exportResult(" + okf + ","
                                        + org.json.JSONObject.quote(pathf) + ")}catch(e){}", null);
                                } catch (Exception e) { }
                            }
                        });
                    } catch (Exception e) { }
                }
            }).start();
        }

        @JavascriptInterface
        public void flushStorage() {
            flushWebViewStorage();
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
                fo.flush();
                try { fo.getFD().sync(); } catch (Exception e2) { }   // 直接落盘，防止被大退杀掉时内容丢失
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

    /* ---------------- 本地用户 / Agent 接入 ---------------- */
    // 真正的 server 在 KeepAliveService 里（前台服务托管），这里只做转发。
    private void startLocalAgent(int port, boolean lan) {
        KeepAliveService.startAgent(this, port, lan);
        KeepAliveService.setListener(agentUi);
    }

    private void stopLocalAgent() {
        KeepAliveService.stopAgent(this);
    }

    private String agentStatusJson() {
        return KeepAliveService.statusJson();
    }

    private void toggleLocalAgent(boolean on, int port, boolean lan) {
        android.content.SharedPreferences sp = getSharedPreferences("paperlite", MODE_PRIVATE);
        int p = port > 0 && port < 65536 ? port : 6721;
        sp.edit().putBoolean("agent_enabled", on).putInt("agent_port", p).putBoolean("agent_lan", lan).commit();
        if (on) {
            startLocalAgent(p, lan);
            askIgnoreBatteryOptimizations();
        } else {
            stopLocalAgent();
        }
    }

    /** 小米/澎湃这类 ROM 会把后台进程冻住，申请一下电池优化豁免，端口才稳 */
    private void askIgnoreBatteryOptimizations() {
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + getPackageName()));
                startActivity(i);
            }
        } catch (Exception e) { }
    }

    private void sendToAgent(String text) {
        KeepAliveService.sendToAgent(text);
    }

    /** 本地会话的显示名：agent 连上来时 hello 里就带这个名字 */
    private void applyAgentName(String name) {
        KeepAliveService.setAgentName(this, name);
    }

    /** 「用户接入」：Agent 用真账号登录服务器，和本地 astrbot 双向转发 */
    private void applyAgentUser(boolean on, String user, String pass, String nick, String avatar,
                                int port, boolean lan) {
        if (!on) { KeepAliveService.stopAgentUser(this); return; }
        String server = "";
        try {
            server = getSharedPreferences("paperlite", MODE_PRIVATE).getString("state", "");
            org.json.JSONObject o = new org.json.JSONObject(server);
            server = o.optString("server", "");
        } catch (Exception e) { }
        if (server.length() == 0) server = "ws://114.55.230.190:8080";
        int p = (port > 0 && port < 65536) ? port : 6722;
        KeepAliveService.startAgentUser(this, server, user, pass, nick, avatar, p, lan);
    }

    @Override
    protected void onResume() {
        super.onResume();
        KeepAliveService.setListener(agentUi);
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
        // WebView 的 localStorage 是异步落盘的，被「大退」杀掉进程时可能来不及写，
        // 这里主动催一下，保证下次启动读得到存档（登录状态靠它）。
        flushWebViewStorage();
        KeepAliveService.setListener(null);
    }

    // WebStorage.flush() 在 API 33 之后从 SDK 里移除了，但老系统上它才是把 localStorage
    // 立刻写盘的那一下。用反射调用：能用就调，不能用就算了（存档另有原生镜像兜底）。
    static void flushWebViewStorage() {
        try {
            Class<?> c = Class.forName("android.webkit.WebStorage");
            Object inst = c.getMethod("getInstance").invoke(null);
            c.getMethod("flush").invoke(inst);
        } catch (Throwable e) { }
        try { CookieManager.getInstance().flush(); } catch (Throwable e) { }
    }

    @Override
    protected void onStop() {
        super.onStop();
        flushWebViewStorage();
    }

    @Override
    protected void onDestroy() {
        // 本地用户开着就别停服务：退出界面后 Agent 还要能连进来。
        // 没开的话保持老行为——关掉界面就不留后台服务。
        KeepAliveService.setListener(null);
        try {
            boolean agentOn = getSharedPreferences("paperlite", MODE_PRIVATE)
                    .getBoolean("agent_enabled", false);
            if (!agentOn) stopService(new Intent(this, KeepAliveService.class));
        } catch (Exception e) { }
        if (web != null) {
            try { web.stopLoading(); } catch (Exception e) { }
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
