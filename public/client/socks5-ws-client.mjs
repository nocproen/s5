#!/usr/bin/env node
/**
 * S5 Tunnel 轻量客户端 —— 本地 SOCKS5 ⇄ WebSocket ⇄ 服务器
 *
 * 零依赖，Node.js >= 22 直接运行（使用内置 WebSocket）。
 *
 *   node socks5-ws-client.mjs --server wss://example.com/tunnel --uuid <你的UUID> --listen 127.0.0.1:1080
 *
 * 然后把浏览器 / 系统代理设置为 SOCKS5 127.0.0.1:1080 即可。
 * 协议：VLESS over WebSocket（与 v2rayN / v2rayNG / Shadowrocket / Clash Meta 等客户端兼容）。
 */
import net from "node:net";
import process from "node:process";

const DEFAULT_SERVER = "__SERVER__";
const DEFAULT_UUID = "__UUID__";
const DEFAULT_LISTEN = "127.0.0.1:1080";

// ---------- args ----------
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return fallback;
}
const SERVER = arg("server", process.env.S5_SERVER || DEFAULT_SERVER);
const UUID = arg("uuid", process.env.S5_UUID || DEFAULT_UUID);
const LISTEN = arg("listen", process.env.S5_LISTEN || DEFAULT_LISTEN);
const VERBOSE = args.includes("--verbose") || args.includes("-v");

if (!SERVER || SERVER.startsWith("__") || !UUID || UUID.startsWith("__")) {
  console.error("用法: node socks5-ws-client.mjs --server wss://host/tunnel --uuid <UUID> [--listen 127.0.0.1:1080]");
  process.exit(1);
}
if (!/^[0-9a-f-]{36}$/i.test(UUID)) {
  console.error("UUID 格式不正确");
  process.exit(1);
}

let WebSocketImpl = globalThis.WebSocket;
if (!WebSocketImpl) {
  try {
    WebSocketImpl = (await import("ws")).default;
  } catch {
    console.error("当前 Node.js 版本没有内置 WebSocket，请升级到 Node.js 22+，或执行 npm i ws 后再运行");
    process.exit(1);
  }
}

// ---------- helpers ----------
const log = (...a) => VERBOSE && console.log(new Date().toISOString(), ...a);

