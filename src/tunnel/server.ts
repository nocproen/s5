/**
 * WebSocket -> SOCKS5-style tunnel server (VLESS over WebSocket protocol).
 *
 * The wire protocol is VLESS (used by Xray / v2rayN / v2rayNG / Shadowrocket /
 * Clash.Meta / Hiddify ...). Each WebSocket connection carries exactly one
 * proxied TCP stream or UDP association:
 *
 *   request : ver(1)=0 | uuid(16) | addonsLen(1) | addons | cmd(1) | port(2 BE) | atyp(1) | addr | payload...
 *   response: ver(1)=0 | addonsLen(1)=0 | payload...
 *
 *   cmd: 1 = TCP, 2 = UDP (length-prefixed datagrams: len(2 BE) + data), 3 = MUX (unsupported)
 *   atyp: 1 = IPv4(4), 2 = domain(len(1)+name), 3 = IPv6(16)
 */
import http from "http";
import net from "net";
import dgram from "dgram";
import WebSocket, { WebSocketServer } from "ws";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, connectionLogs, nodes } from "@/db/schema";
import { getSetting, SETTING_PROBE_UUID } from "@/lib/settings";

const TUNNEL_PORT = Number(process.env.TUNNEL_PORT ?? 8080);
const TUNNEL_PATH = process.env.TUNNEL_PATH ?? "/tunnel";
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 15 * 1000;
const FLUSH_INTERVAL_MS = 5 * 1000;
const USER_CACHE_TTL_MS = 30 * 1000;
const WS_HIGH_WATER = 1024 * 1024;
const WS_LOW_WATER = 256 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;

type CachedUser = {
  id: string;
  enabled: boolean;
  quotaBytes: number;
  usedBytes: number;
  expiresAt: Date | null;
  fetchedAt: number;
  /** Internal health-check credential: not billed, not logged, tightly capped. */
  probe?: boolean;
};

const PROBE_MAX_BYTES = 256 * 1024;
const PROBE_MAX_MS = 30 * 1000;
let probeCache: { uuid: string | null; fetchedAt: number } = { uuid: null, fetchedAt: 0 };

async function getProbeUuid(): Promise<string | null> {
  if (Date.now() - probeCache.fetchedAt < 60_000) return probeCache.uuid;
  try {
    probeCache = { uuid: await getSetting(SETTING_PROBE_UUID), fetchedAt: Date.now() };
  } catch (err) {
    console.error("[tunnel] probe credential lookup failed", err);
    probeCache.fetchedAt = Date.now() - 50_000; // retry soon, keep previous value
  }
  return probeCache.uuid;
}

type PendingTraffic = { up: number; down: number; conns: number };

type LogEntry = {
  userId: string;
  targetHost: string;
  targetPort: number;
  protocol: string;
  uploadBytes: number;
  downloadBytes: number;
  durationMs: number;
  clientIp: string | null;
  via?: string | null;
};

/** An upstream node we relay to, selected by the request path <TUNNEL_PATH>/<routeKey>. */
type UpstreamRoute = {
  id: string;
  name: string;
  url: string;
  uuid: string;
  sni: string | null;
  enabled: boolean;
};

const ROUTE_CACHE_TTL_MS = 30 * 1000;
const ROUTE_KEY_RE = /^[A-Za-z0-9_-]{4,64}$/;
const routeCache = new Map<string, { route: UpstreamRoute | null; fetchedAt: number }>();

async function lookupRoute(key: string): Promise<UpstreamRoute | null> {
  const cached = routeCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ROUTE_CACHE_TTL_MS) return cached.route;
  try {
    const rows = await db
      .select({
        id: nodes.id,
        name: nodes.name,
        url: nodes.upstreamUrl,
        uuid: nodes.upstreamUuid,
        sni: nodes.upstreamSni,
        enabled: nodes.enabled,
        relay: nodes.relay,
      })
      .from(nodes)
      .where(and(eq(nodes.routeKey, key), eq(nodes.kind, "upstream")))
      .limit(1);
    const r = rows[0];
    const route: UpstreamRoute | null =
      r && r.url && r.uuid && r.relay ? { id: r.id, name: r.name, url: r.url, uuid: r.uuid, sni: r.sni, enabled: r.enabled } : null;
    routeCache.set(key, { route, fetchedAt: Date.now() });
    return route;
  } catch (err) {
    console.error("[tunnel] route lookup failed", err);
    return cached?.route ?? null;
  }
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

