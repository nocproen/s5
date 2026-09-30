/**
 * Node health checks.
 *
 * A check connects to the node exactly the way a user's client would (public host,
 * port, TLS/SNI, WebSocket path), authenticates with the internal probe credential and
 * asks the node to relay a tiny HTTP request to an external target. This validates the
 * whole chain: DNS → TCP → TLS certificate → reverse proxy / CDN → WebSocket upgrade →
 * tunnel auth → outbound connectivity of the node.
 */
import dns from "dns/promises";
import net from "net";
import WebSocket from "ws";
import { desc, eq, gt, lt } from "drizzle-orm";
import { db } from "@/db";
import { nodeChecks, nodes, type Node } from "@/db/schema";
import { parseUpstreamUrl, resolveNode } from "@/lib/nodes";
import {
  ensureProbeCredential,
  getCheckBaseUrl,
  setSetting,
  SETTING_LAST_AUTO_CHECK,
} from "@/lib/settings";

export type CheckStage = "dns" | "connect" | "handshake" | "auth" | "tunnel" | "ok";

export const STAGE_LABELS: Record<CheckStage, string> = {
  dns: "域名解析",
  connect: "建立连接 / TLS",
  handshake: "WebSocket 握手",
  auth: "鉴权",
  tunnel: "隧道转发",
  ok: "全部通过",
};

export type CheckDetail = {
  url: string;
  target: string;
  ip?: string;
  dnsMs?: number;
  connectMs?: number;
  tunnelMs?: number;
  httpStatus?: number;
};

export type CheckResult = {
  ok: boolean;
  stage: CheckStage;
  message: string;
  latencyMs: number;
  detail: CheckDetail;
};

export type ProbeTarget = { host: string; port: number; path: string; tls: boolean; sni?: string | null };

export const CHECK_TARGET = process.env.NODE_CHECK_TARGET || "cp.cloudflare.com:80";
const TIMEOUT_MS = Number(process.env.NODE_CHECK_TIMEOUT_MS || 12000);
const CHECK_INTERVAL_MIN = Number(process.env.NODE_CHECK_INTERVAL_MIN ?? 10);
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- helpers ----------

function buildProbeHeader(uuid: string, host: string, port: number): Buffer {
  const uuidBytes = Buffer.from(uuid.replace(/-/g, ""), "hex");
  let addr: Buffer;
  if (net.isIPv4(host)) {
    addr = Buffer.concat([Buffer.from([1]), Buffer.from(host.split(".").map(Number))]);
  } else if (net.isIPv6(host)) {
    const parts = host.split("::");
    const head = parts[0] ? parts[0].split(":") : [];
    const tail = parts[1] ? parts[1].split(":") : [];
    const full = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
    const b = Buffer.alloc(16);
    full.forEach((p, i) => b.writeUInt16BE(parseInt(p || "0", 16), i * 2));
    addr = Buffer.concat([Buffer.from([3]), b]);
  } else {
    const d = Buffer.from(host, "utf8");
    addr = Buffer.concat([Buffer.from([2, d.length]), d]);
  }
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  return Buffer.concat([Buffer.from([0]), uuidBytes, Buffer.from([0, 1]), portBuf, addr]);
}

function describeError(err: NodeJS.ErrnoException): string {
  const code = err.code ?? "";
  const msg = err.message ?? "";
  if (code === "ECONNREFUSED") return "连接被拒绝：端口未开放或服务未启动";
  if (code === "ETIMEDOUT" || /timed out/i.test(msg)) return "连接超时：被防火墙拦截或网络不可达";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "域名无法解析";
  if (code === "ECONNRESET") return "连接被重置：可能被中间设备干扰或服务异常";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "主机不可达";
  if (code === "CERT_HAS_EXPIRED") return "TLS 证书已过期，请续期证书";
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return "TLS 证书与域名不匹配（检查域名 / SNI 设置）";
  if (/SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|CERT_UNTRUSTED|CERT_NOT_YET_VALID/.test(code)) {
    return "TLS 证书不受信任（自签名或证书链不完整）";
  }
  if (code === "EPROTO" || /wrong version number|handshake failure|ssl|tls/i.test(msg)) {
    return "TLS 握手失败：该端口可能不是 TLS 服务，请检查「TLS」开关";
  }
  if (/Invalid Sec-WebSocket-Accept/i.test(msg)) return "WebSocket 握手响应不正确：反向代理未正确透传";
  return msg || code || "未知错误";
}

