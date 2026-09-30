// S5 Tunnel 轻量客户端 (C# / .NET) —— 本地 SOCKS5 ⇄ WebSocket ⇄ 服务器
// S5 Tunnel lightweight client (C# / .NET) — local SOCKS5 ⇄ WebSocket ⇄ server
//
// 零第三方依赖，.NET 6+（使用内置 ClientWebSocket）。同目录 s5client.csproj：
//   dotnet run -- --server wss://example.com/tunnel --uuid <UUID> --listen 127.0.0.1:1080
//   dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true   (单文件发布)
//
// 协议：VLESS over WebSocket（与 v2rayN / v2rayNG / Shadowrocket / Clash Meta 等客户端兼容）。
using System;
using System.Buffers.Binary;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

static class Program
{
    const string DefaultServer = "__SERVER__";
    const string DefaultUuid = "__UUID__";
    const string DefaultListen = "127.0.0.1:1080";

    static string Server = DefaultServer;
    static string UuidStr = DefaultUuid;
    static string Listen = DefaultListen;
    static bool Verbose;
    static byte[] UuidBytes = Array.Empty<byte>();
    static int Active;
    static readonly byte[] SocksOk = { 5, 0, 0, 1, 0, 0, 0, 0, 0, 0 };
    static byte[] SocksFail(byte code) => new byte[] { 5, code, 0, 1, 0, 0, 0, 0, 0, 0 };

