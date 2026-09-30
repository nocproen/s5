import { requireUser } from "@/lib/auth";
import { resetProxyUuidAction, resetSubTokenAction } from "@/lib/actions";
import { SiteHeader } from "@/components/SiteHeader";
import { PasswordForm } from "@/components/PasswordForm";
import { formatDate } from "@/lib/links";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();
  return (
    <>
      <SiteHeader active="settings" />
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
        <h1 className="text-2xl font-semibold">账户设置</h1>

        <section className="card p-6">
          <h2 className="text-lg font-semibold">账户信息</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-400">邮箱</dt>
              <dd>{user.email}</dd>
            </div>
            <div>
              <dt className="text-slate-400">账户状态</dt>
              <dd>{user.enabled ? "正常" : "已停用"}</dd>
            </div>
            <div>
              <dt className="text-slate-400">注册时间</dt>
              <dd>{formatDate(user.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-slate-400">UUID</dt>
              <dd className="mono">{user.proxyUuid}</dd>
            </div>
          </dl>
        </section>

        <section className="card p-6">
          <h2 className="text-lg font-semibold">重置凭据</h2>
          <p className="mt-1 text-sm text-slate-400">如果 UUID 或订阅链接泄露，可以在这里重置。重置后需要重新导入客户端配置。</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <form action={resetProxyUuidAction}>
              <button className="btn-danger">重置 UUID</button>
            </form>
            <form action={resetSubTokenAction}>
              <button className="btn-danger">重置订阅链接</button>
            </form>
          </div>
        </section>

        <section className="card p-6">
          <h2 className="text-lg font-semibold">修改密码</h2>
          <div className="mt-4 max-w-sm">
            <PasswordForm />
          </div>
        </section>
      </main>
    </>
  );
}