const userCache = new Map<string, CachedUser>();
const pending = new Map<string, PendingTraffic>();
const pendingLogs: LogEntry[] = [];
const activeClosers = new Map<string, Set<() => void>>();

// ---------- helpers ----------

function formatUuid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function formatIpv6(b: Buffer): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16));
  return parts.join(":");
}

type Header = {
  uuid: string;
  cmd: number;
  host: string;
  port: number;
  payload: Buffer;
};

function parseVlessHeader(buf: Buffer): Header | "incomplete" | "invalid" {
  if (buf.length < 18) return "incomplete";
  if (buf[0] !== 0) return "invalid";
  const uuid = formatUuid(buf.subarray(1, 17));
  const addonsLen = buf[17];
  let off = 18 + addonsLen;
  if (buf.length < off + 4) return "incomplete";
  const cmd = buf[off++];
  const port = buf.readUInt16BE(off);
  off += 2;
  const atyp = buf[off++];
  let host: string;
  if (atyp === 1) {
    if (buf.length < off + 4) return "incomplete";
    host = Array.from(buf.subarray(off, off + 4)).join(".");
    off += 4;
  } else if (atyp === 2) {
    if (buf.length < off + 1) return "incomplete";
    const len = buf[off++];
    if (buf.length < off + len) return "incomplete";
    host = buf.subarray(off, off + len).toString("utf8");
    off += len;
  } else if (atyp === 3) {
    if (buf.length < off + 16) return "incomplete";
    host = formatIpv6(buf.subarray(off, off + 16));
    off += 16;
  } else {
    return "invalid";
  }
  if (!host || port === 0) return "invalid";
  return { uuid, cmd, host, port, payload: buf.subarray(off) };
}

function isForbiddenTarget(host: string): boolean {
  // Do not allow proxied clients to reach the loopback interface of the
  // server unless explicitly enabled (useful for local testing).
  if (process.env.TUNNEL_ALLOW_LOCALHOST === "true") return false;
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    h.startsWith("127.") ||
    h === "0.0.0.0" ||
    h.startsWith("169.254.")
  );
}

async function lookupUser(uuid: string): Promise<CachedUser | null> {
  const probe = await getProbeUuid();
  if (probe && uuid === probe) {
    return {
      id: "probe",
      enabled: true,
      quotaBytes: Number.MAX_SAFE_INTEGER,
      usedBytes: 0,
      expiresAt: null,
      fetchedAt: Date.now(),
      probe: true,
    };
  }
  const cached = userCache.get(uuid);
  if (cached && Date.now() - cached.fetchedAt < USER_CACHE_TTL_MS) return cached;
  try {
    const rows = await db
      .select({
        id: users.id,
        enabled: users.enabled,
        quotaBytes: users.quotaBytes,
        uploadBytes: users.uploadBytes,
        downloadBytes: users.downloadBytes,
        expiresAt: users.expiresAt,
      })
      .from(users)
      .where(eq(users.proxyUuid, uuid))
      .limit(1);
    const row = rows[0];
    if (!row) {
      userCache.delete(uuid);
      return null;
    }
    const entry: CachedUser = {
      id: row.id,
      enabled: row.enabled,
      quotaBytes: Number(row.quotaBytes),
      usedBytes: Number(row.uploadBytes) + Number(row.downloadBytes),
      expiresAt: row.expiresAt,
      fetchedAt: Date.now(),
    };
    userCache.set(uuid, entry);
    return entry;
  } catch (err) {
    console.error("[tunnel] user lookup failed", err);
    return cached ?? null;
  }
}

