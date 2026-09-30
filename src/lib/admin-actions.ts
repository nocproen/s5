"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { admins, adminSessions, nodes, users } from "@/db/schema";
import {
  clearLoginFailures,
  createAdminSession,
  destroyAdminSession,
  getClientIp,
  loginBlockedFor,
  recordLoginFailure,
  requireAdmin,
} from "@/lib/admin-auth";
import { hashPassword, verifyPassword } from "@/lib/password";
import { getBaseUrl } from "@/lib/site";
import { rememberBaseUrl } from "@/lib/settings";
import { runAllNodeChecks, runNodeCheck } from "@/lib/node-check";
import { AUTO_HOST, generateRouteKey, parseUpstreamUrl, tunnelPath } from "@/lib/nodes";
import { parseNodeImport, UUID_RE } from "@/lib/node-import";
import type { FormState } from "@/lib/actions";

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

// ---------------- admin session ----------------

export async function adminLoginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!username || !password) return { error: "请输入用户名和密码" };

  const key = `${await getClientIp()}:${username.toLowerCase()}`;
  const wait = loginBlockedFor(key);
  if (wait > 0) return { error: `失败次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试` };

  const [admin] = await db.select().from(admins).where(eq(admins.username, username)).limit(1);
  if (!admin || !verifyPassword(password, admin.passwordHash)) {
    recordLoginFailure(key);
    return { error: "用户名或密码错误" };
  }
  clearLoginFailures(key);
  await db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, admin.id));
  await createAdminSession(admin.id);
  redirect("/admin");
}

export async function adminLogoutAction() {
  await destroyAdminSession();
  redirect("/admin/login");
}

export async function adminChangePasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (!verifyPassword(current, admin.passwordHash)) return { error: "当前密码错误" };
  if (next.length < 10) return { error: "新密码至少 10 位" };
  if (next === current) return { error: "新密码不能与当前密码相同" };
  if (next !== confirm) return { error: "两次输入的新密码不一致" };
  await db
    .update(admins)
    .set({ passwordHash: hashPassword(next), mustChangePassword: false })
    .where(eq(admins.id, admin.id));
  revalidatePath("/admin", "layout");
  return { success: "管理员密码已更新" };
}

export async function adminCreateAdminAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireAdmin();
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!USERNAME_RE.test(username)) return { error: "用户名为 3-32 位字母、数字、_ . -" };
  if (password.length < 10) return { error: "密码至少 10 位" };
  const existing = await db.select({ id: admins.id }).from(admins).where(eq(admins.username, username)).limit(1);
  if (existing.length > 0) return { error: "该用户名已存在" };
  await db.insert(admins).values({ username, passwordHash: hashPassword(password) });
  revalidatePath("/admin/settings");
  return { success: `管理员 ${username} 已创建` };
}

export async function adminDeleteAdminAction(formData: FormData) {
  const me = await requireAdmin();
  const id = String(formData.get("id"));
  if (id === me.id) return;
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(admins);
  if (Number(count) <= 1) return;
  await db.delete(adminSessions).where(eq(adminSessions.adminId, id));
  await db.delete(admins).where(eq(admins.id, id));
  revalidatePath("/admin/settings");
}

// ---------------- end users ----------------

export async function adminToggleUserAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  const enabled = String(formData.get("enabled")) === "true";
  await db.update(users).set({ enabled }).where(eq(users.id, id));
  revalidatePath("/admin");
}

export async function adminUpdateUserAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  const quotaGb = Number(formData.get("quotaGb"));
  const expires = String(formData.get("expiresAt") ?? "").trim();
  const resetTraffic = formData.get("resetTraffic") === "on";
  await db
    .update(users)
    .set({
      quotaBytes: Number.isFinite(quotaGb) && quotaGb > 0 ? Math.round(quotaGb * 1024 ** 3) : undefined,
      expiresAt: expires ? new Date(expires) : null,
      ...(resetTraffic ? { uploadBytes: 0, downloadBytes: 0 } : {}),
    })
    .where(eq(users.id, id));
  revalidatePath("/admin");
}

export async function adminSetUserPasswordAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) return;
  await db.update(users).set({ passwordHash: hashPassword(password) }).where(eq(users.id, id));
  revalidatePath("/admin");
}

export async function adminDeleteUserAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  await db.delete(users).where(eq(users.id, id));
  revalidatePath("/admin");
}

// ---------------- nodes ----------------

