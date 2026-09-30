import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "@/db";
import { settings } from "@/db/schema";

export const SETTING_PROBE_UUID = "probe_uuid";
export const SETTING_LAST_BASE_URL = "last_base_url";
export const SETTING_LAST_AUTO_CHECK = "last_auto_check_at";
export const SETTING_INSTANCE_ID = "instance_id";

let instanceIdCache: string | null = null;

/** Random public identifier of this deployment (exposed by /api/health) used to recognise our own URL. */
export async function ensureInstanceId(): Promise<string> {
  if (instanceIdCache) return instanceIdCache;
  const existing = await getSetting(SETTING_INSTANCE_ID);
  if (existing) return (instanceIdCache = existing);
  const id = randomUUID();
  await setSetting(SETTING_INSTANCE_ID, id);
  return (instanceIdCache = id);
}

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? null;
}

/** Create the settings table if it does not exist yet (standalone node servers may start before the web app). */
export async function ensureSettingsTable() {
  await db.execute(sql`create table if not exists settings (
    key text primary key,
    value text not null,
    updated_at timestamptz not null default now()
  )`);
}

export async function setSetting(key: string, value: string) {
  await db
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/**
 * Secret credential used by node health checks. The tunnel accepts it like a user
 * UUID but does not bill traffic, caps each probe connection to a few hundred KB and
 * a short lifetime, and only allows TCP. It never leaves the server.
 */
export async function ensureProbeCredential(): Promise<string> {
  const existing = await getSetting(SETTING_PROBE_UUID);
  if (existing) return existing;
  const uuid = randomUUID();
  await setSetting(SETTING_PROBE_UUID, uuid);
  console.log("[node-check] generated probe credential");
  return uuid;
}

let lastRemembered: string | null = null;

/** Remember the public site URL (seen on admin requests) so background checks can test `auto` nodes. */
export async function rememberBaseUrl(url: string) {
  if (!url || url === lastRemembered) return;
  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url)) return;
  lastRemembered = url;
  try {
    await setSetting(SETTING_LAST_BASE_URL, url);
  } catch (err) {
    console.error("[node-check] rememberBaseUrl failed", err);
  }
}

/** True when `${url}/api/health` is answered by this very deployment. */
async function isOurInstance(url: string): Promise<boolean | "unreachable"> {
  try {
    const instance = await ensureInstanceId();
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (!res.ok) return "unreachable";
    const body = (await res.json()) as { instance?: string };
    return body.instance === instance;
  } catch {
    return "unreachable";
  }
}

/**
 * Base URL used by the background checker for `auto` nodes and relay entries.
 * A remembered URL is only trusted if it still points at this deployment; otherwise
 * we fall back to loopback (self-test) so a moved / stale domain never produces
 * false alarms or sends the probe credential to someone else's server.
 */
export async function getCheckBaseUrl(): Promise<{ url: string; loopback: boolean }> {
  const loopback = { url: `http://127.0.0.1:${process.env.PORT ?? 3000}`, loopback: true };
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    const url = process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
    return (await isOurInstance(url)) === true ? { url, loopback: false } : loopback;
  }
  const remembered = (await getSetting(SETTING_LAST_BASE_URL)) || null;
  if (!remembered) return loopback;
  const verdict = await isOurInstance(remembered);
  if (verdict === true) return { url: remembered, loopback: false };
  if (verdict === false) {
    console.warn(`[node-check] remembered site URL ${remembered} now serves a different instance, forgetting it`);
    lastRemembered = null;
    await setSetting(SETTING_LAST_BASE_URL, "");
  }
  return loopback;
}