function isUserAllowed(u: CachedUser): boolean {
  if (!u.enabled) return false;
  if (u.expiresAt && u.expiresAt.getTime() < Date.now()) return false;
  const p = pending.get(u.id);
  const used = u.usedBytes + (p ? p.up + p.down : 0);
  return used < u.quotaBytes;
}

function addTraffic(userId: string, up: number, down: number, conns = 0) {
  const p = pending.get(userId) ?? { up: 0, down: 0, conns: 0 };
  p.up += up;
  p.down += down;
  p.conns += conns;
  pending.set(userId, p);
}

function trackCloser(userId: string, closer: () => void) {
  let set = activeClosers.get(userId);
  if (!set) {
    set = new Set();
    activeClosers.set(userId, set);
  }
  set.add(closer);
  return () => {
    set!.delete(closer);
    if (set!.size === 0) activeClosers.delete(userId);
  };
}

async function flush() {
  if (pending.size === 0 && pendingLogs.length === 0) return;
  const snapshot = Array.from(pending.entries());
  pending.clear();
  const logs = pendingLogs.splice(0, pendingLogs.length);
  try {
    for (const [userId, t] of snapshot) {
      await db
        .update(users)
        .set({
          uploadBytes: sql`${users.uploadBytes} + ${t.up}`,
          downloadBytes: sql`${users.downloadBytes} + ${t.down}`,
          totalConnections: sql`${users.totalConnections} + ${t.conns}`,
          lastSeenAt: new Date(),
        })
        .where(eq(users.id, userId));
      // keep cache in sync so quota checks stay accurate between refreshes
      for (const c of userCache.values()) {
        if (c.id === userId) {
          c.usedBytes += t.up + t.down;
          if (c.usedBytes >= c.quotaBytes) {
            activeClosers.get(userId)?.forEach((close) => close());
          }
        }
      }
    }
    if (logs.length > 0) {
      await db.insert(connectionLogs).values(logs);
    }
  } catch (err) {
    console.error("[tunnel] flush failed", err);
    // put traffic back so it is not lost
    for (const [userId, t] of snapshot) addTraffic(userId, t.up, t.down, t.conns);
  }
}

/** Close a socket gracefully; resume first so the peer's close frame is processed, terminate if it stalls. */
function closeWs(ws: WebSocket, code: number, reason?: string) {
  if (ws.readyState === ws.CLOSED) return;
  try {
    if (ws.isPaused) ws.resume();
    if (ws.readyState === ws.CONNECTING) {
      ws.terminate();
      return;
    }
    ws.close(code, reason);
    const t = setTimeout(() => {
      if (ws.readyState !== ws.CLOSED) ws.terminate();
    }, 3000);
    t.unref();
    ws.once("close", () => clearTimeout(t));
  } catch {
    ws.terminate();
  }
}

function decodeEarlyData(header: string | string[] | undefined): Buffer | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  const first = raw.split(",")[0].trim();
  if (!first) return null;
  try {
    return Buffer.from(first.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return null;
  }
}

// ---------- connection handling ----------

