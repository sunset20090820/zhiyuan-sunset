package app.paperlite.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONObject;

import java.util.ArrayList;

/**
 * 前台服务：让进程活着 + 托管「本地用户」的 TCP 服务。
 *
 * 之前 LocalAgentServer 建在 MainActivity 里，页面一销毁/退后台被系统冻结，端口虽然还
 * 被 bind 着（别的程序于是看到「端口被占用」），但 accept 线程冻住不跑，Agent 连上来
 * 永远收不到 hello —— 表现就是「接不进去」。
 *
 * 现在把 server 放在这个前台服务里：
 *   - 服务是前台服务，进程不会被当成 cached 进程冻结；
 *   - server 是进程级静态对象，页面销毁不影响；
 *   - 进程被杀后服务 START_STICKY 自动重建，并按 SharedPreferences 自动把端口重新拉起；
 *   - Agent 的消息在页面不在时进队列，页面回来后补发；同时发一条通知，免得漏消息。
 */
public class KeepAliveService extends Service {

    private static final String TAG = "PaperAlive";
    private static final String CH = "alive";
    private static final String CH_MSG = "localmsg";
    private static final int ID = 41;
    private static final int ID_MSG = 42;
    private static final String PREFS = "paperlite";

    /** 给界面（WebView）回调用的接口 */
    public interface Listener {
        /** 返回 false 表示页面还没准备好（比如 WebView 还没加载完），消息留在队列里 */ 
        boolean onAgentMessage(String text, String from);
        void onAgentStatus(String json);
    }

    private static KeepAliveService sInst;                 // 只为发通知方便
    private static LocalAgentServer sServer;               // 进程级，页面销毁也活着
    private static String sAgentName = "本地用户";           // 本地会话显示名（hello 里用）
    private static AgentUserRelay sRelay;                  // 「用户接入」：Agent 的真账号通道
    private static Listener sListener;
    private static final ArrayList<String> sPending = new ArrayList<String>();

    /* ---------------- 静态入口：给 MainActivity / Bridge 用 ---------------- */

    public static void ensureRunning(Context ctx) {
        try {
            Intent i = new Intent(ctx, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception e) {
            Log.w(TAG, "保活服务启动失败", e);
        }
    }

    public static synchronized void setAgentName(Context ctx, String name) {
        if (name == null) return;
        String n = name.trim();
        if (n.length() == 0) n = "本地用户";
        if (n.length() > 16) n = n.substring(0, 16);
        sAgentName = n;
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
               .edit().putString("agent_name", n).commit();
        } catch (Exception e) { }
        LocalAgentServer s = sServer;
        if (s != null) s.setBotName(n);
    }

