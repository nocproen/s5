import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getResolvedEnabledNodes } from "@/lib/nodes";
import { getBaseUrl } from "@/lib/site";
import { buildClashConfig, buildSubscriptionBody } from "@/lib/links";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const [user] = await db.select().from(users).where(eq(users.subToken, token)).limit(1);
  if (!user || !user.enabled) {
    return new Response("Not Found", { status: 404 });
  }
  const url = new URL(req.url);
  const ua = (req.headers.get("user-agent") ?? "").toLowerCase();
  const wantsClash =
    url.searchParams.get("format") === "clash" ||
    (!url.searchParams.get("format") && (ua.includes("clash") || ua.includes("mihomo") || ua.includes("stash")));

  const nodeList = await getResolvedEnabledNodes(await getBaseUrl());
  const used = Number(user.uploadBytes) + Number(user.downloadBytes);
  const expire = user.expiresAt ? Math.floor(user.expiresAt.getTime() / 1000) : 0;
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "profile-update-interval": "12",
    "subscription-userinfo": `upload=${user.uploadBytes}; download=${user.downloadBytes}; total=${user.quotaBytes}; expire=${expire}`,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent("S5-Tunnel")}`,
  };

  if (wantsClash) {
    return new Response(buildClashConfig(nodeList, user.proxyUuid), {
      headers: { ...headers, "content-type": "text/yaml; charset=utf-8" },
    });
  }
  void used;
  return new Response(buildSubscriptionBody(nodeList, user.proxyUuid), {
    headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
  });
}
