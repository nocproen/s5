"use client";

import { useActionState } from "react";
import Link from "next/link";
import type { FormState } from "@/lib/actions";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export function AuthForm({ mode, action }: { mode: "login" | "register"; action: Action }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const isRegister = mode === "register";

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="email">
          邮箱
        </label>
        <input id="email" name="email" type="email" required autoComplete="email" className="input" placeholder="you@example.com" />
      </div>
      <div>
        <label className="label" htmlFor="password">
          密码
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={isRegister ? 8 : 1}
          autoComplete={isRegister ? "new-password" : "current-password"}
          className="input"
          placeholder={isRegister ? "至少 8 位" : "••••••••"}
        />
      </div>
      {isRegister && (
        <div>
          <label className="label" htmlFor="confirm">
            确认密码
          </label>
          <input id="confirm" name="confirm" type="password" required minLength={8} autoComplete="new-password" className="input" />
        </div>
      )}
      {state?.error && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{state.error}</p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? "处理中…" : isRegister ? "注册并进入控制台" : "登录"}
      </button>
      <p className="text-center text-sm text-slate-400">
        {isRegister ? (
          <>
            已有账号？{" "}
            <Link href="/login" className="text-sky-300 hover:underline">
              去登录
            </Link>
          </>
        ) : (
          <>
            还没有账号？{" "}
            <Link href="/register" className="text-sky-300 hover:underline">
              免费注册
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