export async function adminSaveNodeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const kind = String(formData.get("kind") ?? "local") === "upstream" ? "upstream" : "local";
  const name = String(formData.get("name") ?? "").trim() || "节点";
  const sortOrder = Number(formData.get("sortOrder")) || 0;

  let data: Partial<typeof nodes.$inferInsert>;

  if (kind === "upstream") {
    const up = parseUpstreamUrl(String(formData.get("upstreamUrl") ?? ""));
    const uuid = String(formData.get("upstreamUuid") ?? "").trim().toLowerCase();
    if (!up) return { error: "上游地址格式不正确，应为 wss://域名/路径" };
    if (!UUID_RE.test(uuid) || uuid.length !== 36) return { error: "上游 UUID 格式不正确" };
    const relay = String(formData.get("mode") ?? "relay") !== "direct";
    const entryHost = String(formData.get("host") ?? "").trim() || AUTO_HOST;
    data = {
      name,
      kind,
      upstreamUrl: up.url,
      upstreamUuid: uuid,
      upstreamSni: String(formData.get("upstreamSni") ?? "").trim() || null,
      relay,
      sortOrder,
      // relay: entry address on this site; direct: mirror the upstream address for display
      host: relay ? entryHost : up.host,
      port: relay ? Number(formData.get("port")) || 443 : up.port,
      tls: relay ? formData.get("tls") !== "off" && formData.get("tls") !== null : up.tls,
      sni: relay ? String(formData.get("sni") ?? "").trim() || null : null,
      path: relay ? tunnelPath() : up.path,
    };
    if (relay && entryHost === AUTO_HOST) {
      data.port = 443;
      data.tls = true;
      data.sni = null;
    }
  } else {
    const host = String(formData.get("host") ?? "").trim();
    if (!host) return { error: "请填写域名 / IP" };
    let path = String(formData.get("path") ?? "/tunnel").trim() || "/tunnel";
    if (!path.startsWith("/")) path = `/${path}`;
    data = {
      name,
      kind,
      host,
      port: Number(formData.get("port")) || 443,
      path,
      tls: formData.get("tls") === "on",
      sni: String(formData.get("sni") ?? "").trim() || null,
      sortOrder,
      upstreamUrl: null,
      upstreamUuid: null,
      upstreamSni: null,
      relay: true,
    };
  }

  if (id) {
    await db.update(nodes).set(data).where(eq(nodes.id, id));
  } else {
    await db.insert(nodes).values({ ...(data as typeof nodes.$inferInsert), enabled: true, routeKey: generateRouteKey() });
  }
  revalidatePath("/admin/nodes");
  revalidatePath("/dashboard");
  return { success: id ? "节点已保存" : "节点已添加" };
}

/** Paste "wss://host/path --uuid UUID" lines or vless:// links to add upstream nodes in bulk. */
export async function adminImportNodesAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireAdmin();
  const text = String(formData.get("text") ?? "");
  const relay = String(formData.get("mode") ?? "relay") !== "direct";
  const parsed = parseNodeImport(text);
  if (parsed.nodes.length === 0) {
    return { error: parsed.errors[0] ?? "没有可导入的内容" };
  }
  const existing = await db.select({ url: nodes.upstreamUrl, uuid: nodes.upstreamUuid }).from(nodes).where(eq(nodes.kind, "upstream"));
  const seen = new Set(existing.map((e) => `${e.url}|${e.uuid}`));
  let added = 0;
  let skipped = 0;
  for (const n of parsed.nodes) {
    const key = `${n.url}|${n.uuid}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const up = parseUpstreamUrl(n.url)!;
    await db.insert(nodes).values({
      name: n.name,
      kind: "upstream",
      upstreamUrl: n.url,
      upstreamUuid: n.uuid,
      upstreamSni: n.sni,
      relay,
      host: relay ? AUTO_HOST : up.host,
      port: relay ? 443 : up.port,
      tls: relay ? true : up.tls,
      sni: relay ? null : n.sni,
      path: relay ? tunnelPath() : up.path,
      enabled: true,
      sortOrder: 0,
      routeKey: generateRouteKey(),
    });
    added++;
  }
  revalidatePath("/admin/nodes");
  revalidatePath("/dashboard");
  const parts = [`已导入 ${added} 个节点`];
  if (skipped) parts.push(`${skipped} 个已存在，跳过`);
  if (parsed.errors.length) parts.push(`${parsed.errors.length} 行无法识别（${parsed.errors[0]}）`);
  return { success: parts.join("，") + "。建议点击「立即检测」验证。" };
}

export async function adminToggleNodeAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  const enabled = String(formData.get("enabled")) === "true";
  await db.update(nodes).set({ enabled }).where(eq(nodes.id, id));
  revalidatePath("/admin/nodes");
  revalidatePath("/dashboard");
}

export async function adminDeleteNodeAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  await db.delete(nodes).where(eq(nodes.id, id));
  revalidatePath("/admin/nodes");
  revalidatePath("/dashboard");
}

// ---------------- node health checks ----------------

export async function adminCheckNodeAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  const [node] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  if (!node) return;
  const baseUrl = await getBaseUrl();
  await rememberBaseUrl(baseUrl);
  await runNodeCheck(node, baseUrl, "manual");
  revalidatePath("/admin/nodes");
  revalidatePath("/admin");
  revalidatePath("/dashboard");
}

export async function adminCheckAllNodesAction() {
  await requireAdmin();
  const baseUrl = await getBaseUrl();
  await rememberBaseUrl(baseUrl);
  await runAllNodeChecks(baseUrl, "manual", false);
  revalidatePath("/admin/nodes");
  revalidatePath("/admin");
  revalidatePath("/dashboard");
}
