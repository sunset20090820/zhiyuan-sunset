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
        void onAgentMessage(String text, String from);
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

    public synchronized void start() {
        if (running) return;
        try {
            server = new ServerSocket();
            server.setReuseAddress(true);
            InetAddress addr = InetAddress.getByName(lanBind ? "0.0.0.0" : "127.0.0.1");
            server.bind(new InetSocketAddress(addr, port), 8);
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
            lastError = "端口 " + port + " 打不开：" + e.getMessage();
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
                hello.put("botName", "本地用户");
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
                if ("send".equals(type) || "message".equals(type)) {
                    String text = o.optString("text", "");
                    String from = o.optString("from", "");
                    if (listener != null && text.length() > 0) {
                        try { listener.onAgentMessage(text, from); } catch (Exception e) {}
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
