package app.paperlite.chat;

import java.util.List;
import java.util.Map;

/**
 * 「用户接入」：把 Agent 当成服务器上的一个真账号。
 *
 * 链路：本地 astrbot ←TCP→ 纸鸢 ←WebSocket(Agent 账号)→ 聊天服务器
 *
 * 路由规则（用户选定）：
 *   - 谁私聊它 → 回给谁
 *   - 群里只有被 @ 才回，回到那个群
 *   - astrbot 发来的消息如果没带 conv，就按「最近一次收到的会话」回复
 *
 * 消息天然两边都有：本地 TCP 一份（astrbot 日志），服务器聊天记录一份。
 */
public class AgentUserRelay {

    public interface Sink {
        void pushToAgent(String json);   // 转给本地 astrbot
        void onStatus(String json);      // 状态变化，给界面
    }

    private final String wsUrl;
    private final String user;
    private final String pass;
    private final String nick;
    private final String avatar;
    private final String devId;
    private final Sink sink;

    private volatile MiniWs ws;
    private volatile boolean want = true;
    private volatile boolean ready = false;
    private volatile boolean registered = false;
    private volatile boolean avatarSent = false;
    private volatile String lastError = "";
    private volatile String myId = "";
    private volatile int myUid = 0;
    private volatile String curRoom = "lobby";
    private volatile String lastConv = "";
    private volatile String lastPeer = "";
    private volatile String lastRoom = "";
    private final Map<String, String> peerDev = new java.util.concurrent.ConcurrentHashMap<String, String>();
    private final java.util.LinkedHashSet<String> seenIds = new java.util.LinkedHashSet<String>();
    private Thread loop;

    public AgentUserRelay(String wsUrl, String user, String pass, String nick, String avatar, Sink sink) {
        this.wsUrl = wsUrl;
        this.user = user == null ? "" : user.trim();
        this.pass = pass == null ? "" : pass;
        this.nick = (nick == null || nick.trim().length() == 0) ? this.user : nick.trim();
        this.avatar = avatar == null ? "" : avatar;
        this.sink = sink;
        this.devId = hex32("agent:" + this.user);
    }

    private static String hex32(String s) {
        long h1 = 1125899906842597L, h2 = 1469598103934665603L;
        for (int i = 0; i < s.length(); i++) {
            h1 = h1 * 31 + s.charAt(i);
            h2 = (h2 ^ s.charAt(i)) * 1099511628211L;
        }
        String a = Long.toHexString(h1), b = Long.toHexString(h2);
        while (a.length() < 16) a = "0" + a;
        while (b.length() < 16) b = "0" + b;
        return (a.substring(a.length() - 16) + b.substring(b.length() - 16)).toLowerCase();
    }

    public boolean isReady() { return ready; }

    public String statusJson() {
        return MiniJson.flat("on", want, "ready", ready, "user", user, "nick", nick,
                "error", lastError, "conv", lastConv, "room", curRoom);
    }

    private void status() {
        if (sink != null) {
            try { sink.onStatus(statusJson()); } catch (Exception e) { }
        }
    }

    public void start() {
        if (loop != null) return;
        want = true;
        loop = new Thread(new Runnable() {
            @Override public void run() { runLoop(); }
        }, "agent-user-relay");
        loop.setDaemon(true);
        loop.start();
    }

    public void stop() {
        want = false;
        ready = false;
        try { if (ws != null) ws.close(); } catch (Exception e) { }
        status();
    }

    private void runLoop() {
        long backoff = 1000;
        while (want) {
            MiniWs c = null;
            try {
                c = new MiniWs(new MiniWs.Listener() {
                    @Override public void onOpen(MiniWs w) { handleOpen(w); }
                    @Override public void onText(MiniWs w, String text) { handleServerText(text); }
                    @Override public void onClosed(MiniWs w, String why) {
                        ready = false;
                        if (want) lastError = "连接断开：" + why;
                        status();
                    }
                });
                ws = c;
                lastError = "";
                c.connect(wsUrl, 8000);
                backoff = 1000;
                while (want && !c.isClosed()) {
                    try { Thread.sleep(300); } catch (Exception e) { }
                }
            } catch (Exception e) {
                ready = false;
                lastError = "连不上服务器：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
                status();
            } finally {
                try { if (c != null) c.close(); } catch (Exception e) { }
                ws = null;
                ready = false;
            }
            if (!want) break;
            try { Thread.sleep(backoff); } catch (Exception e) { }
            backoff = Math.min(backoff * 2, 15000);
        }
        status();
    }