function describeHttpStatus(status: number): string {
  if (status === 404) return "路径不存在：检查 WS 路径是否与服务器 TUNNEL_PATH 一致";
  if (status === 400 || status === 426) return "未按 WebSocket 处理：反向代理需要透传 Upgrade / Connection 头";
  if (status === 401 || status === 403) return "访问被拒绝：防火墙、CDN 或 WAF 拦截";
  if (status >= 500) return "反向代理无法连接后端隧道服务";
  if (status >= 300 && status < 400) return "发生了重定向：检查 http / https 与路径设置";
  if (status === 200) return "返回了普通网页：反向代理没有透传 Upgrade 头";
  return "服务器未同意 WebSocket 升级";
}

function toBuffer(data: WebSocket.RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

// ---------- the check itself ----------

export async function probeNode(node: ProbeTarget, probeUuid: string, target = CHECK_TARGET): Promise<CheckResult> {
  const scheme = node.tls ? "wss" : "ws";
  const defaultPort = node.tls ? 443 : 80;
  const url = `${scheme}://${node.host}${node.port === defaultPort ? "" : `:${node.port}`}${node.path}`;
  const serverName = node.sni || node.host;
  const detail: CheckDetail = { url, target };
  const started = Date.now();
  const fail = (stage: CheckStage, message: string): CheckResult => ({
    ok: false,
    stage,
    message,
    latencyMs: Date.now() - started,
    detail,
  });

  // 1. DNS
  if (!net.isIP(node.host)) {
    const t0 = Date.now();
    try {
      const records = await dns.lookup(node.host, { all: true });
      detail.ip = records.map((r) => r.address).join(", ");
      detail.dnsMs = Date.now() - t0;
    } catch (err) {
      return fail("dns", `域名解析失败（${(err as NodeJS.ErrnoException).code ?? "unknown"}）：检查 DNS 记录是否正确`);
    }
  } else {
    detail.ip = node.host;
  }

  // 2-4. TCP/TLS → WebSocket → tunnel relay
  const [targetHost, targetPortStr] = target.split(":");
  const targetPort = Number(targetPortStr) || 80;
  const httpRequest = Buffer.from(`GET / HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: s5-node-check/1.0\r\nConnection: close\r\n\r\n`);

  return new Promise<CheckResult>((resolve) => {
    let settled = false;
    let opened = false;
    let gotTunnelHeader = false;
    let buf: Buffer = Buffer.alloc(0);

    const ws = new WebSocket(url, {
      headers: { Host: serverName, "User-Agent": "s5-node-check/1.0" },
      ...(node.tls && !net.isIP(serverName) ? { servername: serverName } : {}),
      handshakeTimeout: TIMEOUT_MS,
      perMessageDeflate: false,
      followRedirects: false,
    });

    const done = (r: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        /* noop */
      }
      resolve(r);
    };

    const timer = setTimeout(() => {
      if (!opened) done(fail("connect", "连接超时：被防火墙拦截或网络不可达"));
      else if (!gotTunnelHeader) done(fail("tunnel", "已连接但节点无响应：隧道服务可能未运行或反向代理未转发数据"));
      else done(fail("tunnel", `隧道已建立，但目标 ${target} 无响应：检查节点服务器的出站网络`));
    }, TIMEOUT_MS + 1000);

    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      detail.httpStatus = status;
      done(fail("handshake", `服务器返回 HTTP ${status}：${describeHttpStatus(status)}`));
    });

    ws.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (!opened && /Opening handshake has timed out/i.test(e.message ?? "")) {
        return done(fail("handshake", "WebSocket 握手超时：已连上服务器但未响应升级请求（检查反向代理是否把该路径转发给了隧道服务）"));
      }
      done(fail(opened ? "tunnel" : "connect", describeError(e)));
    });

    ws.on("open", () => {
      opened = true;
      detail.connectMs = Date.now() - started;
      ws.send(Buffer.concat([buildProbeHeader(probeUuid, targetHost, targetPort), httpRequest]));
    });

    ws.on("message", (data) => {
      buf = buf.length ? Buffer.concat([buf, toBuffer(data)]) : toBuffer(data);
      if (buf.length < 2) return;
      if (buf[0] !== 0) return done(fail("tunnel", "节点返回的数据格式不正确（不是本服务的隧道协议）"));
      gotTunnelHeader = true;
      const addons = buf[1];
      if (buf.length < 2 + addons + 8) return; // wait for the start of the HTTP status line
      const firstLine = buf
        .subarray(2 + addons)
        .toString("latin1")
        .split("\r\n")[0]
        .slice(0, 40);
      const total = Date.now() - started;
      detail.tunnelMs = total - (detail.connectMs ?? 0);
      done({
        ok: true,
        stage: "ok",
        message: `正常 · 目标响应「${firstLine}」`,
        latencyMs: total,
        detail,
      });
    });

    ws.on("close", (code, reason) => {
      if (settled) return;
      const r = reason.toString();
      // Reasons produced by this server's own relay when the upstream misbehaves.
      if (r.startsWith("upstream rejected")) {
        return done(fail("auth", `上游拒绝了配置的凭据（${r.replace(/^upstream rejected:\s*/, "")}）：UUID 错误、已停用或流量用尽`));
      }
      if (r.startsWith("upstream http")) {
        const status = Number(r.replace(/\D/g, "")) || 0;
        return done(fail("tunnel", `本站无法与上游握手（HTTP ${status}）：${describeHttpStatus(status)}`));
      }
      if (r.startsWith("upstream unreachable") || r.startsWith("upstream closed") || r.startsWith("upstream connect")) {
        return done(fail("tunnel", `本站无法连接上游节点（${r.replace(/^upstream\s*/, "")}）`));
      }
      if (r === "unknown route") {
        return done(fail("tunnel", "本站没有该转发路由：节点已删除、已停用或缺少凭据"));
      }
      if (code === 1008) {
        done(
          fail(
            "auth",
            `握手成功但节点拒绝了本站凭据（${r || "unauthorized"}）：该地址上的服务不属于本站（数据库不同）或版本过旧，用户同样无法使用`,
          ),
        );
      } else if (code === 1011) {
        done(fail("tunnel", `节点无法连接外网目标 ${target}：检查节点服务器的出站网络 / DNS`));
      } else {
        done(fail(opened ? "tunnel" : "connect", `连接在收到响应前被关闭（${code}${r ? " " + r : ""}）`));
      }
    });
  });
}