function handleConnection(ws: WebSocket, req: http.IncomingMessage, routeKey: string | null) {
  const clientIp =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ||
    req.socket.remoteAddress ||
    null;

  let headerBuf: Buffer = Buffer.alloc(0);
  let phase: "header" | "auth" | "relay" = "header";
  let established = false;
  let closed = false;
  // Frames that arrive while we are authenticating (ws emits frames from the
  // same TCP segment synchronously, so pause() alone is not enough).
  const backlog: Buffer[] = [];
  let sink: ((buf: Buffer) => void) | null = null;

  const early = decodeEarlyData(req.headers["sec-websocket-protocol"]);
  if (early && early.length > 0) headerBuf = early;

  const fail = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    closeWs(ws, code, reason);
  };

  const onFirstData = async (data: Buffer) => {
    headerBuf = headerBuf.length ? Buffer.concat([headerBuf, data]) : data;
    if (headerBuf.length > MAX_HEADER_BYTES) return fail(1008, "header too large");
    const parsed = parseVlessHeader(headerBuf);
    if (parsed === "incomplete") return;
    if (parsed === "invalid") return fail(1008, "bad request");
    phase = "auth";
    ws.pause();

    const user = await lookupUser(parsed.uuid);
    if (closed) return;
    if (!user) return fail(1008, "unauthorized");
    if (!isUserAllowed(user)) return fail(1008, "forbidden");
    if (isForbiddenTarget(parsed.host)) return fail(1008, "forbidden target");
    if (user.probe && parsed.cmd !== 1) return fail(1008, "probe: tcp only");

    let route: UpstreamRoute | null = null;
    if (routeKey) {
      route = await lookupRoute(routeKey);
      if (closed) return;
      if (!route || !route.enabled) return fail(1008, "unknown route");
      if (parsed.cmd !== 1 && parsed.cmd !== 2) return fail(1003, "mux not supported");
    }

    established = true;
    phase = "relay";
    let drain: (buf: Buffer) => void;
    if (route) {
      drain = relayUpstream(ws, headerBuf, parsed, user, clientIp, route);
    } else if (parsed.cmd === 1) {
      drain = relayTcp(ws, parsed, user, clientIp);
    } else if (parsed.cmd === 2) {
      drain = relayUdp(ws, parsed, user, clientIp);
    } else {
      return fail(1003, "mux not supported");
    }
    sink = drain;
    for (const b of backlog.splice(0, backlog.length)) drain(b);
  };

  ws.on("message", (data) => {
    const buf = toBuffer(data);
    if (sink) return sink(buf);
    if (phase === "header") return void onFirstData(buf);
    backlog.push(buf);
  });
  ws.on("error", () => fail(1011, "error"));

  // Early data may already hold a complete header.
  if (headerBuf.length > 0) {
    const bytes = headerBuf;
    headerBuf = Buffer.alloc(0);
    void onFirstData(bytes);
  }

  // Safety: a client that never sends a header is dropped.
  const t = setTimeout(() => {
    if (!established) fail(1008, "handshake timeout");
  }, CONNECT_TIMEOUT_MS);
  ws.once("close", () => clearTimeout(t));
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  return Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
}

function relayTcp(ws: WebSocket, h: Header, user: CachedUser, clientIp: string | null): (buf: Buffer) => void {
  const started = Date.now();
  let up = 0;
  let down = 0;
  let finished = false;
  let headerSent = false;
  let connected = false;

  const probe = user.probe === true;

  const target = net.connect({ host: h.host, port: h.port });
  target.setNoDelay(true);
  target.setTimeout(IDLE_TIMEOUT_MS);

  const untrack = probe ? () => {} : trackCloser(user.id, () => target.destroy());
  const probeTimer = probe ? setTimeout(() => finish(), PROBE_MAX_MS) : null;

  const finish = () => {
    if (finished) return;
    finished = true;
    untrack();
    if (probeTimer) clearTimeout(probeTimer);
    target.destroy();
    closeWs(ws, connected ? 1000 : 1011, connected ? undefined : "connect failed");
    if (probe) return; // health checks are neither billed nor logged
    addTraffic(user.id, up, down, 1);
    pendingLogs.push({
      userId: user.id,
      targetHost: h.host,
      targetPort: h.port,
      protocol: "tcp",
      uploadBytes: up,
      downloadBytes: down,
      durationMs: Date.now() - started,
      clientIp,
    });
  };

  const connectTimer = setTimeout(() => target.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);

  target.once("connect", () => {
    clearTimeout(connectTimer);
    connected = true;
    if (!headerSent) {
      headerSent = true;
      ws.send(Buffer.from([0, 0]));
    }
    if (h.payload.length > 0) {
      up += h.payload.length;
      target.write(h.payload);
    }
    ws.resume();
  });

  target.on("data", (chunk: Buffer) => {
    down += chunk.length;
    if (probe && up + down > PROBE_MAX_BYTES) return finish();
    ws.send(chunk, () => {
      if (target.isPaused() && ws.bufferedAmount < WS_LOW_WATER) target.resume();
    });
    if (ws.bufferedAmount > WS_HIGH_WATER) target.pause();
  });

  target.on("timeout", () => target.destroy());
  target.on("error", () => finish());
  target.on("close", () => finish());
  target.on("end", () => finish());

  ws.on("close", () => finish());
  ws.on("error", () => finish());

  return (buf: Buffer) => {
    if (finished) return;
    up += buf.length;
    if (probe && up + down > PROBE_MAX_BYTES) return finish();
    if (!target.write(buf)) {
      ws.pause();
      target.once("drain", () => {
        if (!finished) ws.resume();
      });
    }
  };
}

