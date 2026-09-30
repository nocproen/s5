import { readFile } from "fs/promises";
import path from "path";
import { getCurrentUser } from "@/lib/auth";
import { getResolvedEnabledNodes } from "@/lib/nodes";
import { buildWsUrl, nodeUuid } from "@/lib/links";
import { getBaseUrl } from "@/lib/site";
import { getClient, personalize } from "@/lib/clients";

export const dynamic = "force-dynamic";

/**
 * Personalized client download.
 *   GET /api/client/download?lang=python&node=<nodeId>
 *   GET /api/client/download?lang=rust&extra=0     -> auxiliary file (Cargo.toml / .csproj)
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const client = getClient(url.searchParams.get("lang"));
  const nodeList = await getResolvedEnabledNodes(await getBaseUrl());
  const selected = nodeList.find((n) => n.id === url.searchParams.get("node")) ?? nodeList[0];
  const serverUrl = selected ? buildWsUrl(selected) : "";

  const extraIdx = url.searchParams.get("extra");
  if (extraIdx !== null) {
    const extra = client.extraFiles?.[Number(extraIdx)];
    if (!extra) return new Response("Not Found", { status: 404 });
    const source = await readFile(path.join(process.cwd(), "public", extra.file), "utf8");
    return new Response(source, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${extra.downloadName}"`,
        "cache-control": "no-store",
      },
    });
  }

  const source = await readFile(path.join(process.cwd(), "public", client.file), "utf8");
  return new Response(personalize(source, serverUrl, selected ? nodeUuid(selected, user.proxyUuid) : user.proxyUuid), {
    headers: {
      "content-type": client.contentType,
      "content-disposition": `attachment; filename="${client.downloadName}"`,
      "cache-control": "no-store",
    },
  });
}
