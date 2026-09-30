import { getCurrentAdmin } from "@/lib/admin-auth";
import { getBaseUrl } from "@/lib/site";
import { buildNodePackageArchive } from "@/lib/node-package";

export const dynamic = "force-dynamic";

/**
 * Admin-only download of the standalone node-server source package.
 *   GET /api/admin/node-package?format=tar.gz|zip&withDb=1
 */
export async function GET(req: Request) {
  const admin = await getCurrentAdmin();
  if (!admin) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "zip" ? "zip" : "tar.gz";
  const includeDatabaseUrl = url.searchParams.get("withDb") === "1";

  try {
    const { data, filename, contentType } = await buildNodePackageArchive({
      siteUrl: await getBaseUrl(),
      databaseUrlHint: process.env.DATABASE_URL ?? "postgresql://USER:PASSWORD@DB_HOST:5432/app_db",
      includeDatabaseUrl,
      format,
    });
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": contentType,
        "content-length": String(data.length),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.error("[node-package] build failed", err);
    return new Response("打包失败，请查看服务器日志", { status: 500 });
  }
}