    private void handleOpen(MiniWs w) {
        w.sendText(MiniJson.flat("t", "login", "user", user, "pass", pass, "device", devId));
    }

    private void handleServerText(String raw) {
        Map<String, Object> d = MiniJson.obj(MiniJson.parse(raw));
        if (d == null) return;
        String t = MiniJson.str(d, "t", "");

        if ("auth".equals(t)) {
            Object okv = d.get("ok");
            boolean ok = Boolean.TRUE.equals(okv) || "true".equals(String.valueOf(okv));
            if (ok) {
                myUid = MiniJson.num(d, "uid", myUid);
                afterLogin();
                return;
            }
            String err = MiniJson.str(d, "err", "登录失败");
            if (!registered && err.indexOf("没有这个账号") >= 0) {
                // 第一次：账号还不存在，顺手注册（密保问题固定，答案就是密码，方便找回）
                registered = true;
                send(MiniJson.flat("t", "register", "user", user, "pass", pass, "nick", nick,
                        "question", "纸鸢Agent接入", "answer", pass, "device", devId));
                lastError = "正在创建账号…";
                status();
                return;
            }
            lastError = err;
            status();
            return;
        }

        if ("welcome".equals(t)) {
            Map<String, Object> you = MiniJson.sub(d, "you");
            String id = MiniJson.str(you, "id", "");
            if (id.length() > 0) myId = id;
            String rm = MiniJson.str(d, "room", "");
            if (rm.length() > 0) curRoom = rm;
            return;
        }

        if ("pm".equals(t)) {
            Map<String, Object> msg = MiniJson.sub(d, "msg");
            if (msg == null) return;
            String fromId = MiniJson.str(msg, "from", "");
            String peer = fromId.length() > 0 ? fromId : MiniJson.str(d, "with", "");
            String text = MiniJson.str(msg, "text", "");
            if (text.length() == 0) return;
            if (isSelf(fromId, MiniJson.str(msg, "deviceId", ""))) return;
            if (!firstTime(MiniJson.str(msg, "id", ""))) return;
            lastConv = "pm";
            lastPeer = peer;
            if (peer.length() > 0 && !peerDev.containsKey(peer)) {
                send(MiniJson.flat("t", "pm_open", "with", peer));   // 换成设备号，回复才能实时送达
            }
            pushAgent(text, MiniJson.str(msg, "name", peer), "pm", peer, MiniJson.str(d, "room", ""));
            return;
        }

        if ("msg".equals(t) || "group_msg".equals(t)) {
            Map<String, Object> msg = MiniJson.sub(d, "msg");
            if (msg == null) return;
            String room = MiniJson.str(msg, "room", MiniJson.str(d, "room", curRoom));
            String text = MiniJson.str(msg, "text", "");
            if (text.length() == 0) return;
            if (isSelf(MiniJson.str(msg, "from", ""), MiniJson.str(msg, "deviceId", ""))) return;
            if (!firstTime(MiniJson.str(msg, "id", ""))) return;
            if (!mentioned(msg, text)) return;     // 群里只在被 @ 时转给 Agent
            lastConv = "room";
            lastRoom = room;
            pushAgent(text, MiniJson.str(msg, "name", ""), "room", "", room);
            return;
        }

        if ("pm_history".equals(t)) {
            Map<String, Object> peer = MiniJson.sub(d, "peer");
            if (peer != null) {
                String dev = MiniJson.str(peer, "dev", "");
                String pid = MiniJson.str(peer, "id", "");
                int puid = MiniJson.num(peer, "uid", 0);
                if (dev.length() > 0) {
                    if (pid.length() > 0) peerDev.put(pid, dev);
                    if (puid > 0) peerDev.put("uid:" + puid, dev);
                    String with = MiniJson.str(d, "with", "");
                    if (with.length() > 0) peerDev.put(with, dev);
                }
            }
            return;
        }

        if ("error".equals(t)) {
            String m = MiniJson.str(d, "message", "");
            if (m.length() > 0) { lastError = m; status(); }
            return;
        }
    }

