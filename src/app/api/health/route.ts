import { db } from "@/db";
import { sql } from "drizzle-orm";
import { ensureInstanceId } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    let instance: string | undefined;
    try {
      instance = await ensureInstanceId();
    } catch {
      /* settings table may not exist yet during bootstrap */
    }
    return Response.json({ ok: true, instance });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