    public static synchronized void startAgent(Context ctx, int port, boolean lan) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            sp.edit().putBoolean("agent_enabled", true)
                     .putInt("agent_port", port)
                     .putBoolean("agent_lan", lan).commit();
        } catch (Exception e) { }
        ensureRunning(ctx);
        startServer(port, lan);
    }

    public static synchronized void stopAgent(Context ctx) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            sp.edit().putBoolean("agent_enabled", false).commit();
        } catch (Exception e) { }
        stopServer();
        pushStatus();
    }

    public static void sendToAgent(String text) {
        LocalAgentServer s = sServer;
        if (s != null) {
            try { s.broadcastMessage(text); } catch (Exception e) { }
        }
    }

    public static synchronized String statusJson() {
        try {
            JSONObject o = new JSONObject();
            LocalAgentServer s = sServer;
            o.put("on", s != null && s.isRunning());
            o.put("clients", s == null ? 0 : s.clientCount());
            o.put("port", s == null ? 0 : s.getPort());
            o.put("error", s == null ? "" : s.lastError());
            AgentUserRelay r = sRelay;
            o.put("user", r == null ? "{}" : r.statusJson());
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    /** 页面(onResume)注册，onPause 注销；注册时把攒下的消息补发 */
    public static synchronized void setListener(Listener l) {
        sListener = l;
        if (l != null && !sPending.isEmpty()) {
            ArrayList<String> copy = new ArrayList<String>(sPending);
            sPending.clear();
            for (int i = 0; i < copy.size(); i++) {
                boolean ok = false;
                try { ok = l.onAgentMessage(copy.get(i), "local"); } catch (Exception e) { }
                if (!ok) {                       // 还没准备好，剩下的下次再补
                    for (int j = i; j < copy.size(); j++) sPending.add(copy.get(j));
                    break;
                }
            }
        }
        pushStatus();
    }

    /* ---------------- 内部 ---------------- */

    private static synchronized void startServer(int port, boolean lan) {
        if (sServer != null && sServer.isRunning() && sServer.getPort() == port) return;
        // 先把新端口绑起来，绑成功再撤旧的：换端口失败时不至于把好的那条也关掉
        final int p2 = port;
        LocalAgentServer fresh = new LocalAgentServer(port, lan, LISTENER);
        fresh.setBotName(sAgentName);
        fresh.start();
        if (fresh.isRunning()) {
            LocalAgentServer old = sServer;
            sServer = fresh;
            if (old != null) { try { old.stop(); } catch (Exception e) { } }
            afterServerUp(p2);
            return;
        }
        if (sServer != null && sServer.isRunning()) {
            Log.w(TAG, "新端口 " + port + " 没绑上，继续用原来的 " + sServer.getPort());
            pushStatus();
            return;
        }
        sServer = fresh;                  // 都没绑上：留着报错，并排队自愈
        scheduleHeal(p2, lan, fresh.lastError());
        pushStatus();
    }

    /** 端口可能还在 TIME_WAIT（刚关过/刚换过），隔几秒自己再试几次 */
    private static void scheduleHeal(final int port, final boolean lan, final String err) {
        if (err == null || err.indexOf("in use") < 0) return;
        Thread t = new Thread(new Runnable() {
            @Override public void run() {
                for (int i = 0; i < 6; i++) {
                    try { Thread.sleep(5000); } catch (Exception e) { return; }
                    synchronized (KeepAliveService.class) {
                        if (sServer != null && sServer.isRunning()) return;
                    }
                    Log.i(TAG, "端口 " + port + " 自愈重试第 " + (i + 1) + " 次");
                    startServer(port, lan);
                    synchronized (KeepAliveService.class) {
                        if (sServer != null && sServer.isRunning()) return;
                    }
                }
            }
        }, "local-agent-heal");
        t.setDaemon(true);
        t.start();
    }

    private static void afterServerUp(int port) {
        Log.i(TAG, "本地用户端口 " + port + " 已托管在前台服务");
        pushStatus();
        KeepAliveService inst = sInst;
        if (inst != null) inst.updateNotification();
    }

    private static final LocalAgentServer.Listener LISTENER = new LocalAgentServer.Listener() {
        @Override public void onAgentMessage(String text, String from, String conv, String peer, String room) {
            deliverFromAgent(text, from, conv, peer, room);
        }
        @Override public void onStatusChanged(int clients, String lastError) {
            pushStatus();
            KeepAliveService inst = sInst;
            if (inst != null) inst.updateNotification();
        }
    };

    private static synchronized void stopServer() {
        if (sServer != null) {
            try { sServer.stop(); } catch (Exception e) { }
            sServer = null;
        }
    }

    /** Agent 说的话：开了「用户接入」就发到服务器，否则显示在本地会话里 */
    private static synchronized void deliverFromAgent(String text, String from,
                                                     String conv, String peer, String room) {
        AgentUserRelay r = sRelay;
        if (r != null && r.isReady()) {
            r.sendToServer(text, conv, peer, room);
            return;
        }
        deliver(text, from);
    }

    /* ---------------- 用户接入（Agent 作为真账号） ---------------- */

    public static synchronized void startAgentUser(Context ctx, String wsUrl, String user, String pass,
                                                   String nick, String avatar) {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
               .putBoolean("agent_user_on", true)
               .putString("agent_user_url", wsUrl == null ? "" : wsUrl)
               .putString("agent_user_name", user == null ? "" : user)
               .putString("agent_user_pass", pass == null ? "" : pass)
               .putString("agent_user_nick", nick == null ? "" : nick)
               .putString("agent_user_avatar", avatar == null ? "" : avatar)
               .commit();
        } catch (Exception e) { }
        ensureRunning(ctx);
        // 「用户接入」靠本地 TCP 跟 astrbot 通话，所以端口必须开着
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            int port = sp.getInt("agent_port", 6721);
            boolean lan = sp.getBoolean("agent_lan", false);
            if (sServer == null || !sServer.isRunning()) startServer(port, lan);
        } catch (Exception e) { }
        stopRelay();
        sRelay = new AgentUserRelay(wsUrl, user, pass, nick, avatar, new AgentUserRelay.Sink() {
            @Override public void pushToAgent(String json) {
                LocalAgentServer s = sServer;
                if (s != null) s.broadcastRaw(json);
            }
            @Override public void onStatus(String json) {
                pushStatus();
            }
        });
        sRelay.start();
        pushStatus();
    }

    public static synchronized void stopAgentUser(Context ctx) {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
               .edit().putBoolean("agent_user_on", false).commit();
        } catch (Exception e) { }
        stopRelay();
        pushStatus();
    }

    private static synchronized void stopRelay() {
        if (sRelay != null) {
            try { sRelay.stop(); } catch (Exception e) { }
            sRelay = null;
        }
    }

    /** 服务重建时按保存的设置把「用户接入」也拉起来 */
    private static synchronized void autoStartRelayIfEnabled(Context ctx) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (!sp.getBoolean("agent_user_on", false)) return;
            String url = sp.getString("agent_user_url", "");
            String u = sp.getString("agent_user_name", "");
            if (url.length() == 0 || u.length() == 0) return;
            if (sRelay != null) return;
            startAgentUser(ctx, url, u, sp.getString("agent_user_pass", ""),
                    sp.getString("agent_user_nick", ""), sp.getString("agent_user_avatar", ""));
        } catch (Exception e) { }
    }

    private static synchronized void deliver(String text, String from) {
        if (sListener != null) {
            boolean ok = false;
            try { ok = sListener.onAgentMessage(text, from); } catch (Exception e) { }
            if (ok) return;
        }
        // 页面不在：先存着，再发通知，别让人漏消息
        sPending.add(text);
        while (sPending.size() > 200) sPending.remove(0);
        KeepAliveService inst = sInst;
        if (inst != null) inst.notifyAgentMessage(text);
    }

    private static synchronized void pushStatus() {
        if (sListener == null) return;
        try { sListener.onAgentStatus(statusJson()); } catch (Exception e) { }
    }

    /** 服务被系统重建时（进程重启过），按保存的设置自动把端口拉起来 */
    private static synchronized void autoStartIfEnabled(Context ctx) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (!sp.getBoolean("agent_enabled", false)) return;
            int port = sp.getInt("agent_port", 6721);
            boolean lan = sp.getBoolean("agent_lan", false);
            String nm = sp.getString("agent_name", "");
            if (nm != null && nm.length() > 0) sAgentName = nm;
            if (sServer == null || !sServer.isRunning()) startServer(port, lan);
        } catch (Exception e) { }
    }

    /* ---------------- Service 生命周期 ---------------- */

    @Override
    public void onCreate() {
        super.onCreate();
        sInst = this;
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                NotificationChannel alive = new NotificationChannel(CH, "保持连接", NotificationManager.IMPORTANCE_LOW);
                alive.setShowBadge(false);
                alive.setSound(null, null);
                nm.createNotificationChannel(alive);
                NotificationChannel msg = new NotificationChannel(CH_MSG, "本地用户消息", NotificationManager.IMPORTANCE_DEFAULT);
                msg.setShowBadge(true);
                nm.createNotificationChannel(msg);
            }
        } catch (Exception e) { }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        updateNotification();
        autoStartIfEnabled(this);
        autoStartRelayIfEnabled(this);
        return START_STICKY;   // 被系统杀掉后自动重建，端口跟着回来
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        sInst = null;
        super.onDestroy();
    }

    private void updateNotification() {
        String text = "保持在线，随时收消息";
        try {
            LocalAgentServer s = sServer;
            if (s != null && s.isRunning()) {
                text = "本地用户 · 监听 " + (s.getPort()) + " · "
                        + (s.clientCount() > 0 ? (s.clientCount() + " 个 Agent 已连接") : "等待 Agent");
            }
        } catch (Exception e) { }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CH)
                : new Notification.Builder(this);
        b.setContentTitle("纸鸢").setContentText(text)
         .setSmallIcon(R.mipmap.ic_launcher).setOngoing(true);
        Notification n = b.build();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(ID, n);
            }
        } catch (Exception e) {
            try { startForeground(ID, n); } catch (Exception e2) { }
        }
    }

    private void notifyAgentMessage(String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            open.putExtra("jump", "dm:local");
            PendingIntent pi = PendingIntent.getActivity(this, 3, open,
                    Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                                                : PendingIntent.FLAG_UPDATE_CURRENT);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CH_MSG)
                    : new Notification.Builder(this);
            b.setContentTitle("本地用户").setContentText(text)
             .setSmallIcon(R.mipmap.ic_launcher).setContentIntent(pi)
             .setAutoCancel(true);
            nm.notify(ID_MSG, b.build());
        } catch (Exception e) { }
    }
}