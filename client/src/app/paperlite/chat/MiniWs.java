package app.paperlite.chat;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Random;

/**
 * 极小 WebSocket 客户端（只做「用户接入」需要的部分）。
 *
 * - 只处理文本帧；支持分片续帧、ping/pong、close
 * - 客户端必须掩码，这里按要求掩码
 * - 明文 ws://（纸鸢服务器默认就是 ws），不实现 TLS
 */
public class MiniWs {

    public interface Listener {
        void onOpen(MiniWs ws);
        void onText(MiniWs ws, String text);
        void onClosed(MiniWs ws, String why);
    }

    private Socket sock;
    private InputStream in;
    private OutputStream out;
    private Thread reader;
    private volatile boolean closed = false;
    private final Listener listener;

    public MiniWs(Listener l) { this.listener = l; }

    /** 解析 ws://host:port[/path] */
    public static String[] parse(String url) {
        String u = url == null ? "" : url.trim();
        if (u.startsWith("ws://")) u = u.substring(5);
        else if (u.startsWith("wss://")) u = u.substring(6);
        String path = "/";
        int slash = u.indexOf('/');
        if (slash >= 0) { path = u.substring(slash); u = u.substring(0, slash); }
        String host = u, port = "80";
        int colon = u.lastIndexOf(':');
        if (colon > 0) { host = u.substring(0, colon); port = u.substring(colon + 1); }
        return new String[] { host, port, path };
    }

    public void connect(String url, int timeoutMs) throws Exception {
        String[] p = parse(url);
        String host = p[0];
        int port = 80;
        try { port = Integer.parseInt(p[1]); } catch (Exception e) { }
        sock = new Socket();
        sock.connect(new InetSocketAddress(host, port), timeoutMs);
        sock.setTcpNoDelay(true);
        sock.setSoTimeout(0);
        in = sock.getInputStream();
        out = sock.getOutputStream();

        byte[] raw = new byte[16];
        new Random().nextBytes(raw);
        String key = base64(raw);
        String req = "GET " + p[2] + " HTTP/1.1\r\n"
                + "Host: " + host + ":" + port + "\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n"
                + "User-Agent: ZhiYuan-AgentRelay\r\n\r\n";
        out.write(req.getBytes("UTF-8"));
        out.flush();

        StringBuilder head = new StringBuilder();
        int b, matched = 0;
        while ((b = in.read()) >= 0) {
            head.append((char) b);
            if (head.length() > 8192) throw new Exception("握手响应过长");
            if (b == '\n') {
                if (matched >= 1 && head.toString().endsWith("\r\n\r\n")) break;
                matched++;
            }
        }
        String h = head.toString();
        if (h.indexOf("101") < 0) throw new Exception("握手失败：" + firstLine(h));

        closed = false;
        reader = new Thread(new Runnable() {
            @Override public void run() { readLoop(); }
        }, "miniws-read");
        reader.setDaemon(true);
        reader.start();
        if (listener != null) listener.onOpen(this);
    }

    private static String firstLine(String h) {
        int i = h.indexOf('\r');
        return i > 0 ? h.substring(0, i) : h.substring(0, Math.min(60, h.length()));
    }

    private void readLoop() {
        String why = "对端关闭";
        try {
            ByteArray acc = new ByteArray();
            int fragOpcode = 0;
            while (!closed) {
                int b0 = in.read();
                if (b0 < 0) { why = "连接断开"; break; }
                int b1 = in.read();
                if (b1 < 0) { why = "连接断开"; break; }
                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0F;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7F;
                if (len == 126) {
                    len = ((long) readByte() << 8) | readByte();
                } else if (len == 127) {
                    len = 0;
                    for (int i = 0; i < 8; i++) len = (len << 8) | readByte();
                }
                byte[] mask = null;
                if (masked) { mask = new byte[4]; readFully(mask); }
                byte[] payload = new byte[(int) len];
                readFully(payload);
                if (mask != null) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

                if (opcode == 0x8) { why = "服务端关闭"; break; }
                if (opcode == 0x9) { writeFrame(0xA, payload); continue; }
                if (opcode == 0xA) { continue; }
                if (opcode == 0x1) { fragOpcode = 1; acc.reset(); acc.write(payload); }
                else if (opcode == 0x0) { acc.write(payload); }
                else { continue; }

                if (fin && fragOpcode == 1) {
                    String text = new String(acc.toByteArray(), "UTF-8");
                    if (listener != null) {
                        try { listener.onText(this, text); } catch (Exception e) { }
                    }
                }
            }
        } catch (Exception e) {
            why = e.getMessage() == null ? "读失败" : e.getMessage();
        } finally {
            closed = true;
            try { if (sock != null) sock.close(); } catch (Exception e) { }
            if (listener != null) {
                try { listener.onClosed(this, why); } catch (Exception e) { }
            }
        }
    }

