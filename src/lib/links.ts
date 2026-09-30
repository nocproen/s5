import type { Node } from "@/db/schema";

export type NodeLike = Pick<Node, "name" | "host" | "port" | "path" | "tls" | "sni"> & {
  /** UUID to use instead of the user's own (upstream nodes in direct mode) */
  credential?: string | null;
};

/** UUID a user must present for a node. */
export function nodeUuid(node: NodeLike, userUuid: string): string {
  return node.credential ?? userUuid;
}

/** Standard VLESS share link (compatible with v2rayN / v2rayNG / Shadowrocket / Clash Meta / Hiddify). */
export function buildVlessLink(node: NodeLike, uuid: string, label?: string): string {
  const params = new URLSearchParams();
  params.set("encryption", "none");
  params.set("security", node.tls ? "tls" : "none");
  params.set("type", "ws");
  params.set("host", node.sni || node.host);
  params.set("path", node.path);
  if (node.tls) {
    params.set("sni", node.sni || node.host);
    params.set("fp", "chrome");
  }
  const tag = encodeURIComponent(label ?? node.name);
  return `vless://${uuid}@${node.host}:${node.port}?${params.toString()}#${tag}`;
}

/** WebSocket URL used by the lightweight Node.js client. */
export function buildWsUrl(node: NodeLike): string {
  const scheme = node.tls ? "wss" : "ws";
  const defaultPort = node.tls ? 443 : 80;
  const portPart = node.port === defaultPort ? "" : `:${node.port}`;
  return `${scheme}://${node.host}${portPart}${node.path}`;
}

/** v2ray-style subscription body: base64 of newline-separated share links. */
export function buildSubscriptionBody(nodeList: NodeLike[], uuid: string): string {
  const links = nodeList.map((n) => buildVlessLink(n, nodeUuid(n, uuid))).join("\n");
  return Buffer.from(links, "utf8").toString("base64");
}

/** Clash / Mihomo YAML config. */
export function buildClashConfig(nodeList: NodeLike[], uuid: string): string {
  const proxies = nodeList.map((n) => {
    const lines = [
      `  - name: "${n.name.replace(/"/g, "'")}"`,
      `    type: vless`,
      `    server: ${n.host}`,
      `    port: ${n.port}`,
      `    uuid: ${nodeUuid(n, uuid)}`,
      `    udp: true`,
      `    tls: ${n.tls}`,
      `    network: ws`,
      `    ws-opts:`,
      `      path: "${n.path}"`,
      `      headers:`,
      `        Host: ${n.sni || n.host}`,
    ];
    if (n.tls) {
      lines.push(`    servername: ${n.sni || n.host}`);
      lines.push(`    client-fingerprint: chrome`);
    }
    return lines.join("\n");
  });
  const names = nodeList.map((n) => `      - "${n.name.replace(/"/g, "'")}"`).join("\n");
  return [
    `mixed-port: 7890`,
    `socks-port: 1080`,
    `allow-lan: false`,
    `mode: rule`,
    `log-level: info`,
    `proxies:`,
    ...proxies,
    `proxy-groups:`,
    `  - name: "PROXY"`,
    `    type: select`,
    `    proxies:`,
    names,
    `rules:`,
    `  - GEOIP,CN,DIRECT`,
    `  - MATCH,PROXY`,
    ``,
  ].join("\n");
}

export function importUrls(subUrl: string, siteName = "S5 Tunnel") {
  const enc = encodeURIComponent(subUrl);
  const b64 = Buffer.from(subUrl, "utf8").toString("base64");
  return {
    v2rayng: `v2rayng://install-sub?url=${enc}&name=${encodeURIComponent(siteName)}`,
    clash: `clash://install-config?url=${encodeURIComponent(`${subUrl}?format=clash`)}&name=${encodeURIComponent(siteName)}`,
    shadowrocket: `shadowrocket://add/sub://${b64}?remark=${encodeURIComponent(siteName)}`,
    hiddify: `hiddify://import/${subUrl}`,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(d);
}
