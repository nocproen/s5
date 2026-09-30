"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/actions";
import { adminChangePasswordAction, adminCreateAdminAction, adminLoginAction } from "@/lib/admin-actions";

function Feedback({ state }: { state: FormState }) {
  if (!state?.error && !state?.success) return null;
  return state.error ? (
    <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{state.error}</p>
  ) : (
    <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{state.success}</p>
  );
}

export function AdminLoginForm() {
  const [state, formAction, pending] = useActionState(adminLoginAction, undefined);
  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="username">
          管理员用户名
        </label>
        <input id="username" name="username" required autoComplete="username" className="input" placeholder="admin" autoFocus />
      </div>
      <div>
        <label className="label" htmlFor="password">
          密码
        </label>
        <input id="password" name="password" type="password" required autoComplete="current-password" className="input" />
      </div>
      <Feedback state={state} />
      <button type="submit" disabled={pending} className="btn-primary w-full !bg-amber-500 hover:!bg-amber-400 !shadow-[0_0_0_1px_rgba(251,191,36,0.4),0_8px_24px_rgba(251,191,36,0.25)]">
        {pending ? "登录中…" : "登录管理后台"}
      </button>
    </form>
  );
}

export function AdminPasswordForm() {
  const [state, formAction, pending] = useActionState(adminChangePasswordAction, undefined);
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label className="label" htmlFor="current">
          当前密码
        </label>
        <input id="current" name="current" type="password" required className="input" autoComplete="current-password" />
      </div>
      <div>
        <label className="label" htmlFor="next">
          新密码（至少 10 位）
        </label>
        <input id="next" name="next" type="password" required minLength={10} className="input" autoComplete="new-password" />
      </div>
      <div>
        <label className="label" htmlFor="confirm">
          确认新密码
        </label>
        <input id="confirm" name="confirm" type="password" required minLength={10} className="input" autoComplete="new-password" />
      </div>
      <Feedback state={state} />
      <button className="btn-primary" disabled={pending}>
        {pending ? "保存中…" : "更新管理员密码"}
      </button>
    </form>
  );
}

export function AdminCreateForm() {
  const [state, formAction, pending] = useActionState(adminCreateAdminAction, undefined);
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label className="label" htmlFor="new-username">
          用户名
        </label>
        <input id="new-username" name="username" required minLength={3} maxLength={32} className="input" placeholder="ops" autoComplete="off" />
      </div>
      <div>
        <label className="label" htmlFor="new-password">
          初始密码（至少 10 位）
        </label>
        <input id="new-password" name="password" type="password" required minLength={10} className="input" autoComplete="new-password" />
      </div>
      <Feedback state={state} />
      <button className="btn-primary" disabled={pending}>
        {pending ? "创建中…" : "添加管理员"}
      </button>
    </form>
  );
}