function relayUdp(ws: WebSocket, h: Header, user: CachedUser, clientIp: string | null): (buf: Buffer) => void {
  const started = Date.now();
  let up = 0;
  let down = 0;
  let finished = false;
  let inbound: Buffer = Buffer.alloc(0);

  const udp = dgram.createSocket(net.isIPv6(h.host) ? "udp6" : "udp4");
  const untrack = trackCloser(user.id, () => {
    try {
      udp.close();
    } catch {
      /* noop */
    }
  });

  const finish = () => {
    if (finished) return;
    finished = true;
    untrack();
    clearTimeout(idleTimer);
    try {
      udp.close();
    } catch {
      /* noop */
    }
    closeWs(ws, 1000);
    addTraffic(user.id, up, down, 1);
    pendingLogs.push({
      userId: user.id,
      targetHost: h.host,
      targetPort: h.port,
      protocol: "udp",
      uploadBytes: up,
      downloadBytes: down,
      durationMs: Date.now() - started,
      clientIp,
    });
  };

  let idleTimer = setTimeout(finish, IDLE_TIMEOUT_MS);
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(finish, IDLE_TIMEOUT_MS);
  };

  const consume = (chunk: Buffer) => {
    inbound = inbound.length ? Buffer.concat([inbound, chunk]) : chunk;
    while (inbound.length >= 2) {
      const len = inbound.readUInt16BE(0);
      if (inbound.length < 2 + len) break;
      const pkt = inbound.subarray(2, 2 + len);
      inbound = inbound.subarray(2 + len);
      up += pkt.length;
      udp.send(pkt, h.port, h.host, (err) => {
        if (err) finish();
      });
    }
    touch();
  };

  udp.on("message", (msg) => {
    down += msg.length;
    const out = Buffer.alloc(2 + msg.length);
    out.writeUInt16BE(msg.length, 0);
    msg.copy(out, 2);
    ws.send(out);
    touch();
  });
  udp.on("error", () => finish());
  udp.on("close", () => finish());

  ws.send(Buffer.from([0, 0]));
  if (h.payload.length > 0) consume(h.payload);
  ws.resume();

  ws.on("close", () => finish());
  ws.on("error", () => finish());

  return (buf: Buffer) => {
    if (!finished) consume(buf);
  };
}

/**
 * Relay a client stream to an upstream tunnel server using the credential stored for
 * the node. The VLESS request header is forwarded unchanged except for the UUID, and
 * everything after it (both directions, TCP or UDP) is passed through verbatim.
 */
