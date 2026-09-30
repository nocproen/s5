import Link from "next/link";
import { desc, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, connectionLogs, nodes } from "@/db/schema";
import { requireAdmin } from "@/lib/admin-auth";
import { formatBytes, formatDate } from "@/lib/links";
import {
  adminDeleteUserAction,
  adminSetUserPasswordAction,
  adminToggleUserAction,
  adminUpdateUserAction,
} from "@/lib/admin-actions";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  await requireAdmin();

  const [userList, [totals], [{ logs24h }], [{ nodeCount, nodeOk, nodeBad }]] = await Promise.all([
    db.select().from(users).orderBy(desc(users.createdAt)),
    db
      .select({
        users: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${users.lastSeenAt} > now() - interval '24 hours')::int`,
        up: sql<number>`coalesce(sum(${users.uploadBytes}),0)::bigint`,
        down: sql<number>`coalesce(sum(${users.downloadBytes}),0)::bigint`,
      })
      .from(users),
    db
      .select({ logs24h: sql<number>`count(*)::int` })
      .from(connectionLogs)
      .where(sql`${connectionLogs.createdAt} > now() - interval '24 hours'`),
    db
      .select({
        nodeCount: sql<number>`count(*) filter (where ${nodes.enabled})::int`,
        nodeOk: sql<number>`count(*) filter (where ${nodes.enabled} and ${nodes.lastCheckOk} = true)::int`,
        nodeBad: sql<number>`count(*) filter (where ${nodes.enabled} and ${nodes.lastCheckOk} = false)::int`,
      })
      .from(nodes),
  ]);

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">概览</h1>
        <p className="mt-1 text-sm text-slate-400">用户账号与后台管理员完全独立，这里管理的是前台注册的普通用户。</p>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {[
          ["注册用户", String(totals.users)],
          ["24h 活跃用户", String(totals.active)],
          ["总上传", formatBytes(Number(totals.up))],
          ["总下载", formatBytes(Number(totals.down))],
          ["24h 连接", String(logs24h)],
        ].map(([k, v]) => (
          <div key={k} className="card p-5">
            <span className="label">{k}</span>
            <div className="text-2xl font-semibold">{v}</div>
          </div>
        ))}
        <Link href="/admin/nodes" className={`card block p-5 transition hover:bg-white/[0.07] ${nodeBad > 0 ? "border-rose-500/40" : ""}`}>
          <span className="label">节点状态</span>
          <div className="text-2xl font-semibold">
            <span className="text-emerald-300">{nodeOk}</span>
            <span className="text-slate-500"> / {nodeCount}</span>
          </div>
          <div className={`mt-1 text-xs ${nodeBad > 0 ? "text-rose-300" : "text-slate-400"}`}>
            {nodeBad > 0 ? `${nodeBad} 个节点异常 →` : nodeCount > nodeOk ? "部分节点尚未检测 →" : "全部正常 →"}
          </div>
        </Link>
      </section>

      <section className="card p-6">
        <h2 className="text-lg font-semibold">用户管理（{userList.length}）</h2>
        {userList.length === 0 && <p className="mt-3 text-sm text-slate-400">还没有用户注册。</p>}
        <div className="mt-4 space-y-3">
          {userList.map((u) => {
            const used = Number(u.uploadBytes) + Number(u.downloadBytes);
            const quotaGb = Number(u.quotaBytes) / 1024 ** 3;
            const expired = u.expiresAt ? u.expiresAt.getTime() < Date.now() : false;
            return (
              <div key={u.id} className={`rounded-xl border p-4 ${u.enabled ? "border-white/10" : "border-rose-500/30"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <b>{u.email}</b>
                    {!u.enabled && <span className="ml-2 rounded bg-rose-500/20 px-1.5 py-0.5 text-xs text-rose-200">已停用</span>}
                    {expired && <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-200">已过期</span>}
                    {used >= Number(u.quotaBytes) && (
                      <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-200">流量用尽</span>
                    )}
                    <div className="mono mt-1 text-xs text-slate-400">{u.proxyUuid}</div>
                  </div>
                  <div className="text-right text-xs text-slate-400">
                    <div>
                      已用 {formatBytes(used)} / {formatBytes(Number(u.quotaBytes))} · {u.totalConnections} 连接
                    </div>
                    <div>
                      最近活动 {formatDate(u.lastSeenAt)} · 注册 {formatDate(u.createdAt)}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <form action={adminUpdateUserAction} className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="id" value={u.id} />
                    <div>
                      <label className="label">配额 (GB)</label>
                      <input name="quotaGb" type="number" step="0.1" min="0.1" defaultValue={quotaGb.toFixed(1)} className="input !w-28" />
                    </div>
                    <div>
                      <label className="label">到期时间</label>
                      <input
                        name="expiresAt"
                        type="date"
                        defaultValue={u.expiresAt ? u.expiresAt.toISOString().slice(0, 10) : ""}
                        className="input !w-40"
                      />
                    </div>
                    <label className="flex items-center gap-2 pb-2 text-xs text-slate-300">
                      <input type="checkbox" name="resetTraffic" className="h-4 w-4" /> 清零流量
                    </label>
                    <button className="btn-primary !py-2">保存</button>
                  </form>
                  <form action={adminSetUserPasswordAction} className="flex items-end gap-2">
                    <input type="hidden" name="id" value={u.id} />
                    <div>
                      <label className="label">重置密码</label>
                      <input name="password" type="text" minLength={8} placeholder="新密码（≥8位）" className="input !w-40" autoComplete="off" />
                    </div>
                    <button className="btn-ghost !py-2">设置</button>
                  </form>
                  <form action={adminToggleUserAction}>
                    <input type="hidden" name="id" value={u.id} />
                    <input type="hidden" name="enabled" value={String(!u.enabled)} />
                    <button className="btn-ghost !py-2">{u.enabled ? "停用" : "启用"}</button>
                  </form>
                  <form action={adminDeleteUserAction}>
                    <input type="hidden" name="id" value={u.id} />
                    <button className="btn-danger !py-2">删除</button>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
