/*
 * S5 Tunnel 轻量客户端 (Java) —— 本地 SOCKS5 ⇄ WebSocket ⇄ 服务器
 * S5 Tunnel lightweight client (Java) — local SOCKS5 ⇄ WebSocket ⇄ server
 *
 * 零依赖，Java 11+（使用 JDK 内置 java.net.http.WebSocket），单文件直接运行：
 * Zero dependencies, Java 11+ (built-in java.net.http.WebSocket), single-file launch:
 *
 *   java Socks5WsClient.java --server wss://example.com/tunnel --uuid <UUID> --listen 127.0.0.1:1080
 *
 * 协议：VLESS over WebSocket（与 v2rayN / v2rayNG / Shadowrocket / Clash Meta 等客户端兼容）。
 */
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public class Socks5WsClient {
    static String SERVER = "__SERVER__";
    static String UUID_STR = "__UUID__";
    static String LISTEN = "127.0.0.1:1080";
    static boolean VERBOSE = false;
    static byte[] UUID_BYTES;
    static final AtomicInteger ACTIVE = new AtomicInteger();
    static final byte[] SOCKS_OK = {5, 0, 0, 1, 0, 0, 0, 0, 0, 0};

    static byte[] socksFail(int code) { return new byte[]{5, (byte) code, 0, 1, 0, 0, 0, 0, 0, 0}; }

    static String envOr(String key, String fallback) {
        String v = System.getenv(key);
        return v == null || v.isEmpty() ? fallback : v;
    }

    static void log(String s) { if (VERBOSE) System.err.println(s); }

    public static void main(String[] args) throws Exception {
        SERVER = envOr("S5_SERVER", SERVER);
        UUID_STR = envOr("S5_UUID", UUID_STR);
        LISTEN = envOr("S5_LISTEN", LISTEN);
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--server": SERVER = args[++i]; break;
                case "--uuid": UUID_STR = args[++i]; break;
                case "--listen": LISTEN = args[++i]; break;
                case "-v": case "--verbose": VERBOSE = true; break;
                default: break;
            }
        }
        if (SERVER.startsWith("__") || UUID_STR.startsWith("__")) {
            System.err.println("用法: java Socks5WsClient.java --server wss://host/tunnel --uuid <UUID> [--listen 127.0.0.1:1080]");
            System.exit(1);
        }
        if (!UUID_STR.matches("[0-9a-fA-F-]{36}")) {
            System.err.println("UUID 格式不正确");
            System.exit(1);
        }
        String hex = UUID_STR.replace("-", "");
        UUID_BYTES = new byte[16];
        for (int i = 0; i < 16; i++) UUID_BYTES[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);

        int idx = LISTEN.lastIndexOf(':');
        String host = idx > 0 ? LISTEN.substring(0, idx) : "127.0.0.1";
        int port = Integer.parseInt(LISTEN.substring(idx + 1));
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
        ExecutorService pool = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "socks");
            t.setDaemon(true);
            return t;
        });
        try (ServerSocket ss = new ServerSocket()) {
            ss.bind(new InetSocketAddress(host, port));
            System.out.println("✔ SOCKS5 代理已启动: socks5://" + host + ":" + port);
            System.out.println("  服务器: " + SERVER);
            System.out.println("  UUID  : " + UUID_STR.substring(0, 8) + "…");
            System.out.println("  把浏览器/系统代理设置为 SOCKS5 " + host + ":" + port + " 即可使用，Ctrl+C 退出");
            while (true) {
                Socket s = ss.accept();
                s.setTcpNoDelay(true);
                pool.submit(() -> handle(s, http));
            }
        }
    }

    static byte[] vlessHeader(String host, int port) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(64);
        b.write(0);            // version
        b.write(UUID_BYTES);   // uuid
        b.write(0);            // addons length
        b.write(1);            // cmd: TCP
        b.write(port >> 8);
        b.write(port & 0xff);
        InetAddress ip = null;
        if (host.matches("^[0-9.]+$") || host.contains(":")) {
            try { ip = InetAddress.getByName(host); } catch (Exception ignored) { }
        }
        if (ip != null && ip.getAddress().length == 4) {
            b.write(1);
            b.write(ip.getAddress());
        } else if (ip != null) {
            b.write(3);
            b.write(ip.getAddress());
        } else {
            byte[] h = host.getBytes(StandardCharsets.UTF_8);
            b.write(2);
            b.write(h.length);
            b.write(h);
        }
        return b.toByteArray();
    }

    static void handle(Socket s, HttpClient http) {
        Downstream down = null;
        int n = ACTIVE.incrementAndGet();
        try (Socket sock = s) {
            DataInputStream in = new DataInputStream(new BufferedInputStream(sock.getInputStream(), 64 * 1024));
            OutputStream out = sock.getOutputStream();
            sock.setSoTimeout(15000);
            if (in.readUnsignedByte() != 5) return;
            in.readFully(new byte[in.readUnsignedByte()]);
            out.write(new byte[]{5, 0}); // NO AUTH
            out.flush();
            if (in.readUnsignedByte() != 5) return;
            int cmd = in.readUnsignedByte();
            in.readUnsignedByte();
            int atyp = in.readUnsignedByte();
            String host;
            if (atyp == 1) {
                byte[] b = new byte[4]; in.readFully(b); host = InetAddress.getByAddress(b).getHostAddress();
            } else if (atyp == 3) {
                byte[] b = new byte[in.readUnsignedByte()]; in.readFully(b); host = new String(b, StandardCharsets.UTF_8);
            } else if (atyp == 4) {
                byte[] b = new byte[16]; in.readFully(b); host = InetAddress.getByAddress(b).getHostAddress();
            } else {
                out.write(socksFail(8)); return;
            }
            int port = in.readUnsignedShort();
            if (cmd != 1) { out.write(socksFail(7)); return; }
            sock.setSoTimeout(0);
            log("→ " + host + ":" + port + " (active " + n + ")");

            down = new Downstream(out, host + ":" + port);
            WebSocket ws;
            try {
                ws = http.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(15)).buildAsync(URI.create(SERVER), down).join();
            } catch (Exception e) {
                System.err.println("连接服务器失败: " + (e.getCause() != null ? e.getCause() : e));
                out.write(socksFail(5));
                return;
            }
            down.ws = ws;
            ws.sendBinary(ByteBuffer.wrap(vlessHeader(host, port)), true).join();
            out.write(SOCKS_OK);
            out.flush();

            byte[] buf = new byte[32 * 1024];
            int r;
            while ((r = in.read(buf)) != -1) {
                ws.sendBinary(ByteBuffer.wrap(Arrays.copyOf(buf, r)), true).join();
            }
            ws.sendClose(WebSocket.NORMAL_CLOSURE, "").join();
        } catch (Exception ignored) {
            // connection reset / closed by either side
        } finally {
            ACTIVE.decrementAndGet();
            if (down != null && down.ws != null) down.ws.abort();
        }
    }

    /** WebSocket listener that writes incoming data to the SOCKS client, stripping the 2-byte VLESS response header. */
    static class Downstream implements WebSocket.Listener {
        final OutputStream out;
        final String target;
        volatile WebSocket ws;
        boolean headerDone = false;
        ByteArrayOutputStream pending = new ByteArrayOutputStream();

        Downstream(OutputStream out, String target) { this.out = out; this.target = target; }

        @Override public void onOpen(WebSocket w) { w.request(1); }

        @Override public CompletionStage<?> onBinary(WebSocket w, ByteBuffer data, boolean last) {
            try {
                byte[] b = new byte[data.remaining()];
                data.get(b);
                if (!headerDone) {
                    pending.write(b);
                    byte[] p = pending.toByteArray();
                    b = new byte[0];
                    if (p.length >= 2) {
                        int addons = p[1] & 0xff;
                        if (p.length >= 2 + addons) {
                            headerDone = true;
                            b = Arrays.copyOfRange(p, 2 + addons, p.length);
                            pending = null;
                        }
                    }
                }
                if (b.length > 0) { out.write(b); out.flush(); }
                w.request(1);
            } catch (IOException e) {
                w.abort();
            }
            return null;
        }

        @Override public CompletionStage<?> onClose(WebSocket w, int code, String reason) {
            if (code == 1008) System.err.println("服务器拒绝连接: " + reason + "（请检查 UUID / 流量 / 有效期）");
            log("← " + target + " closed (" + code + ")");
            try { out.close(); } catch (IOException ignored) { }
            return null;
        }

        @Override public void onError(WebSocket w, Throwable e) {
            try { out.close(); } catch (IOException ignored) { }
        }
    }
}
