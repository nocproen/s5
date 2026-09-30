import { parseUpstreamUrl } from "@/lib/nodes";

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type ImportedNode = {
  name: string;
  /** normalized wss://host[:port]/path */
  url: string;
  uuid: string;
  /** Host / SNI override for the upstream connection */
  sni: string | null;
};

export type ImportResult = { nodes: ImportedNode[]; errors: string[] };

/**
 * Parse pasted node credentials, one per line. Supported formats:
 *   wss://host/path --uuid <UUID>                (our lightweight-client command line, extra flags ignored)
 *   wss://host/path <UUID>
 *   vless://<UUID>@host:port?type=ws&path=/x&security=tls&sni=...#name
 */
export function parseNodeImport(text: string): ImportResult {
  const out: ImportResult = { nodes: [], errors: [] };
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  lines.forEach((line, i) => {
    const label = `第 ${i + 1} 行`;
    if (/^vless:\/\//i.test(line)) {
      const r = parseVless(line);
      if (typeof r === "string") out.errors.push(`${label}：${r}`);
      else out.nodes.push(r);
      return;
    }
    const urlMatch = line.match(/(wss?|https?):\/\/[^\s'"]+/i);
    const uuidMatch = line.match(UUID_RE);
    if (!urlMatch || !uuidMatch) {
      out.errors.push(`${label}：无法识别，需要「wss://地址/路径 --uuid UUID」或 vless:// 链接`);
      return;
    }
    const up = parseUpstreamUrl(urlMatch[0]);
    if (!up) {
      out.errors.push(`${label}：地址格式不正确`);
      return;
    }
    const nameMatch = line.match(/(?:--name|#)\s*([^\s#]+)/);
    out.nodes.push({ name: nameMatch?.[1] ?? up.host, url: up.url, uuid: uuidMatch[0].toLowerCase(), sni: null });
  });
  return out;
}

function parseVless(line: string): ImportedNode | string {
  const m = line.match(/^vless:\/\/([^@]+)@(.+)$/i);
  if (!m) return "vless 链接格式不正确";
  const uuid = m[1];
  if (!UUID_RE.test(uuid)) return "vless 链接中的 UUID 不正确";
  let rest = m[2];
  let name = "";
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    try {
      name = decodeURIComponent(rest.slice(hashIdx + 1));
    } catch {
      name = rest.slice(hashIdx + 1);
    }
    rest = rest.slice(0, hashIdx);
  }
  let query = "";
  const qIdx = rest.indexOf("?");
  if (qIdx >= 0) {
    query = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }
  let host: string;
  let port: number;
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    host = rest.slice(1, end);
    port = Number(rest.slice(end + 2)) || 443;
  } else {
    const idx = rest.lastIndexOf(":");
    host = idx > 0 ? rest.slice(0, idx) : rest;
    port = idx > 0 ? Number(rest.slice(idx + 1)) || 443 : 443;
  }
  const params = new URLSearchParams(query);
  const type = (params.get("type") ?? "tcp").toLowerCase();
  if (type !== "ws") return `仅支持 WebSocket 传输的节点（type=ws），该链接为 ${type}`;
  const security = (params.get("security") ?? "none").toLowerCase();
  if (security === "reality") return "不支持 REALITY 节点";
  const tls = security === "tls";
  const path = params.get("path") || "/";
  const sni = params.get("sni") || params.get("host") || null;
  const hostPart = host.includes(":") ? `[${host}]` : host;
  const defaultPort = tls ? 443 : 80;
  const url = `${tls ? "wss" : "ws"}://${hostPart}${port === defaultPort ? "" : `:${port}`}${path.startsWith("/") ? path : `/${path}`}`;
  return { name: name || host, url, uuid: uuid.toLowerCase(), sni: sni && sni !== host ? sni : null };
}