    private void afterLogin() {
        // 登录成功：进大厅（拿到自己的 id 和房间列表），再把头像推上去
        send(MiniJson.flat("t", "join", "name", nick, "room", curRoom, "device", devId));
        if (!avatarSent && avatar.length() > 20) {
            avatarSent = true;
            send(MiniJson.flat("t", "avatar_set", "data", avatar));
        }
        ready = true;
        lastError = "";
        status();
    }

    /** 同一条消息只转一次（断线重连、历史补发都可能重复投递） */
    private boolean firstTime(String id) {
        if (id == null || id.length() == 0) return true;
        synchronized (seenIds) {
            if (seenIds.contains(id)) return false;
            seenIds.add(id);
            if (seenIds.size() > 200) {
                java.util.Iterator<String> it = seenIds.iterator();
                if (it.hasNext()) { it.next(); it.remove(); }
            }
            return true;
        }
    }

    /** 是不是自己发的：自己的消息不能再转回 Agent，否则会自问自答死循环 */
    private boolean isSelf(String from, String deviceId) {
        if (from != null && from.length() > 0) {
            if (from.equals(myId)) return true;
            if (myUid > 0 && from.equals("uid:" + myUid)) return true;
        }
        if (deviceId != null && deviceId.length() > 0 && deviceId.equals(devId)) return true;
        return false;
    }

    private boolean mentioned(Map<String, Object> msg, String text) {
        List<Object> ms = MiniJson.arr(msg.get("mentions"));
        if (ms != null) {
            for (int i = 0; i < ms.size(); i++) {
                Map<String, Object> m = MiniJson.obj(ms.get(i));
                String id = MiniJson.str(m, "id", "");
                if (id.length() > 0 && id.equals(myId)) return true;
                String nm = MiniJson.str(m, "name", "");
                if (nm.length() > 0 && nm.equals(nick)) return true;
            }
        }
        return text.indexOf("@" + nick) >= 0;
    }

    private void pushAgent(String text, String fromName, String conv, String peer, String room) {
        if (sink == null) return;
        try {
            sink.pushToAgent(MiniJson.flat("type", "message", "text", text, "from", peer,
                    "name", fromName, "conv", conv, "peer", peer, "room", room,
                    "ts", System.currentTimeMillis()));
        } catch (Exception e) { }
    }

    private void send(String json) {
        MiniWs w = ws;
        if (w == null) return;
        w.sendText(json);
    }

    /**
     * astrbot → 服务器。
     * conv 为空时按「最近一次收到的会话」回复（私聊回私聊、群里回群）。
     */
    public synchronized boolean sendToServer(String text, String conv, String peer, String room) {
        if (text == null || text.trim().length() == 0) return false;
        MiniWs w = ws;
        if (w == null || !ready) {
            lastError = "用户接入还没连上服务器";
            status();
            return false;
        }
        String c = conv == null ? "" : conv.trim();
        if (c.length() == 0) c = lastConv.length() == 0 ? "pm" : lastConv;

        if ("room".equals(c)) {
            String target = (room != null && room.length() > 0) ? room
                    : (lastRoom.length() > 0 ? lastRoom : curRoom);
            if (target.length() > 0 && !target.equals(curRoom)) {
                curRoom = target;
                w.sendText(MiniJson.flat("t", "room", "room", target));
            }
            w.sendText(MiniJson.flat("t", "msg", "text", text));
            return true;
        }

        String to = (peer != null && peer.length() > 0) ? peer : lastPeer;
        if (to.length() > 0) {
            String dev = peerDev.get(to);
            if (dev != null && dev.length() > 0) to = dev;
        }
        if (to.length() == 0) {
            lastError = "没有可回复的对象（先等对方私聊一句）";
            status();
            return false;
        }
        w.sendText(MiniJson.flat("t", "pm", "to", to, "text", text));
        return true;
    }
}