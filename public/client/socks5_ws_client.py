#!/usr/bin/env python3
"""
S5 Tunnel 轻量客户端 (Python) —— 本地 SOCKS5 ⇄ WebSocket ⇄ 服务器
S5 Tunnel lightweight client (Python) — local SOCKS5 ⇄ WebSocket ⇄ server

零依赖，Python 3.8+ 直接运行（WebSocket 帧由本文件自行实现，无需 pip install）。
Zero dependencies, runs on Python 3.8+ (WebSocket framing is implemented inline).

    python3 socks5_ws_client.py --server wss://example.com/tunnel --uuid <UUID> --listen 127.0.0.1:1080

然后把浏览器 / 系统代理设置为 SOCKS5 127.0.0.1:1080 即可。
协议：VLESS over WebSocket（与 v2rayN / v2rayNG / Shadowrocket / Clash Meta 等客户端兼容）。
"""
import argparse
import asyncio
import base64
import hashlib
import ipaddress
import os
import re
import ssl
import struct
import sys
from urllib.parse import urlparse

DEFAULT_SERVER = "__SERVER__"
DEFAULT_UUID = "__UUID__"
DEFAULT_LISTEN = "127.0.0.1:1080"

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
SOCKS_OK = b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00"


def socks_fail(code: int) -> bytes:
    return bytes([5, code, 0, 1, 0, 0, 0, 0, 0, 0])


def log(*a):
    if ARGS.verbose:
        print(*a, file=sys.stderr, flush=True)


# ---------- WebSocket (RFC 6455, client side) ----------

def mask_bytes(data: bytes, mask: bytes) -> bytes:
    """XOR-mask using big-int arithmetic (fast, no C extension needed)."""
    n = len(data)
    if n == 0:
        return data
    reps = (n + 3) // 4
    m = int.from_bytes((mask * reps)[:n], "little")
    return (int.from_bytes(data, "little") ^ m).to_bytes(n, "little")


