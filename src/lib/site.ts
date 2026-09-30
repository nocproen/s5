import "server-only";
import { headers } from "next/headers";

const LOCAL_HOST_RE = /^(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Public base URL of this site as currently visited (for subscription links and auto nodes).
 *
 * Protocol detection: `NEXT_PUBLIC_SITE_URL` wins; then a proxy-provided
 * `x-forwarded-proto: https`; otherwise a public hostname without an explicit port is
 * assumed to be TLS-terminated by whatever sits in front (Next.js itself injects
 * `x-forwarded-proto: http` when the proxy does not send one, so that value alone is not
 * trustworthy). Local / IP / explicit-port hosts are treated as plain http.
 */
export async function getBaseUrl(): Promise<string> {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000").split(",")[0].trim();
  const forwardedProto = h.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase();

  const hostname = host.replace(/:\d+$/, "");
  const hasExplicitPort = /:\d+$/.test(host) && !host.endsWith(":443");
  const isLocal = LOCAL_HOST_RE.test(hostname);
  const isIp = IPV4_RE.test(hostname);

  let proto: "http" | "https";
  if (forwardedProto === "https") proto = "https";
  else if (isLocal || isIp || hasExplicitPort) proto = "http";
  else proto = "https";

  return `${proto}://${host.replace(/:443$/, "")}`;
}