// ---------- persistence ----------

async function recordCheck(nodeId: string, result: CheckResult, source: string) {
  const now = new Date();
  await db
    .update(nodes)
    .set({
      lastCheckAt: now,
      lastCheckOk: result.ok,
      lastCheckLatencyMs: result.latencyMs,
      lastCheckStage: result.stage,
      lastCheckMessage: result.message,
    })
    .where(eq(nodes.id, nodeId));
  await db.insert(nodeChecks).values({
    nodeId,
    ok: result.ok,
    latencyMs: result.latencyMs,
    stage: result.stage,
    message: result.message,
    source,
    createdAt: now,
  });
}

function stageLabel(stage: CheckStage): string {
  return STAGE_LABELS[stage] ?? stage;
}

/** Probe an upstream node: directly with its own credential, and (relay mode) through this site's entry. */
async function checkUpstreamNode(node: Node, baseUrl: string, loopback: boolean): Promise<CheckResult> {
  const up = parseUpstreamUrl(node.upstreamUrl);
  if (!up || !node.upstreamUuid) {
    return {
      ok: false,
      stage: "connect",
      message: "上游地址或凭据未填写",
      latencyMs: 0,
      detail: { url: node.upstreamUrl ?? "", target: CHECK_TARGET },
    };
  }
  const directPromise = probeNode({ host: up.host, port: up.port, path: up.path, tls: up.tls, sni: node.upstreamSni }, node.upstreamUuid);

  if (!node.relay) {
    const direct = await directPromise;
    return direct.ok
      ? { ...direct, message: `正常（用户直连上游）· ${direct.latencyMs} ms · ${direct.message.replace(/^正常 · /, "")}` }
      : { ...direct, message: `上游节点异常（${stageLabel(direct.stage)}）：${direct.message}` };
  }

  const entry = resolveNode(node, baseUrl);
  const probeUuid = await ensureProbeCredential();
  const [direct, viaEntry] = await Promise.all([directPromise, probeNode(entry, probeUuid)]);

  const entryLabel = loopback ? "经本站转发（本机自检）" : "经本站转发";
  if (direct.ok && viaEntry.ok) {
    return {
      ok: true,
      stage: "ok",
      latencyMs: viaEntry.latencyMs,
      message: `正常 · ${entryLabel} ${viaEntry.latencyMs} ms · 上游直连 ${direct.latencyMs} ms · ${viaEntry.message.replace(/^正常 · /, "")}`,
      detail: viaEntry.detail,
    };
  }
  if (!direct.ok) {
    return { ...direct, message: `上游节点异常（${stageLabel(direct.stage)}）：${direct.message}` };
  }
  return { ...viaEntry, message: `上游本身正常，但经本站入口转发失败（${stageLabel(viaEntry.stage)}）：${viaEntry.message}` };
}

