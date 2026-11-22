package app.paperlite.chat;

import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * 本地 Agent 接入服务
 *
 * 协议：TCP + 每行一个 JSON（UTF-8，\n 分隔）
 *   服务端 → Agent： {"type":"hello","app":"zhiyuan","ver":"7.2","conv":"local"}
 *                   {"type":"message","text":"...","ts":1690000000000}
 *                   {"type":"pong","ts":...}
 *    Agent → 服务端： {"type":"send","text":"..."}
 *                   {"type":"ping"}
 *
 * 默认只监听 127.0.0.1，避免被公网/局域网的其他机器连上。
 */
public class LocalAgentServer {

    public interface Listener {
        /** conv/peer/room 是「用户接入」用的会话提示；本地模式可忽略 */
        void onAgentMessage(String text, String from, String conv, String peer, String room);
        void onStatusChanged(int clients, String lastError);
    }

    private static final String TAG = "LocalAgent";

    private final int port;
    private final boolean lanBind;
    private final Listener listener;

    private ServerSocket server;
    private Thread acceptThread;
    private volatile boolean running = false;
    private String lastError = "";
    private String botName = "本地用户";
    private String channel = "local";      // local / user，hello 里带上，方便同一个 Agent 区分两条通道
    private String lastClient = "";        // 最近连上来的 Agent：来源地址 + 时间
    private String lastClientName = "";    // Agent 自报的名字（如果它发了 hello/client）
    private final Set<Handler> handlers = Collections.synchronizedSet(new LinkedHashSet<Handler>());

    public LocalAgentServer(int port, boolean lanBind, Listener listener) {
        this.port = port;
        this.lanBind = lanBind;
        this.listener = listener;
    }

    public int getPort() { return port; }
    public boolean isRunning() { return running; }
    public synchronized int clientCount() { return handlers.size(); }
    public synchronized String lastError() { return lastError == null ? "" : lastError; }
    public synchronized void setBotName(String n) {
        if (n != null && n.trim().length() > 0) botName = n.trim();
    }

    /** 最近连上来的 Agent 是谁（来源地址 + 它自报的名字） */
    public synchronized String lastClientInfo() {
        if (lastClient.length() == 0) return "";
        return lastClientName.length() > 0 ? (lastClientName + " @ " + lastClient) : lastClient;
    }

    public synchronized void setChannel(String c) {
        if (c != null && c.trim().length() > 0) channel = c.trim();
    }

    public synchronized void start() {
        if (running) return;
        try {
            Exception last = null;
            boolean bound = false;
            for (int attempt = 0; attempt < 3 && !bound; attempt++) {
                ServerSocket ss = null;
                try {
                    ss = new ServerSocket();
                    ss.setReuseAddress(true);
                    InetAddress addr = InetAddress.getByName(lanBind ? "0.0.0.0" : "127.0.0.1");
                    ss.bind(new InetSocketAddress(addr, port), 8);
                    server = ss;
                    last = null;
                    bound = true;           // 绑定成功就停手，绝不能再来一轮（会把自己顶掉）
                } catch (Exception e) {
                    last = e;
                    try { if (ss != null) ss.close(); } catch (Exception e2) { }
                    try { Thread.sleep(400); } catch (Exception e3) { }
                }
            }
            if (!bound || last != null) throw last != null ? last : new Exception("绑定失败");
            running = true;
            lastError = "";
            acceptThread = new Thread(new Runnable() {
                @Override public void run() { acceptLoop(); }
            }, "local-agent-accept");
            acceptThread.setDaemon(true);
            acceptThread.start();
            notifyStatus();
            Log.i(TAG, "本地 Agent 端口已开启 " + (lanBind ? "0.0.0.0:" : "127.0.0.1:") + port);
        } catch (Exception e) {
            lastError = "端口 " + port + " 打不开：" + e.getMessage()
                    + (String.valueOf(e.getMessage()).indexOf("in use") >= 0
                       ? "（这个端口已被别的程序占用；换个端口，或先关掉占用它的程序）" : "");
            running = false;
            Log.w(TAG, "启动失败", e);
            notifyStatus();
        }
    }

