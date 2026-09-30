import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { admins, adminSessions, type Admin } from "@/db/schema";
import { generateToken } from "@/lib/password";

/**
 * Backend administrator authentication.
 * Completely independent from end-user auth: different table, different cookie,
 * different session store. A normal user can never become an admin by registering.
 */
const ADMIN_COOKIE = "s5_admin";
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

export async function createAdminSession(adminId: string) {
  const id = generateToken(32);
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS);
  await db.insert(adminSessions).values({ id, adminId, expiresAt });
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_COOKIE, id, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroyAdminSession() {
  const cookieStore = await cookies();
  const id = cookieStore.get(ADMIN_COOKIE)?.value;
  if (id) {
    await db.delete(adminSessions).where(eq(adminSessions.id, id));
  }
  cookieStore.delete(ADMIN_COOKIE);
}

export const getCurrentAdmin = cache(async (): Promise<Admin | null> => {
  const cookieStore = await cookies();
  const id = cookieStore.get(ADMIN_COOKIE)?.value;
  if (!id) return null;
  const rows = await db
    .select({ admin: admins })
    .from(adminSessions)
    .innerJoin(admins, eq(adminSessions.adminId, admins.id))
    .where(and(eq(adminSessions.id, id), gt(adminSessions.expiresAt, new Date())))
    .limit(1);
  return rows[0]?.admin ?? null;
});

/** Returns the current admin or redirects to the admin login page. */
export async function requireAdmin(): Promise<Admin> {
  const admin = await getCurrentAdmin();
  if (!admin) redirect("/admin/login");
  return admin;
}

export async function getClientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || "unknown";
}

// ---------- simple in-memory brute-force protection for the admin login ----------

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

type Bucket = { count: number; resetAt: number };
const globalBuckets = globalThis as typeof globalThis & { __s5AdminLoginBuckets?: Map<string, Bucket> };
const buckets = (globalBuckets.__s5AdminLoginBuckets ??= new Map<string, Bucket>());

/** Seconds the caller still has to wait, or 0 when a login attempt is allowed. */
export function loginBlockedFor(key: string): number {
  const b = buckets.get(key);
  if (!b) return 0;
  if (Date.now() > b.resetAt) {
    buckets.delete(key);
    return 0;
  }
  return b.count >= MAX_FAILURES ? Math.ceil((b.resetAt - Date.now()) / 1000) : 0;
}

export function recordLoginFailure(key: string) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    b.count += 1;
  }
}

export function clearLoginFailures(key: string) {
  buckets.delete(key);
}