export async function runNodeCheck(node: Node, baseUrl: string, source: "manual" | "auto", loopback = false) {
  let result: CheckResult;
  if (node.kind === "upstream") {
    result = await checkUpstreamNode(node, baseUrl, loopback);
  } else {
    const resolved = resolveNode(node, baseUrl);
    const probeUuid = await ensureProbeCredential();
    result = await probeNode(resolved, probeUuid);
    if (loopback && resolved.auto) {
      result.message = `本机自检（尚未获取公网地址）· ${result.message}`;
    }
  }
  await recordCheck(node.id, result, source);
  return result;
}

export async function runAllNodeChecks(baseUrl: string, source: "manual" | "auto", onlyEnabled: boolean, loopback = false) {
  const list = await db.select().from(nodes);
  const targets = onlyEnabled ? list.filter((n) => n.enabled) : list;
  const results = await Promise.all(
    targets.map(async (n) => {
      try {
        return { node: n, result: await runNodeCheck(n, baseUrl, source, loopback) };
      } catch (err) {
        console.error(`[node-check] ${n.name} failed`, err);
        return null;
      }
    }),
  );
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
}

export async function getRecentChecks(hours = 24) {
  return db
    .select()
    .from(nodeChecks)
    .where(gt(nodeChecks.createdAt, new Date(Date.now() - hours * 3600 * 1000)))
    .orderBy(desc(nodeChecks.createdAt));
}

// ---------- background scheduler ----------

declare global {
  // eslint-disable-next-line no-var
  var __s5NodeCheckScheduler: boolean | undefined;
}

export const checkIntervalMinutes = CHECK_INTERVAL_MIN;

export function startNodeCheckScheduler() {
  if (globalThis.__s5NodeCheckScheduler) return;
  if (!(CHECK_INTERVAL_MIN > 0)) {
    console.log("[node-check] automatic checks disabled (NODE_CHECK_INTERVAL_MIN=0)");
    return;
  }
  globalThis.__s5NodeCheckScheduler = true;

  const run = async () => {
    try {
      const { url, loopback } = await getCheckBaseUrl();
      const results = await runAllNodeChecks(url, "auto", true, loopback);
      await setSetting(SETTING_LAST_AUTO_CHECK, new Date().toISOString());
      await db.delete(nodeChecks).where(lt(nodeChecks.createdAt, new Date(Date.now() - HISTORY_RETENTION_MS)));
      const bad = results.filter((r) => !r.result.ok);
      console.log(
        `[node-check] auto check: ${results.length - bad.length} ok, ${bad.length} failed` +
          (bad.length ? ` (${bad.map((b) => `${b.node.name}: ${b.result.message}`).join("; ")})` : ""),
      );
    } catch (err) {
      console.error("[node-check] scheduled run failed", err);
    }
  };

  const initial = setTimeout(() => void run(), Number(process.env.NODE_CHECK_INITIAL_DELAY_MS || 20000));
  initial.unref();
  const timer = setInterval(() => void run(), CHECK_INTERVAL_MIN * 60 * 1000);
  timer.unref();
  console.log(`[node-check] scheduler started (every ${CHECK_INTERVAL_MIN} min, target ${CHECK_TARGET})`);
}