    static string EnvOr(string key, string fallback) =>
        string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key)) ? fallback : Environment.GetEnvironmentVariable(key)!;

    static void Log(string s) { if (Verbose) Console.Error.WriteLine(s); }

    static async Task<int> Main(string[] args)
    {
        Server = EnvOr("S5_SERVER", Server);
        UuidStr = EnvOr("S5_UUID", UuidStr);
        Listen = EnvOr("S5_LISTEN", Listen);
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--server": Server = args[++i]; break;
                case "--uuid": UuidStr = args[++i]; break;
                case "--listen": Listen = args[++i]; break;
                case "-v": case "--verbose": Verbose = true; break;
            }
        }
        if (Server.StartsWith("__") || UuidStr.StartsWith("__"))
        {
            Console.Error.WriteLine("用法: dotnet run -- --server wss://host/tunnel --uuid <UUID> [--listen 127.0.0.1:1080]");
            return 1;
        }
        if (!Regex.IsMatch(UuidStr, "^[0-9a-fA-F-]{36}$")) { Console.Error.WriteLine("UUID 格式不正确"); return 1; }
        UuidBytes = Convert.FromHexString(UuidStr.Replace("-", ""));

        int idx = Listen.LastIndexOf(':');
        var host = idx > 0 ? Listen[..idx] : "127.0.0.1";
        var port = int.Parse(Listen[(idx + 1)..]);
        var listener = new TcpListener(IPAddress.Parse(host), port);
        listener.Start();
        Console.WriteLine($"✔ SOCKS5 代理已启动: socks5://{host}:{port}");
        Console.WriteLine($"  服务器: {Server}");
        Console.WriteLine($"  UUID  : {UuidStr[..8]}…");
        Console.WriteLine($"  把浏览器/系统代理设置为 SOCKS5 {host}:{port} 即可使用，Ctrl+C 退出");
        while (true)
        {
            var client = await listener.AcceptTcpClientAsync();
            client.NoDelay = true;
            _ = Task.Run(() => Handle(client));
        }
    }

    static byte[] VlessHeader(string host, int port)
    {
        using var ms = new MemoryStream(64);
        ms.WriteByte(0);                 // version
        ms.Write(UuidBytes);             // uuid
        ms.WriteByte(0);                 // addons length
        ms.WriteByte(1);                 // cmd: TCP
        ms.WriteByte((byte)(port >> 8));
        ms.WriteByte((byte)(port & 0xff));
        if (IPAddress.TryParse(host, out var ip))
        {
            var bytes = ip.GetAddressBytes();
            ms.WriteByte(bytes.Length == 4 ? (byte)1 : (byte)3);
            ms.Write(bytes);
        }
        else
        {
            var h = Encoding.UTF8.GetBytes(host);
            ms.WriteByte(2);
            ms.WriteByte((byte)h.Length);
            ms.Write(h);
        }
        return ms.ToArray();
    }

    static async Task ReadExact(Stream s, byte[] buf, int len, CancellationToken ct)
    {
        int off = 0;
        while (off < len)
        {
            int n = await s.ReadAsync(buf.AsMemory(off, len - off), ct);
            if (n <= 0) throw new EndOfStreamException();
            off += n;
        }
    }

    static async Task Handle(TcpClient client)
    {
        using var cts = new CancellationTokenSource();
        var ct = cts.Token;
        ClientWebSocket? ws = null;
        int n = Interlocked.Increment(ref Active);
        try
        {
            using var _ = client;
            var s = client.GetStream();
            var b = new byte[260];
            await ReadExact(s, b, 2, ct);
            if (b[0] != 5) return;
            await ReadExact(s, b, b[1], ct);
            await s.WriteAsync(new byte[] { 5, 0 }, ct); // NO AUTH
            await ReadExact(s, b, 4, ct);
            int cmd = b[1], atyp = b[3];
            string host;
            if (atyp == 1) { await ReadExact(s, b, 4, ct); host = new IPAddress(b[..4]).ToString(); }
            else if (atyp == 3) { await ReadExact(s, b, 1, ct); int l = b[0]; await ReadExact(s, b, l, ct); host = Encoding.UTF8.GetString(b, 0, l); }
            else if (atyp == 4) { await ReadExact(s, b, 16, ct); host = new IPAddress(b[..16]).ToString(); }
            else { await s.WriteAsync(SocksFail(8), ct); return; }
            await ReadExact(s, b, 2, ct);
            int port = BinaryPrimitives.ReadUInt16BigEndian(b);
            if (cmd != 1) { await s.WriteAsync(SocksFail(7), ct); return; }
            Log($"→ {host}:{port} (active {n})");

            ws = new ClientWebSocket();
            try
            {
                using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                connectCts.CancelAfter(TimeSpan.FromSeconds(15));
                await ws.ConnectAsync(new Uri(Server), connectCts.Token);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"连接服务器失败: {e.Message}");
                await s.WriteAsync(SocksFail(5), ct);
                return;
            }
            await ws.SendAsync(VlessHeader(host, port), WebSocketMessageType.Binary, true, ct);
            await s.WriteAsync(SocksOk, ct);

            var up = Task.Run(async () =>
            {
                var buf = new byte[32 * 1024];
                while (true)
                {
                    int r = await s.ReadAsync(buf, ct);
                    if (r <= 0) break;
                    await ws.SendAsync(buf.AsMemory(0, r), WebSocketMessageType.Binary, true, ct);
                }
            }, ct);
            var down = Task.Run(async () =>
            {
                var buf = new byte[64 * 1024];
                bool headerDone = false;
                var pending = new MemoryStream();
                while (true)
                {
                    var res = await ws.ReceiveAsync(buf, ct);
                    if (res.MessageType == WebSocketMessageType.Close)
                    {
                        if (ws.CloseStatus == WebSocketCloseStatus.PolicyViolation)
                            Console.Error.WriteLine($"服务器拒绝连接: {ws.CloseStatusDescription}（请检查 UUID / 流量 / 有效期）");
                        Log($"← {host}:{port} closed ({(int?)ws.CloseStatus})");
                        break;
                    }
                    ReadOnlyMemory<byte> data = buf.AsMemory(0, res.Count);
                    if (!headerDone)
                    {
                        pending.Write(data.Span);
                        var p = pending.GetBuffer();
                        if (pending.Length < 2) continue;
                        int addons = p[1];
                        if (pending.Length < 2 + addons) continue;
                        headerDone = true;
                        data = p.AsMemory(2 + addons, (int)pending.Length - 2 - addons).ToArray();
                        if (data.Length == 0) continue;
                    }
                    await s.WriteAsync(data, ct);
                }
            }, ct);
            await Task.WhenAny(up, down);
        }
        catch (Exception) { /* closed by either side */ }
        finally
        {
            cts.Cancel();
            Interlocked.Decrement(ref Active);
            if (ws != null)
            {
                try { ws.Abort(); } catch { }
                ws.Dispose();
            }
        }
    }
}