function ipv6ToBytes(ip) {
  let [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const missing = 8 - h.length - t.length;
  const parts = [...h, ...Array(Math.max(0, missing)).fill("0"), ...t];
  const buf = Buffer.alloc(16);
  parts.forEach((p, i) => buf.writeUInt16BE(parseInt(p || "0", 16), i * 2));
  return buf;
}

function buildVlessHeader(uuid, host, port) {
  const uuidBytes = Buffer.from(uuid.replace(/-/g, ""), "hex");
  let addr;
  if (net.isIPv4(host)) {
    addr = Buffer.concat([Buffer.from([1]), Buffer.from(host.split(".").map(Number))]);
  } else if (net.isIPv6(host)) {
    addr = Buffer.concat([Buffer.from([3]), ipv6ToBytes(host)]);
  } else {
    const d = Buffer.from(host, "utf8");
    addr = Buffer.concat([Buffer.from([2, d.length]), d]);
  }
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  // ver=0 | uuid | addonsLen=0 | cmd=1(TCP) | port | addr
  return Buffer.concat([Buffer.from([0]), uuidBytes, Buffer.from([0]), Buffer.from([1]), portBuf, addr]);
}

const SOCKS_OK = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
const socksFail = (code) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

let active = 0;
let totalUp = 0;
let totalDown = 0;

// ---------- tunnel ----------
function openTunnel(sock, host, port) {
  const ws = new WebSocketImpl(SERVER);
  ws.binaryType = "arraybuffer";
  const queue = [];
  let replied = false;
  let headerDone = false;
  let head = Buffer.alloc(0);
  let closed = false;
  active++;
  log(`→ ${host}:${port} (active ${active})`);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    active--;
    try {
      ws.close();
    } catch {}
    sock.destroy();
  };

  sock.on("data", (d) => {
    totalUp += d.length;
    if (ws.readyState === 1) ws.send(d);
    else queue.push(d);
  });
  sock.on("error", cleanup);
  sock.on("close", cleanup);

  ws.onopen = () => {
    ws.send(Buffer.concat([buildVlessHeader(UUID, host, port), ...queue]));
    queue.length = 0;
    if (!replied) {
      replied = true;
      sock.write(SOCKS_OK);
    }
  };
  ws.onmessage = (ev) => {
    let buf = Buffer.from(ev.data);
    if (!headerDone) {
      head = Buffer.concat([head, buf]);
      if (head.length < 2) return;
      const addonsLen = head[1];
      if (head.length < 2 + addonsLen) return;
      buf = head.subarray(2 + addonsLen);
      headerDone = true;
      head = null;
      if (buf.length === 0) return;
    }
    totalDown += buf.length;
    sock.write(buf);
  };
  ws.onerror = () => {
    if (!replied) {
      replied = true;
      sock.write(socksFail(5));
    }
    cleanup();
  };
  ws.onclose = (ev) => {
    log(`← ${host}:${port} closed (${ev.code}${ev.reason ? " " + ev.reason : ""})`);
    if (!replied) {
      replied = true;
      sock.write(socksFail(5));
    }
    if (ev.code === 1008) console.error(`服务器拒绝连接: ${ev.reason || "unauthorized"}（请检查 UUID / 流量 / 有效期）`);
    // let queued data flush then close
    sock.end();
    setTimeout(cleanup, 200);
  };
}

// ---------- SOCKS5 server ----------
const [listenHost, listenPortStr] = LISTEN.includes(":") ? LISTEN.split(":") : ["127.0.0.1", LISTEN];
const listenPort = Number(listenPortStr);

const server = net.createServer((sock) => {
  sock.setNoDelay(true);
  sock.once("error", () => {});
  sock.once("data", (greeting) => {
    if (greeting[0] !== 5) return sock.destroy();
    sock.write(Buffer.from([5, 0])); // NO AUTH
    sock.once("data", (req) => {
      if (req.length < 7 || req[0] !== 5) return sock.destroy();
      if (req[1] !== 1) {
        sock.end(socksFail(7)); // command not supported (only CONNECT)
        return;
      }
      const atyp = req[3];
      let host;
      let off;
      if (atyp === 1) {
        host = Array.from(req.subarray(4, 8)).join(".");
        off = 8;
      } else if (atyp === 3) {
        const len = req[4];
        host = req.subarray(5, 5 + len).toString("utf8");
        off = 5 + len;
      } else if (atyp === 4) {
        const parts = [];
        for (let i = 0; i < 16; i += 2) parts.push(req.readUInt16BE(4 + i).toString(16));
        host = parts.join(":");
        off = 20;
      } else {
        return sock.end(socksFail(8));
      }
      const port = req.readUInt16BE(off);
      openTunnel(sock, host, port);
    });
  });
});

server.on("error", (e) => {
  console.error("监听失败:", e.message);
  process.exit(1);
});

server.listen(listenPort, listenHost, () => {
  console.log(`✔ SOCKS5 代理已启动: socks5://${listenHost}:${listenPort}`);
  console.log(`  服务器: ${SERVER}`);
  console.log(`  UUID  : ${UUID.slice(0, 8)}…`);
  console.log(`  把浏览器/系统代理设置为 SOCKS5 ${listenHost}:${listenPort} 即可使用，Ctrl+C 退出`);
});

if (VERBOSE) {
  setInterval(() => {
    console.log(`[stats] active=${active} up=${(totalUp / 1048576).toFixed(2)}MB down=${(totalDown / 1048576).toFixed(2)}MB`);
  }, 10000).unref();
}
