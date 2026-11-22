package app.paperlite.chat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 极简 JSON：只做「用户接入」需要的解析与拼装。
 * 不依赖 org.json，方便在普通 JVM 上跑单测（App 里和测试里是同一份代码）。
 */
public class MiniJson {

    public static Object parse(String s) {
        if (s == null) return null;
        P p = new P(s);
        p.ws();
        Object v = p.value();
        return v;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> obj(Object o) {
        return (o instanceof Map) ? (Map<String, Object>) o : null;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> arr(Object o) {
        return (o instanceof List) ? (List<Object>) o : null;
    }

    public static String str(Map<String, Object> m, String k, String def) {
        if (m == null) return def;
        Object v = m.get(k);
        if (v == null) return def;
        return String.valueOf(v);
    }

    public static int num(Map<String, Object> m, String k, int def) {
        if (m == null) return def;
        Object v = m.get(k);
        if (v instanceof Number) return ((Number) v).intValue();
        try { return Integer.parseInt(String.valueOf(v)); } catch (Exception e) { return def; }
    }

    public static Map<String, Object> sub(Map<String, Object> m, String k) {
        if (m == null) return null;
        return obj(m.get(k));
    }

    /** 拼字符串：自动转义 */
    public static String quote(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    /** 快速拼一个扁平对象（值只支持字符串/数字/布尔） */
    public static String flat(Object... kv) {
        StringBuilder b = new StringBuilder("{");
        for (int i = 0; i + 1 < kv.length; i += 2) {
            if (i > 0) b.append(',');
            b.append(quote(String.valueOf(kv[i]))).append(':');
            Object v = kv[i + 1];
            if (v instanceof Number || v instanceof Boolean) b.append(String.valueOf(v));
            else b.append(quote(v == null ? null : String.valueOf(v)));
        }
        return b.append('}').toString();
    }

    /* ---------------- 解析器 ---------------- */
    private static class P {
        private final String s;
        private int i = 0;
        P(String s) { this.s = s; }

        void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

        Object value() {
            ws();
            if (i >= s.length()) return null;
            char c = s.charAt(i);
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (c == 't' || c == 'f') return bool();
            if (c == 'n') { i += 4; return null; }
            return number();
        }

        Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            i++; // {
            ws();
            if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
            while (i < s.length()) {
                ws();
                String k = string();
                ws();
                if (i < s.length() && s.charAt(i) == ':') i++;
                Object v = value();
                m.put(k, v);
                ws();
                if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
                if (i < s.length() && s.charAt(i) == '}') { i++; break; }
                break;
            }
            return m;
        }

        List<Object> array() {
            List<Object> l = new ArrayList<Object>();
            i++; // [
            ws();
            if (i < s.length() && s.charAt(i) == ']') { i++; return l; }
            while (i < s.length()) {
                l.add(value());
                ws();
                if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
                if (i < s.length() && s.charAt(i) == ']') { i++; break; }
                break;
            }
            return l;
        }

        String string() {
            StringBuilder b = new StringBuilder();
            if (i < s.length() && s.charAt(i) == '"') i++;
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') break;
                if (c == '\\' && i < s.length()) {
                    char e = s.charAt(i++);
                    switch (e) {
                        case 'n': b.append('\n'); break;
                        case 'r': b.append('\r'); break;
                        case 't': b.append('\t'); break;
                        case 'b': b.append('\b'); break;
                        case 'f': b.append('\f'); break;
                        case 'u':
                            if (i + 4 <= s.length()) {
                                b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                                i += 4;
                            }
                            break;
                        default: b.append(e);
                    }
                } else b.append(c);
            }
            return b.toString();
        }

        Boolean bool() {
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            i++;
            return Boolean.FALSE;
        }

        Number number() {
            int st = i;
            while (i < s.length() && "-+.eE0123456789".indexOf(s.charAt(i)) >= 0) i++;
            String t = s.substring(st, i);
            try {
                if (t.indexOf('.') < 0 && t.indexOf('e') < 0 && t.indexOf('E') < 0) {
                    return Long.parseLong(t);
                }
                return Double.parseDouble(t);
            } catch (Exception e) {
                return 0;
            }
        }
    }
}