function relayUpstream(
  ws: WebSocket,
  rawHeader: Buffer,
  h: Header,
  user: CachedUser,
  clientIp: string | null,
  route: UpstreamRoute,
): (buf: Buffer) => void {
  const started = Date.now();
  const probe = user.probe === true;
  let up = h.payload.length;
  let down = 0;
  let finished = false;
  let upstreamOpen = false;
  let queued: Buffer[] = [];
  let queuedBytes = 0;

  const upstreamHeader = Buffer.concat([Buffer.from([0]), uuidToBytes(route.uuid), rawHeader.subarray(17)]);
  const sniHost = route.sni && !net.isIP(route.sni) ? route.sni : null;

  const target = new WebSocket(route.url, {
    headers: {
      ...(route.sni ? { Host: route.sni } : {}),
      "User-Agent": "s5-tunnel-relay/1.0",
    },
    ...(sniHost && route.url.startsWith("wss://") ? { servername: sniHost } : {}),
    perMessageDeflate: false,
    handshakeTimeout: CONNECT_TIMEOUT_MS,
    maxPayload: 16 * 1024 * 1024,
    followRedirects: false,
  });

  const untrack = probe ? () => {} : trackCloser(user.id, () => target.terminate());
  const probeTimer = probe ? setTimeout(() => finish(1000), PROBE_MAX_MS) : null;

  const finish = (code: number, reason?: string) => {
    if (finished) return;
    finished = true;
    untrack();
    if (probeTimer) clearTimeout(probeTimer);
    try {
      target.terminate();
    } catch {
      /* noop */
    }
    closeWs(ws, code, reason);
    if (probe) return;
    addTraffic(user.id, up, down, 1);
    pendingLogs.push({
      userId: user.id,
      targetHost: h.host,
      targetPort: h.port,
      protocol: h.cmd === 2 ? "udp" : "tcp",
      uploadBytes: up,
      downloadBytes: down,
      durationMs: Date.now() - started,
      clientIp,
      via: route.name,
    });
  };

  target.on("open", () => {
    upstreamOpen = true;
    target.send(upstreamHeader);
    for (const q of queued) target.send(q);
    queued = [];
    queuedBytes = 0;
    ws.resume();
  });

  target.on("unexpected-response", (_req, res) => {
    finish(1011, `upstream http ${res.statusCode ?? 0}`);
  });

  target.on("error", (err: NodeJS.ErrnoException) => {
    finish(1011, upstreamOpen ? "upstream error" : `upstream unreachable: ${err.code ?? err.message}`.slice(0, 120));
  });

  target.on("message", (data) => {
    const buf = toBuffer(data);
    down += buf.length;
    if (probe && up + down > PROBE_MAX_BYTES) return finish(1000);
    ws.send(buf, () => {
      if (target.isPaused && ws.bufferedAmount < WS_LOW_WATER) target.resume();
    });
    if (ws.bufferedAmount > WS_HIGH_WATER) target.pause();
  });

  target.on("close", (code, reason) => {
    const r = reason.toString();
    if (code === 1008) finish(1008, `upstream rejected: ${r || "unauthorized"}`.slice(0, 120));
    else if (code === 1000 || code === 1005) finish(1000);
    else finish(1011, `upstream closed ${code}${r ? " " + r : ""}`.slice(0, 120));
  });

  ws.on("close", () => finish(1000));
  ws.on("error", () => finish(1011, "client error"));

  return (buf: Buffer) => {
    if (finished) return;
    up += buf.length;
    if (probe && up + down > PROBE_MAX_BYTES) return finish(1000);
    if (!upstreamOpen) {
      queued.push(buf);
      queuedBytes += buf.length;
      if (queuedBytes > WS_HIGH_WATER) ws.pause();
      if (queuedBytes > 8 * WS_HIGH_WATER) finish(1011, "upstream connect too slow");
      return;
    }
    target.send(buf, () => {
      if (ws.isPaused && target.bufferedAmount < WS_LOW_WATER) ws.resume();
    });
    if (target.bufferedAmount > WS_HIGH_WATER) ws.pause();
  };
}

// ---------- bootstrap ----------

declare global {
  // eslint-disable-next-line no-var
  var __s5TunnelServer: http.Server | undefined;
  // eslint-disable-next-line no-var
  var __s5TunnelAttached: WeakSet<net.Server> | undefined;
  // eslint-disable-next-line no-var
  var __s5TunnelWss: WebSocketServer | undefined;
}

function getWss(): WebSocketServer {
  if (!globalThis.__s5TunnelWss) {
    globalThis.__s5TunnelWss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 16 * 1024 * 1024,
    });
  }
  return globalThis.__s5TunnelWss;
}

/**
 * Returns true when the upgrade request targeted the tunnel and was taken over.
 *   <TUNNEL_PATH>            -> direct exit from this server
 *   <TUNNEL_PATH>/<routeKey> -> relayed through the upstream node with that key
 */
function tryHandleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  let routeKey: string | null = null;
  if (url.pathname === TUNNEL_PATH || url.pathname === `${TUNNEL_PATH}/`) {
    routeKey = null;
  } else if (url.pathname.startsWith(`${TUNNEL_PATH}/`)) {
    const rest = url.pathname.slice(TUNNEL_PATH.length + 1).replace(/\/$/, "");
    if (!ROUTE_KEY_RE.test(rest)) return false;
    routeKey = rest;
  } else {
    return false;
  }
  getWss().handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req, routeKey));
  return true;
}

type UpgradeListener = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void;

/**
 * Attach the tunnel to an existing HTTP server (e.g. the Next.js web server on :3000),
 * so the WebSocket endpoint is available on the same host/port as the website:
 * wss://<site-host>/<TUNNEL_PATH>. Existing upgrade listeners keep working for other paths.
 */
export function attachTunnelToServer(server: net.Server, label = "web server") {
  const attached = (globalThis.__s5TunnelAttached ??= new WeakSet<net.Server>());
  if (attached.has(server)) return;
  attached.add(server);

  const existing = server.listeners("upgrade") as UpgradeListener[];
  server.removeAllListeners("upgrade");
  server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    if (tryHandleUpgrade(req, socket, head)) return;
    for (const listener of existing) listener.call(server, req, socket, head);
    // Next.js leaves upgrade requests for unknown paths hanging. Answer them with a
    // proper 404 after a grace period so clients (and our health check) fail fast.
    const t = setTimeout(() => {
      if (!socket.destroyed && socket.bytesWritten === 0) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
    }, 2000);
    t.unref();
    socket.once("close", () => clearTimeout(t));
  });

  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : "?";
  console.log(`[tunnel] attached to ${label} on :${port}${TUNNEL_PATH}`);
}

/**
 * Find the HTTP server created by `next start` (it is already listening when
 * instrumentation runs) and attach the tunnel to it. Retries for a while because
 * the handle may not be visible immediately.
 */
export function attachTunnelToWebServer(attempt = 0) {
  const webPort = Number(process.env.PORT ?? 3000);
  const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  const handles: unknown[] = typeof getHandles === "function" ? getHandles.call(process) : [];
  const servers = handles.filter(
    (h): h is http.Server => h instanceof http.Server && h !== globalThis.__s5TunnelServer && h.listening,
  );
  const preferred =
    servers.find((s) => {
      const a = s.address();
      return a && typeof a === "object" && a.port === webPort;
    }) ?? servers.find((s) => {
      const a = s.address();
      return a && typeof a === "object" && a.port !== TUNNEL_PORT;
    });

  if (preferred) {
    attachTunnelToServer(preferred, "Next.js web server");
    return;
  }
  if (attempt < 120) {
    const t = setTimeout(() => attachTunnelToWebServer(attempt + 1), 500);
    t.unref();
  } else {
    console.warn("[tunnel] could not find the web server to attach to; tunnel only available on the standalone port");
  }
}

export function startTunnelServer() {
  if (globalThis.__s5TunnelServer) return globalThis.__s5TunnelServer;

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: TUNNEL_PATH }));
      return;
    }
    // Plain HTTP visitors get a boring page (looks like a normal site).
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
  });

  server.on("upgrade", (req, socket, head) => {
    if (tryHandleUpgrade(req, socket as net.Socket, head)) return;
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[tunnel] port ${TUNNEL_PORT} already in use, standalone tunnel port not started in this process`);
    } else {
      console.error("[tunnel] server error", err);
    }
  });

  if (TUNNEL_PORT > 0) {
    server.listen(TUNNEL_PORT, "0.0.0.0", () => {
      console.log(`[tunnel] VLESS-over-WebSocket tunnel listening on :${TUNNEL_PORT}${TUNNEL_PATH}`);
    });
  }

  const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  timer.unref();

  const shutdown = () => {
    clearInterval(timer);
    void flush().finally(() => server.close());
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  globalThis.__s5TunnelServer = server;

  // Also serve the tunnel through the website's own port (works behind the
  // preview URL / any reverse proxy that only exposes the web port).
  attachTunnelToWebServer();

  return server;
}

export const tunnelConfig = { port: TUNNEL_PORT, path: TUNNEL_PATH };