class WebSocket:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self.lock = asyncio.Lock()
        self.close_code = None
        self.close_reason = ""

    @classmethod
    async def connect(cls, url: str, insecure: bool = False, timeout: float = 15.0) -> "WebSocket":
        u = urlparse(url)
        tls = u.scheme == "wss"
        if u.scheme not in ("ws", "wss") or not u.hostname:
            raise ValueError("server 必须是 ws:// 或 wss:// 地址")
        host = u.hostname
        port = u.port or (443 if tls else 80)
        path = (u.path or "/") + (("?" + u.query) if u.query else "")
        ctx = None
        if tls:
            ctx = ssl.create_default_context()
            if insecure:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port, ssl=ctx, server_hostname=host if tls else None), timeout
        )
        key = base64.b64encode(os.urandom(16)).decode()
        host_header = host if port in (80, 443) else f"{host}:{port}"
        if ":" in host and not host.startswith("["):
            host_header = f"[{host}]" + ("" if port in (80, 443) else f":{port}")
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "User-Agent: s5-tunnel-python/1.0\r\n\r\n"
        )
        writer.write(req.encode())
        await writer.drain()
        status = await asyncio.wait_for(reader.readline(), timeout)
        if not status.startswith(b"HTTP/1.1 101"):
            writer.close()
            raise ConnectionError(f"握手失败: {status.decode(errors='replace').strip() or 'no response'}")
        accept = None
        while True:
            line = await reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break
            k, _, v = line.decode(errors="replace").partition(":")
            if k.strip().lower() == "sec-websocket-accept":
                accept = v.strip()
        expected = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        if accept != expected:
            writer.close()
            raise ConnectionError("握手失败: Sec-WebSocket-Accept 校验不通过")
        return cls(reader, writer)

    async def send(self, payload: bytes, opcode: int = 0x2):
        n = len(payload)
        head = bytearray([0x80 | opcode])
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack(">H", n)
        else:
            head.append(0x80 | 127)
            head += struct.pack(">Q", n)
        mask = os.urandom(4)
        head += mask
        async with self.lock:
            self.writer.write(bytes(head) + mask_bytes(payload, mask))
            await self.writer.drain()

    async def recv(self):
        """Return the payload of the next data frame, or None once the peer closed."""
        r = self.reader
        while True:
            h = await r.readexactly(2)
            opcode = h[0] & 0x0F
            masked = h[1] & 0x80
            n = h[1] & 0x7F
            if n == 126:
                n = struct.unpack(">H", await r.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", await r.readexactly(8))[0]
            mask = await r.readexactly(4) if masked else None
            payload = await r.readexactly(n) if n else b""
            if mask:
                payload = mask_bytes(payload, mask)
            if opcode in (0x0, 0x1, 0x2):
                return payload
            if opcode == 0x8:
                self.close_code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else 1005
                self.close_reason = payload[2:].decode(errors="replace")
                return None
            if opcode == 0x9:
                await self.send(payload, 0xA)
            # 0xA pong: ignore

    async def close(self, code: int = 1000):
        try:
            await self.send(struct.pack(">H", code), 0x8)
        except Exception:
            pass
        try:
            self.writer.close()
        except Exception:
            pass


# ---------- VLESS ----------

def build_vless_header(uuid_str: str, host: str, port: int) -> bytes:
    uid = bytes.fromhex(uuid_str.replace("-", ""))
    try:
        ip = ipaddress.ip_address(host)
        addr = (b"\x01" if ip.version == 4 else b"\x03") + ip.packed
    except ValueError:
        h = host.encode("idna") if host.isascii() else host.encode("utf-8")
        addr = b"\x02" + bytes([len(h)]) + h
    # ver=0 | uuid | addonsLen=0 | cmd=1(TCP) | port | addr
    return b"\x00" + uid + b"\x00" + b"\x01" + struct.pack(">H", port) + addr


# ---------- SOCKS5 ----------

STATS = {"active": 0, "up": 0, "down": 0}


async def pump_up(reader: asyncio.StreamReader, ws: WebSocket):
    while True:
        data = await reader.read(65536)
        if not data:
            break
        STATS["up"] += len(data)
        await ws.send(data)


async def pump_down(ws: WebSocket, writer: asyncio.StreamWriter):
    header_done = False
    pending = b""
    while True:
        data = await ws.recv()
        if data is None:
            break
        if not header_done:
            pending += data
            if len(pending) < 2:
                continue
            addons = pending[1]
            if len(pending) < 2 + addons:
                continue
            data = pending[2 + addons:]
            header_done = True
            pending = b""
            if not data:
                continue
        STATS["down"] += len(data)
        writer.write(data)
        await writer.drain()


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    peer = writer.get_extra_info("peername")
    ws = None
    STATS["active"] += 1
    try:
        ver, nmethods = await reader.readexactly(2)
        if ver != 5:
            return
        await reader.readexactly(nmethods)
        writer.write(b"\x05\x00")  # NO AUTH
        ver, cmd, _, atyp = await reader.readexactly(4)
        if atyp == 1:
            host = str(ipaddress.IPv4Address(await reader.readexactly(4)))
        elif atyp == 3:
            n = (await reader.readexactly(1))[0]
            host = (await reader.readexactly(n)).decode("utf-8", errors="replace")
        elif atyp == 4:
            host = str(ipaddress.IPv6Address(await reader.readexactly(16)))
        else:
            writer.write(socks_fail(8))
            return
        port = struct.unpack(">H", await reader.readexactly(2))[0]
        if cmd != 1:  # only CONNECT
            writer.write(socks_fail(7))
            return
        log(f"→ {host}:{port} (active {STATS['active']})")
        try:
            ws = await WebSocket.connect(ARGS.server, ARGS.insecure)
            await ws.send(build_vless_header(ARGS.uuid, host, port))
        except Exception as e:
            print(f"连接服务器失败: {e}", file=sys.stderr, flush=True)
            writer.write(socks_fail(5))
            return
        writer.write(SOCKS_OK)
        await writer.drain()

        up = asyncio.ensure_future(pump_up(reader, ws))
        down = asyncio.ensure_future(pump_down(ws, writer))
        done, pending_tasks = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending_tasks:
            t.cancel()
        for t in done:
            exc = t.exception() if not t.cancelled() else None
            if exc and not isinstance(exc, (asyncio.IncompleteReadError, ConnectionError)):
                log(f"relay error: {exc!r}")
        if ws.close_code == 1008:
            print(f"服务器拒绝连接: {ws.close_reason or 'unauthorized'}（请检查 UUID / 流量 / 有效期）", file=sys.stderr, flush=True)
        log(f"← {host}:{port} closed ({ws.close_code or '-'})")
    except (asyncio.IncompleteReadError, ConnectionError, asyncio.TimeoutError):
        pass
    except Exception as e:
        log(f"error from {peer}: {e!r}")
    finally:
        STATS["active"] -= 1
        if ws is not None:
            await ws.close()
        try:
            writer.close()
        except Exception:
            pass


async def stats_loop():
    while True:
        await asyncio.sleep(10)
        log(f"[stats] active={STATS['active']} up={STATS['up'] / 1048576:.2f}MB down={STATS['down'] / 1048576:.2f}MB")


async def main():
    host, _, port = ARGS.listen.rpartition(":")
    host = host or "127.0.0.1"
    server = await asyncio.start_server(handle_client, host, int(port))
    print(f"✔ SOCKS5 代理已启动: socks5://{host}:{port}")
    print(f"  服务器: {ARGS.server}")
    print(f"  UUID  : {ARGS.uuid[:8]}…")
    print(f"  把浏览器/系统代理设置为 SOCKS5 {host}:{port} 即可使用，Ctrl+C 退出", flush=True)
    if ARGS.verbose:
        asyncio.ensure_future(stats_loop())
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="S5 Tunnel client: local SOCKS5 over WebSocket")
    p.add_argument("--server", default=os.environ.get("S5_SERVER", DEFAULT_SERVER), help="wss://host/path")
    p.add_argument("--uuid", default=os.environ.get("S5_UUID", DEFAULT_UUID))
    p.add_argument("--listen", default=os.environ.get("S5_LISTEN", DEFAULT_LISTEN), help="host:port (default 127.0.0.1:1080)")
    p.add_argument("--insecure", action="store_true", help="skip TLS certificate verification")
    p.add_argument("-v", "--verbose", action="store_true")
    ARGS = p.parse_args()
    if not ARGS.server or ARGS.server.startswith("__") or not ARGS.uuid or ARGS.uuid.startswith("__"):
        p.error("需要 --server 与 --uuid（或在控制台下载已内置配置的版本）")
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", ARGS.uuid):
        p.error("UUID 格式不正确")
    if sys.platform == "win32" and sys.version_info < (3, 8):
        p.error("Windows 需要 Python 3.8+")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已退出")
