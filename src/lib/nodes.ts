import { asc, eq, isNull } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db } from "@/db";
import { nodes, type Node } from "@/db/schema";

/**
 * A node whose host is AUTO_HOST follows the address the website is currently
 * being visited on (host, port and TLS are derived from the request), because the
 * tunnel is also served through the web server's own port at TUNNEL_PATH.
 */
export const AUTO_HOST = "auto";

export type UpstreamAddress = { host: string; port: number; path: string; tls: boolean; url: string };

export type ResolvedNode = Node & {
  /** entry address follows the current site URL */
  auto: boolean;
  /** UUID users must use instead of their own (upstream "direct" mode), null = user's own UUID */
  credential: string | null;
  /** traffic enters this site and is relayed to an upstream */
  relayed: boolean;
  upstream: UpstreamAddress | null;
};

export function tunnelPath(): string {
  const p = process.env.TUNNEL_PATH || "/tunnel";
  return p.startsWith("/") ? p : `/${p}`;
}

export function generateRouteKey(): string {
  return randomBytes(6).toString("base64url"); // 8 chars, [A-Za-z0-9_-]
}

/** Parse "wss://host[:port]/path" (also accepts http(s):// and ws://). */
export function parseUpstreamUrl(raw: string | null | undefined): UpstreamAddress | null {
  if (!raw) return null;
  let s = raw.trim();
  if (/^https:\/\//i.test(s)) s = "wss://" + s.slice(8);
  else if (/^http:\/\//i.test(s)) s = "ws://" + s.slice(7);
  else if (!/^wss?:\/\//i.test(s)) s = "wss://" + s;
  try {
    const u = new URL(s);
    const tls = u.protocol === "wss:";
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const port = u.port ? Number(u.port) : tls ? 443 : 80;
    const path = (u.pathname || "/") + (u.search || "");
    const defaultPort = tls ? 443 : 80;
    const url = `${tls ? "wss" : "ws"}://${u.hostname}${port === defaultPort ? "" : `:${port}`}${path}`;
    return { host, port, path, tls, url };
  } catch {
    return null;
  }
}

function siteEntry(baseUrl: string): { host: string; port: number; tls: boolean } {
  try {
    const u = new URL(baseUrl);
    const tls = u.protocol === "https:";
    return { host: u.hostname, port: u.port ? Number(u.port) : tls ? 443 : 80, tls };
  } catch {
    return { host: "localhost", port: 80, tls: false };
  }
}

export function resolveNode(node: Node, baseUrl: string): ResolvedNode {
  const upstream = node.kind === "upstream" ? parseUpstreamUrl(node.upstreamUrl) : null;

  if (node.kind === "upstream" && upstream) {
    if (!node.relay) {
      // Direct mode: users connect straight to the upstream with the shared credential.
      return {
        ...node,
        host: upstream.host,
        port: upstream.port,
        tls: upstream.tls,
        path: upstream.path,
        sni: node.upstreamSni ?? null,
        auto: false,
        credential: node.upstreamUuid,
        relayed: false,
        upstream,
      };
    }
    // Relay mode: users connect to this site at a per-node path; the tunnel forwards to the upstream.
    const isAuto = node.host === AUTO_HOST || !node.host;
    const entry = isAuto ? { ...siteEntry(baseUrl), sni: null } : { host: node.host, port: node.port, tls: node.tls, sni: node.sni };
    return {
      ...node,
      ...entry,
      path: `${tunnelPath()}/${node.routeKey ?? ""}`,
      auto: isAuto,
      credential: null,
      relayed: true,
      upstream,
    };
  }

  if (node.host !== AUTO_HOST) return { ...node, auto: false, credential: null, relayed: false, upstream: null };
  return {
    ...node,
    ...siteEntry(baseUrl),
    sni: null,
    path: tunnelPath(),
    auto: true,
    credential: null,
    relayed: false,
    upstream: null,
  };
}

export async function getEnabledNodes() {
  return db
    .select()
    .from(nodes)
    .where(eq(nodes.enabled, true))
    .orderBy(asc(nodes.sortOrder), asc(nodes.createdAt));
}

export async function getResolvedEnabledNodes(baseUrl: string): Promise<ResolvedNode[]> {
  const list = await getEnabledNodes();
  return list
    .map((n) => resolveNode(n, baseUrl))
    .filter((n) => n.kind !== "upstream" || (n.upstream && n.upstreamUuid && (!n.relayed || n.routeKey)));
}

export async function getAllNodes() {
  return db.select().from(nodes).orderBy(asc(nodes.sortOrder), asc(nodes.createdAt));
}

/** Give every node a route key (older rows were created before relaying existed). */
export async function ensureRouteKeys() {
  try {
    const missing = await db.select({ id: nodes.id }).from(nodes).where(isNull(nodes.routeKey));
    for (const row of missing) {
      await db.update(nodes).set({ routeKey: generateRouteKey() }).where(eq(nodes.id, row.id));
    }
    if (missing.length) console.log(`[tunnel] assigned route keys to ${missing.length} node(s)`);
  } catch (err) {
    console.error("[tunnel] ensureRouteKeys failed", err);
  }
}

/**
 * Seed a default node on first boot so that new deployments work out of the box.
 * - With TUNNEL_PUBLIC_HOST set: a fixed node pointing at that host.
 * - Otherwise: an "auto" node that follows the current site address.
 */
export async function ensureDefaultNode() {
  try {
    const all = await getAllNodes();
    const publicHost = process.env.TUNNEL_PUBLIC_HOST;

    if (all.length === 0) {
      if (publicHost) {
        const tls = process.env.TUNNEL_PUBLIC_TLS ? process.env.TUNNEL_PUBLIC_TLS === "true" : true;
        const port = Number(process.env.TUNNEL_PUBLIC_PORT || (tls ? 443 : 80));
        await db.insert(nodes).values({
          name: process.env.TUNNEL_PUBLIC_NAME || "默认节点",
          host: publicHost,
          port,
          path: tunnelPath(),
          tls,
          enabled: true,
          sortOrder: 0,
          routeKey: generateRouteKey(),
        });
        console.log(`[tunnel] seeded default node ${publicHost}:${port}`);
      } else {
        await db.insert(nodes).values({
          name: process.env.TUNNEL_PUBLIC_NAME || "当前站点（自动跟随网址）",
          host: AUTO_HOST,
          port: 443,
          path: tunnelPath(),
          tls: true,
          enabled: true,
          sortOrder: 0,
          routeKey: generateRouteKey(),
        });
        console.log("[tunnel] seeded auto node (follows the site address)");
      }
      return;
    }

    // Upgrade the legacy local test node created by earlier versions.
    const legacy = all.find((n) => n.host === "127.0.0.1" && n.name === "本地测试节点");
    if (legacy && !publicHost) {
      await db
        .update(nodes)
        .set({ name: "当前站点（自动跟随网址）", host: AUTO_HOST, port: 443, tls: true, path: tunnelPath() })
        .where(eq(nodes.id, legacy.id));
      console.log("[tunnel] converted legacy local node to auto node");
    }
  } catch (err) {
    console.error("[tunnel] ensureDefaultNode failed", err);
  }
}
