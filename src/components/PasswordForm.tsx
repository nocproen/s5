"use client";

import { useActionState } from "react";
import { changePasswordAction } from "@/lib/actions";

export function PasswordForm() {
  const [state, formAction, pending] = useActionState(changePasswordAction, undefined);
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
          新密码
        </label>
        <input id="next" name="next" type="password" required minLength={8} className="input" autoComplete="new-password" />
      </div>
      {state?.error && <p className="text-sm text-rose-300">{state.error}</p>}
      {state?.success && <p className="text-sm text-emerald-300">{state.success}</p>}
      <button className="btn-primary" disabled={pending}>
        {pending ? "保存中…" : "更新密码"}
      </button>
    </form>
  );
}
