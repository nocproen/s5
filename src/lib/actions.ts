"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  createSession,
  destroySession,
  generateToken,
  hashPassword,
  requireUser,
  verifyPassword,
} from "@/lib/auth";

export type FormState = { error?: string; success?: string } | undefined;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!EMAIL_RE.test(email)) return { error: "请输入有效的邮箱地址" };
  if (password.length < 8) return { error: "密码至少 8 位" };
  if (password !== confirm) return { error: "两次输入的密码不一致" };
  if (process.env.REGISTRATION_DISABLED === "true") return { error: "当前已关闭注册，请联系管理员" };

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) return { error: "该邮箱已注册，请直接登录" };

  const defaultQuota = Number(process.env.DEFAULT_QUOTA_BYTES || 53687091200);

  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash: hashPassword(password),
      subToken: generateToken(24),
      quotaBytes: defaultQuota,
    })
    .returning({ id: users.id });

  await createSession(user.id);
  redirect("/dashboard");
}

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "请输入邮箱和密码" };

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return { error: "邮箱或密码错误" };
  }
  await createSession(user.id);
  redirect("/dashboard");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export async function resetProxyUuidAction() {
  const user = await requireUser();
  await db.update(users).set({ proxyUuid: randomUUID() }).where(eq(users.id, user.id));
  revalidatePath("/dashboard");
}

export async function resetSubTokenAction() {
  const user = await requireUser();
  await db.update(users).set({ subToken: generateToken(24) }).where(eq(users.id, user.id));
  revalidatePath("/dashboard");
}

export async function changePasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  if (!verifyPassword(current, user.passwordHash)) return { error: "当前密码错误" };
  if (next.length < 8) return { error: "新密码至少 8 位" };
  await db.update(users).set({ passwordHash: hashPassword(next) }).where(eq(users.id, user.id));
  return { success: "密码已更新" };
}
