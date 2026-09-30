import { sql } from "drizzle-orm";
import { db } from "@/db";
import { admins } from "@/db/schema";
import { hashPassword } from "@/lib/password";

export const DEFAULT_ADMIN_USERNAME = "admin";
export const DEFAULT_ADMIN_PASSWORD = "admin123456";

/**
 * Create the initial backend administrator on first boot.
 * Credentials come from ADMIN_USERNAME / ADMIN_PASSWORD; when ADMIN_PASSWORD is
 * not set a well-known default is used and the account is flagged so the panel
 * nags until it is changed.
 */
export async function ensureDefaultAdmin() {
  try {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(admins);
    if (Number(count) > 0) return;
    const username = (process.env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME).trim();
    const envPassword = process.env.ADMIN_PASSWORD?.trim();
    await db.insert(admins).values({
      username,
      passwordHash: hashPassword(envPassword || DEFAULT_ADMIN_PASSWORD),
      mustChangePassword: !envPassword,
    });
    console.log(
      `[admin] seeded administrator "${username}"${
        envPassword ? "" : ` with the default password "${DEFAULT_ADMIN_PASSWORD}" — change it at /admin/settings`
      }`,
    );
  } catch (err) {
    console.error("[admin] ensureDefaultAdmin failed", err);
  }
}