    private int readByte() throws Exception {
        int b = in.read();
        if (b < 0) throw new Exception("连接断开");
        return b;
    }

    private void readFully(byte[] buf) throws Exception {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) throw new Exception("连接断开");
            off += n;
        }
    }

    public synchronized void sendText(String text) {
        try {
            if (closed) return;
            writeFrame(0x1, text.getBytes("UTF-8"));
        } catch (Exception e) { }
    }

    private synchronized void writeFrame(int opcode, byte[] payload) throws Exception {
        if (out == null) return;
        int n = payload.length;
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        b.write(0x80 | opcode);
        if (n <= 125) {
            b.write(0x80 | n);
        } else if (n <= 0xFFFF) {
            b.write(0x80 | 126);
            b.write((n >> 8) & 0xFF);
            b.write(n & 0xFF);
        } else {
            b.write(0x80 | 127);
            long l = n;
            for (int i = 7; i >= 0; i--) b.write((int) ((l >> (8 * i)) & 0xFF));
        }
        byte[] mask = new byte[4];
        new Random().nextBytes(mask);
        b.write(mask);
        for (int i = 0; i < n; i++) b.write(payload[i] ^ mask[i % 4]);
        out.write(b.toByteArray());
        out.flush();
    }

    public void close() {
        closed = true;
        try { writeFrame(0x8, new byte[0]); } catch (Exception e) { }
        try { if (sock != null) sock.close(); } catch (Exception e) { }
    }

    public boolean isClosed() { return closed; }

    /* 小工具：base64 / 动态字节数组（避免依赖 Android 的 Base64 类，方便在 JVM 上测） */
    private static final String B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    private static String base64(byte[] d) {
        StringBuilder sb = new StringBuilder();
        int i = 0;
        while (i + 2 < d.length) {
            int n = ((d[i] & 0xFF) << 16) | ((d[i + 1] & 0xFF) << 8) | (d[i + 2] & 0xFF);
            sb.append(B64.charAt((n >> 18) & 63)).append(B64.charAt((n >> 12) & 63))
              .append(B64.charAt((n >> 6) & 63)).append(B64.charAt(n & 63));
            i += 3;
        }
        int rest = d.length - i;
        if (rest == 1) {
            int n = (d[i] & 0xFF) << 16;
            sb.append(B64.charAt((n >> 18) & 63)).append(B64.charAt((n >> 12) & 63)).append("==");
        } else if (rest == 2) {
            int n = ((d[i] & 0xFF) << 16) | ((d[i + 1] & 0xFF) << 8);
            sb.append(B64.charAt((n >> 18) & 63)).append(B64.charAt((n >> 12) & 63))
              .append(B64.charAt((n >> 6) & 63)).append('=');
        }
        return sb.toString();
    }

    private static class ByteArray {
        private byte[] buf = new byte[512];
        private int len = 0;
        void reset() { len = 0; }
        void write(byte[] d) {
            if (len + d.length > buf.length) {
                byte[] nb = new byte[Math.max(buf.length * 2, len + d.length)];
                System.arraycopy(buf, 0, nb, 0, len);
                buf = nb;
            }
            System.arraycopy(d, 0, buf, len, d.length);
            len += d.length;
        }
        byte[] toByteArray() {
            byte[] r = new byte[len];
            System.arraycopy(buf, 0, r, 0, len);
            return r;
        }
    }
}