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
 * 前台服务：让进程活着，并托管两条**互不相干**的 Agent 通道。
 *
 *   本地用户   : 自己的 TCP 端口（默认 6721），消息只在本机会话里
 *   用户接入   : 自己的 TCP 端口（默认 6722） + Agent 的服务器真账号，消息走服务器
 *
 * 两条通道各有各的 server 实例、端口、回调，互不影响：开一条不会改变另一条的收发走向。
 * 前台服务保证进程不被冻结；进程被杀后 START_STICKY 重建，按 SharedPreferences 把两条通道拉回来。
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

    private static KeepAliveService sInst;
    private static LocalAgentServer sLocal;      // 本地用户通道
    private static LocalAgentServer sUser;       // 用户接入通道
    private static AgentUserRelay sRelay;        // 用户接入：Agent 的服务器账号
    private static String sAgentName = "本地用户";
    private static String sUserName = "";        // 显示名
    private static String sUserAccount = "";     // 账号名（两者不再互相覆盖）
    private static Listener sListener;
    private static final ArrayList<String> sPending = new ArrayList<String>();

    /* ================= 静态入口 ================= */

    public static void ensureRunning(Context ctx) {
        try {
            Intent i = new Intent(ctx, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception e) {
            Log.w(TAG, "保活服务启动失败", e);
        }
    }

    /* ---------- 本地用户 ---------- */

    public static synchronized void startAgent(Context ctx, int port, boolean lan) {
        prefs(ctx).edit().putBoolean("agent_enabled", true)
                .putInt("agent_port", port).putBoolean("agent_lan", lan).commit();
        ensureRunning(ctx);
        bringUp(false, port, lan, sAgentName);
        pushStatus();
    }

    public static synchronized void stopAgent(Context ctx) {
        prefs(ctx).edit().putBoolean("agent_enabled", false).commit();
        if (sLocal != null) { try { sLocal.stop(); } catch (Exception e) { } sLocal = null; }
        pushStatus();
    }

    public static synchronized void setAgentName(Context ctx, String name) {
        if (name == null) return;
        String n = name.trim();
        if (n.length() == 0) n = "本地用户";
        if (n.length() > 16) n = n.substring(0, 16);
        sAgentName = n;
        prefs(ctx).edit().putString("agent_name", n).commit();
        if (sLocal != null) sLocal.setBotName(n);
    }

    public static void sendToAgent(String text) {
        LocalAgentServer s = sLocal;
        if (s != null) { try { s.broadcastMessage(text); } catch (Exception e) { } }
    }

    /* ---------- 用户接入 ---------- */

    public static synchronized void startAgentUser(Context ctx, String wsUrl, String user, String pass,
                                                   String nick, String avatar, int port, boolean lan) {
        prefs(ctx).edit().putBoolean("agent_user_on", true)
                .putString("agent_user_url", wsUrl == null ? "" : wsUrl)
                .putString("agent_user_name", user == null ? "" : user)
                .putString("agent_user_pass", pass == null ? "" : pass)
                .putString("agent_user_nick", nick == null ? "" : nick)
                .putString("agent_user_avatar", avatar == null ? "" : avatar)
                .putInt("agent_user_port", port)
                .putBoolean("agent_user_lan", lan).commit();
        ensureRunning(ctx);
        sUserAccount = user == null ? "" : user.trim();
        sUserName = (nick == null || nick.trim().length() == 0) ? sUserAccount : nick.trim();
        bringUp(true, port, lan, sUserName);     // 自己独立的 TCP 端口，不碰本地用户那条

        if (sRelay != null) { try { sRelay.stop(); } catch (Exception e) { } sRelay = null; }
        sRelay = new AgentUserRelay(wsUrl, user, pass, nick, avatar, new AgentUserRelay.Sink() {
            @Override public void pushToAgent(String json) {
                LocalAgentServer s = sUser;      // 只发给「用户接入」那条通道
                if (s != null) s.broadcastRaw(json);
            }
            @Override public void onStatus(String json) { pushStatus(); }
        });
        sRelay.start();
        pushStatus();
    }

    public static synchronized void stopAgentUser(Context ctx) {
        prefs(ctx).edit().putBoolean("agent_user_on", false).commit();
        if (sRelay != null) { try { sRelay.stop(); } catch (Exception e) { } sRelay = null; }
        if (sUser != null) { try { sUser.stop(); } catch (Exception e) { } sUser = null; }
        pushStatus();
    }

    public static synchronized void setListener(Listener l) {
        sListener = l;
        if (l != null && !sPending.isEmpty()) {
            ArrayList<String> copy = new ArrayList<String>(sPending);
            sPending.clear();
            for (int i = 0; i < copy.size(); i++) {
                boolean ok = false;
                try { ok = l.onAgentMessage(copy.get(i), "local"); } catch (Exception e) { }
                if (!ok) {
                    for (int j = i; j < copy.size(); j++) sPending.add(copy.get(j));
                    break;
                }
            }
        }
        pushStatus();
    }

    public static synchronized String statusJson() {
        try {
            JSONObject o = new JSONObject();
            LocalAgentServer l = sLocal;
            o.put("on", l != null && l.isRunning());
            o.put("clients", l == null ? 0 : l.clientCount());
            o.put("port", l == null ? 0 : l.getPort());
            o.put("error", l == null ? "" : l.lastError());
            o.put("user", userStatusJson());
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    private static String userStatusJson() {
        try {
            JSONObject u = new JSONObject();
            LocalAgentServer s = sUser;
            AgentUserRelay r = sRelay;
            u.put("on", s != null && s.isRunning());
            u.put("port", s == null ? 0 : s.getPort());
            u.put("clients", s == null ? 0 : s.clientCount());
            u.put("error", s == null ? "" : s.lastError());
            u.put("ready", r != null && r.isReady());
            u.put("user", sUserAccount);
            u.put("nick", sUserName);
            if (r != null) u.put("relay", r.statusJson());
            return u.toString();
        } catch (Exception e) { return "{}"; }
    }

    /* ================= 两条通道的拉起/自愈 ================= */

    private static synchronized void bringUp(boolean user, int port, boolean lan, String helloName) {
        LocalAgentServer cur = user ? sUser : sLocal;
        if (cur != null && cur.isRunning() && cur.getPort() == port) {
            cur.setBotName(helloName);
            return;
        }
        LocalAgentServer fresh = new LocalAgentServer(port, lan, user ? LISTENER_USER : LISTENER_LOCAL);
        fresh.setBotName(helloName);
        fresh.setChannel(user ? "user" : "local");
        fresh.start();
        if (fresh.isRunning()) {
            if (user) { LocalAgentServer old = sUser; sUser = fresh; if (old != null) { try { old.stop(); } catch (Exception e) { } } }
            else { LocalAgentServer old = sLocal; sLocal = fresh; if (old != null) { try { old.stop(); } catch (Exception e) { } } }
            Log.i(TAG, (user ? "用户接入" : "本地用户") + " 端口 " + port + " 已就绪");
            pushStatus();
            updateNotificationStatic();
            return;
        }
        if (cur != null && cur.isRunning()) {
            Log.w(TAG, "新端口 " + port + " 没绑上，继续用原来的 " + cur.getPort());
            pushStatus();
            return;
        }
        if (user) sUser = fresh; else sLocal = fresh;
        scheduleHeal(user, port, lan, helloName, fresh.lastError());
        pushStatus();
    }

    private static void scheduleHeal(final boolean user, final int port, final boolean lan,
                                     final String helloName, final String err) {
        if (err == null || err.indexOf("in use") < 0) return;
        Thread t = new Thread(new Runnable() {
            @Override public void run() {
                for (int i = 0; i < 6; i++) {
                    try { Thread.sleep(5000); } catch (Exception e) { return; }
                    synchronized (KeepAliveService.class) {
                        LocalAgentServer s = user ? sUser : sLocal;
                        if (s != null && s.isRunning()) return;
                    }
                    Log.i(TAG, (user ? "用户接入" : "本地用户") + " 端口 " + port + " 自愈重试 " + (i + 1));
                    bringUp(user, port, lan, helloName);
                }
            }
        }, "agent-heal");
        t.setDaemon(true);
        t.start();
    }

    private static final LocalAgentServer.Listener LISTENER_LOCAL = new LocalAgentServer.Listener() {
        @Override public void onAgentMessage(String text, String from, String conv, String peer, String room) {
            deliverLocal(text, from);            // 本地用户：只进本机会话
        }
        @Override public void onStatusChanged(int clients, String lastError) {
            pushStatus();
            updateNotificationStatic();
        }
    };

    private static final LocalAgentServer.Listener LISTENER_USER = new LocalAgentServer.Listener() {
        @Override public void onAgentMessage(String text, String from, String conv, String peer, String room) {
            AgentUserRelay r = sRelay;
            if (r != null && r.isReady()) {
                r.sendToServer(text, conv, peer, room);   // 用户接入：只往服务器发
            } else {
                LocalAgentServer s = sUser;
                if (s != null) s.broadcastRaw(MiniJson.flat("type", "error",
                        "text", "用户接入还没连上服务器，这条没发出去"));
            }
        }
        @Override public void onStatusChanged(int clients, String lastError) {
            pushStatus();
            updateNotificationStatic();
        }
    };

    /* ================= 本地会话的消息投递 ================= */

    private static synchronized void deliverLocal(String text, String from) {
        if (sListener != null) {
            boolean ok = false;
            try { ok = sListener.onAgentMessage(text, from); } catch (Exception e) { }
            if (ok) return;
        }
        sPending.add(text);
        while (sPending.size() > 200) sPending.remove(0);
        KeepAliveService inst = sInst;
        if (inst != null) inst.notifyAgentMessage(text);
    }

    private static synchronized void pushStatus() {
        if (sListener == null) return;
        try { sListener.onAgentStatus(statusJson()); } catch (Exception e) { }
    }

    private static void updateNotificationStatic() {
        KeepAliveService inst = sInst;
        if (inst != null) inst.updateNotification();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** 服务被系统重建时，把两条通道按保存的设置拉回来 */
    private static synchronized void autoStartAll(Context ctx) {
        try {
            SharedPreferences sp = prefs(ctx);
            if (sp.getBoolean("agent_enabled", false)) {
                String nm = sp.getString("agent_name", "");
                if (nm != null && nm.length() > 0) sAgentName = nm;
                bringUp(false, sp.getInt("agent_port", 6721), sp.getBoolean("agent_lan", false), sAgentName);
            }
            if (sp.getBoolean("agent_user_on", false)) {
                String url = sp.getString("agent_user_url", "");
                String u = sp.getString("agent_user_name", "");
                sUserAccount = u;
                if (url.length() > 0 && u.length() > 0 && sRelay == null) {
                    startAgentUser(ctx, url, u, sp.getString("agent_user_pass", ""),
                            sp.getString("agent_user_nick", ""), sp.getString("agent_user_avatar", ""),
                            sp.getInt("agent_user_port", 6722), sp.getBoolean("agent_user_lan", false));
                }
            }
        } catch (Exception e) { }
    }

    /* ================= Service 生命周期 ================= */

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
        autoStartAll(this);
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        sInst = null;
        super.onDestroy();
    }

    private void updateNotification() {
        StringBuilder sb = new StringBuilder();
        try {
            LocalAgentServer l = sLocal;
            if (l != null && l.isRunning()) {
                sb.append("本地用户 :").append(l.getPort());
            }
            LocalAgentServer u = sUser;
            if (u != null && u.isRunning()) {
                if (sb.length() > 0) sb.append(" · ");
                sb.append("用户接入 :").append(u.getPort());
            }
        } catch (Exception e) { }
        String text = sb.length() > 0 ? sb.toString() : "保持在线，随时收消息";

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