    public synchronized void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (Exception e) {}
        server = null;
        synchronized (handlers) {
            for (Handler h : new java.util.ArrayList<Handler>(handlers)) h.close();
            handlers.clear();
        }
        notifyStatus();
        Log.i(TAG, "本地 Agent 端口已关闭");
    }

    /** 直接往所有已连接的 Agent 推一行 JSON（「用户接入」用它把服务器消息转给 astrbot） */
    public void broadcastRaw(String line) {
        if (line != null) broadcast(line);
    }

    /** 把 App 里用户说的话发给所有已连接的 Agent */
    public void broadcastMessage(String text) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", "message");
            o.put("text", text == null ? "" : text);
            o.put("ts", System.currentTimeMillis());
            broadcast(o.toString());
        } catch (Exception e) { }
    }

    private void broadcast(String line) {
        synchronized (handlers) {
            for (Handler h : new java.util.ArrayList<Handler>(handlers)) h.send(line);
        }
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket sock = server.accept();
                try {
                    java.net.InetAddress ra = sock.getInetAddress();
                    lastClient = (ra == null ? "?" : ra.getHostAddress()) + ":" + sock.getPort()
                            + " · " + new java.text.SimpleDateFormat("HH:mm:ss").format(new java.util.Date());
                } catch (Exception e) { }
                Handler h = new Handler(sock);
                handlers.add(h);
                Thread t = new Thread(h, "local-agent-client");
                t.setDaemon(true);
                t.start();
                notifyStatus();
            } catch (Exception e) {
                if (running) {
                    lastError = "接受连接失败：" + e.getMessage();
                    notifyStatus();
                }
                break;
            }
        }
    }

    private void notifyStatus() {
        if (listener != null) {
            try { listener.onStatusChanged(clientCount(), lastError()); } catch (Exception e) {}
        }
    }

    private class Handler implements Runnable {
        private final Socket sock;
        private BufferedReader in;
        private BufferedWriter out;

        Handler(Socket s) { this.sock = s; }

        @Override public void run() {
            try {
                sock.setTcpNoDelay(true);
                in = new BufferedReader(new InputStreamReader(sock.getInputStream(), "UTF-8"));
                out = new BufferedWriter(new OutputStreamWriter(sock.getOutputStream(), "UTF-8"));
                JSONObject hello = new JSONObject();
                hello.put("type", "hello");
                hello.put("app", "zhiyuan");
                hello.put("conv", "local");
                hello.put("botName", botName);
                hello.put("channel", channel);
                send(hello.toString());
                String line;
                while ((line = in.readLine()) != null) {
                    if (line.trim().length() == 0) continue;
                    handleLine(line);
                }
            } catch (Exception e) {
                Log.w(TAG, "连接断开: " + e.getMessage());
            } finally {
                close();
                handlers.remove(this);
                notifyStatus();
            }
        }

        private void handleLine(String line) {
            try {
                JSONObject o = new JSONObject(line);
                String type = o.optString("type", "");
                if ("hello".equals(type) || "identify".equals(type)) {
                    String who = o.optString("client", o.optString("name", ""));
                    if (who.length() > 0) {
                        lastClientName = who.length() > 24 ? who.substring(0, 24) : who;
                        notifyStatus();
                    }
                    return;
                }
                if ("send".equals(type) || "message".equals(type)) {
                    String text = o.optString("text", "");
                    String from = o.optString("from", "");
                    String conv = o.optString("conv", "");
                    String peer = o.optString("peer", "");
                    String room = o.optString("room", "");
                    if (listener != null && text.length() > 0) {
                        try { listener.onAgentMessage(text, from, conv, peer, room); } catch (Exception e) {}
                    }
                } else if ("ping".equals(type)) {
                    JSONObject pong = new JSONObject();
                    pong.put("type", "pong");
                    pong.put("ts", System.currentTimeMillis());
                    send(pong.toString());
                }
            } catch (Exception e) {
                Log.w(TAG, "非法消息: " + line);
            }
        }

        void send(String line) {
            try {
                if (out == null) return;
                out.write(line);
                out.write("\n");
                out.flush();
            } catch (Exception e) { }
        }

        void close() {
            try { sock.close(); } catch (Exception e) {}
        }
    }
}
