import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectionLogs } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { getResolvedEnabledNodes } from "@/lib/nodes";
import { getBaseUrl } from "@/lib/site";
import { buildVlessLink, formatBytes, formatDate, importUrls, nodeUuid } from "@/lib/links";
import { SiteHeader } from "@/components/SiteHeader";
import { CopyButton } from "@/components/CopyButton";
import { QrCode } from "@/components/QrCode";
import { CLIENTS } from "@/lib/clients";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();
  const baseUrl = await getBaseUrl();
  const [nodeList, recent] = await Promise.all([
    getResolvedEnabledNodes(baseUrl),
    db
      .select()
      .from(connectionLogs)
      .where(eq(connectionLogs.userId, user.id))
      .orderBy(desc(connectionLogs.createdAt))
      .limit(15),
  ]);

  const used = Number(user.uploadBytes) + Number(user.downloadBytes);
  const quota = Number(user.quotaBytes);
  const pct = Math.min(100, quota > 0 ? (used / quota) * 100 : 0);
  const subUrl = `${baseUrl}/api/sub/${user.subToken}`;
  const imports = importUrls(subUrl);
  const expired = user.expiresAt ? user.expiresAt.getTime() < Date.now() : false;
  const status = !user.enabled ? "已停用" : expired ? "已过期" : used >= quota ? "流量用尽" : "正常";
  const statusColor = status === "正常" ? "text-emerald-300 border-emerald-400/30 bg-emerald-400/10" : "text-rose-300 border-rose-400/30 bg-rose-400/10";

  return (
    <>
      <SiteHeader active="dashboard" />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">控制台</h1>
            <p className="mt-1 text-sm text-slate-400">{user.email}</p>
          </div>
          <span className={`rounded-full border px-3 py-1 text-xs ${statusColor}`}>账户状态：{status}</span>
        </div>

        {/* Stats */}
        <section className="grid gap-4 md:grid-cols-4">
          <div className="card p-5 md:col-span-2">
            <div className="flex items-baseline justify-between">
              <span className="label !mb-0">已用流量</span>
              <span className="text-xs text-slate-400">
                {formatBytes(used)} / {formatBytes(quota)}
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full ${pct > 90 ? "bg-rose-400" : "bg-gradient-to-r from-sky-400 to-violet-400"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-3 flex gap-6 text-sm text-slate-300">
              <span>↑ 上传 {formatBytes(Number(user.uploadBytes))}</span>
              <span>↓ 下载 {formatBytes(Number(user.downloadBytes))}</span>
            </div>
          </div>
          <div className="card p-5">
            <span className="label">累计连接</span>
            <div className="text-2xl font-semibold">{user.totalConnections.toLocaleString()}</div>
            <div className="mt-1 text-xs text-slate-400">最近活动：{formatDate(user.lastSeenAt)}</div>
          </div>
          <div className="card p-5">
            <span className="label">到期时间</span>
            <div className="text-2xl font-semibold">{user.expiresAt ? formatDate(user.expiresAt) : "长期有效"}</div>
            <div className="mt-1 text-xs text-slate-400">注册于 {formatDate(user.createdAt)}</div>
          </div>
        </section>

        {/* Quick start */}
        <section className="card p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">三步开始使用</h2>
            <Link href="/dashboard/download" className="btn-primary">
              下载客户端 →
            </Link>
          </div>
          <ol className="mt-4 grid gap-4 text-sm text-slate-300 md:grid-cols-3">
            <li className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <b className="text-sky-300">1.</b> 前往「下载客户端」，按你的系统安装客户端。
            </li>
            <li className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <b className="text-sky-300">2.</b> 在客户端中导入下方订阅链接，或直接扫描节点二维码。
            </li>
            <li className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <b className="text-sky-300">3.</b> 启动后本机 <code className="mono text-sky-200">127.0.0.1:1080</code> 即为 SOCKS5 代理。
            </li>
          </ol>
        </section>

        {/* Credentials */}
        <section className="card p-6">
          <h2 className="text-lg font-semibold">我的凭据</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <span className="label">UUID（客户端密钥）</span>
              <div className="flex items-center gap-2">
                <code className="mono flex-1 truncate rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm">
                  {user.proxyUuid}
                </code>
                <CopyButton text={user.proxyUuid} />
              </div>
            </div>
            <div>
              <span className="label">订阅链接（v2ray / Clash 自动识别）</span>
              <div className="flex items-center gap-2">
                <code className="mono flex-1 truncate rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm">{subUrl}</code>
                <CopyButton text={subUrl} />
              </div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <a href={imports.v2rayng} className="btn-ghost">
              导入 v2rayNG
            </a>
            <a href={imports.clash} className="btn-ghost">
              导入 Clash / Verge
            </a>
            <a href={imports.shadowrocket} className="btn-ghost">
              导入 Shadowrocket
            </a>
            <a href={imports.hiddify} className="btn-ghost">
              导入 Hiddify
            </a>
            <a href={`${subUrl}?format=clash`} className="btn-ghost" download>
              下载 Clash 配置
            </a>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            请勿泄露 UUID 与订阅链接。如有泄露可在「账户设置」中重置。
          </p>
        </section>

        {/* Nodes */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">可用节点（{nodeList.length}）</h2>
          {nodeList.length === 0 && (
            <div className="card p-6 text-sm text-slate-400">暂无可用节点，请联系管理员在后台添加。</div>
          )}
          {nodeList.map((n) => {
            const link = buildVlessLink(n, nodeUuid(n, user.proxyUuid));
            return (
              <div key={n.id} className="card flex flex-col gap-5 p-6 md:flex-row">
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold">{n.name}</h3>
                    <span className="rounded-md border border-white/10 px-2 py-0.5 text-xs text-slate-300">
                      {n.host}:{n.port}
                    </span>
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs ${
                        n.tls ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"
                      }`}
                    >
                      {n.tls ? "加密连接" : "未加密（仅测试）"}
                    </span>
                    {n.lastCheckAt && (
                      <span
                        title={`检测于 ${formatDate(n.lastCheckAt)}`}
                        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs ${
                          n.lastCheckOk ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"
                        }`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${n.lastCheckOk ? "bg-emerald-400" : "bg-rose-400"}`} />
                        {n.lastCheckOk ? `运行正常${n.lastCheckLatencyMs ? ` · ${n.lastCheckLatencyMs} ms` : ""}` : "暂时不可用"}
                      </span>
                    )}
                  </div>
                  <div>
                    <span className="label">节点链接（v2rayN / v2rayNG / Shadowrocket / Clash 可直接粘贴导入）</span>
                    <div className="flex items-center gap-2">
                      <code className="mono flex-1 truncate rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs">{link}</code>
                      <CopyButton text={link} />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                    <span>开发者：下载已内置本节点配置的命令行客户端</span>
                    {CLIENTS.map((c) => (
                      <a key={c.id} href={`/api/client/download?lang=${c.id}&node=${n.id}`} className="text-sky-300 hover:underline">
                        {c.icon} {c.name}
                      </a>
                    ))}
                    <Link href="/dashboard/download" className="text-slate-400 hover:underline">
                      查看说明 →
                    </Link>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-center gap-2">
                  <QrCode value={link} size={150} />
                  <span className="text-xs text-slate-500">扫码导入</span>
                </div>
              </div>
            );
          })}
        </section>

        {/* Recent connections */}
        <section className="card p-6">
          <h2 className="text-lg font-semibold">最近连接</h2>
          {recent.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">还没有连接记录。连接成功后这里会显示访问目标与流量。</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="py-2 pr-4">时间</th>
                    <th className="py-2 pr-4">目标</th>
                    <th className="py-2 pr-4">协议</th>
                    <th className="py-2 pr-4">上传</th>
                    <th className="py-2 pr-4">下载</th>
                    <th className="py-2 pr-4">时长</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {recent.map((r) => (
                    <tr key={r.id} className="text-slate-300">
                      <td className="py-2 pr-4 whitespace-nowrap">{formatDate(r.createdAt)}</td>
                      <td className="mono py-2 pr-4">
                        {r.targetHost}:{r.targetPort}
                        {r.via && <span className="ml-2 rounded bg-violet-400/10 px-1.5 py-0.5 text-[10px] text-violet-200">经 {r.via}</span>}
                      </td>
                      <td className="py-2 pr-4 uppercase">{r.protocol}</td>
                      <td className="py-2 pr-4">{formatBytes(Number(r.uploadBytes))}</td>
                      <td className="py-2 pr-4">{formatBytes(Number(r.downloadBytes))}</td>
                      <td className="py-2 pr-4">{(r.durationMs / 1000).toFixed(1)}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
