import { requireAdmin } from "@/lib/admin-auth";
import { AUTO_HOST, getAllNodes, resolveNode, tunnelPath } from "@/lib/nodes";
import { getBaseUrl } from "@/lib/site";
import { formatDate } from "@/lib/links";
import { getSetting, rememberBaseUrl, SETTING_LAST_AUTO_CHECK } from "@/lib/settings";
import { CHECK_TARGET, checkIntervalMinutes, getRecentChecks, STAGE_LABELS, type CheckStage } from "@/lib/node-check";
import type { NodeCheck } from "@/db/schema";
import {
  adminCheckAllNodesAction,
  adminCheckNodeAction,
  adminDeleteNodeAction,
  adminToggleNodeAction,
} from "@/lib/admin-actions";
import { PendingButton } from "@/components/admin/PendingButton";
import { NodeForm, NodeImportForm } from "@/components/admin/NodeForms";

export const dynamic = "force-dynamic";

function StatusBadge({ ok }: { ok: boolean | null }) {
  if (ok === true) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-400/15 px-2 py-0.5 text-xs font-medium text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> 正常
      </span>
    );
  }
  if (ok === false) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-rose-400/15 px-2 py-0.5 text-xs font-medium text-rose-300">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-400" /> 异常
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-0.5 text-xs font-medium text-slate-300">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" /> 未检测
    </span>
  );
}

function HistoryStrip({ checks }: { checks: NodeCheck[] }) {
  const items = checks.slice(0, 36).reverse();
  if (items.length === 0) return <span className="text-xs text-slate-500">暂无历史</span>;
  return (
    <div className="flex items-end gap-[3px]">
      {items.map((c) => (
        <span
          key={c.id}
          title={`${formatDate(c.createdAt)} · ${c.ok ? "正常" : "异常"} · ${c.latencyMs ?? "-"} ms · ${c.message}`}
          className={`h-4 w-1.5 rounded-sm ${c.ok ? "bg-emerald-400" : "bg-rose-400"}`}
        />
      ))}
    </div>
  );
}

export default async function AdminNodesPage() {
  await requireAdmin();
  const baseUrl = await getBaseUrl();
  await rememberBaseUrl(baseUrl);
  const [nodeList, history, lastAuto] = await Promise.all([getAllNodes(), getRecentChecks(24), getSetting(SETTING_LAST_AUTO_CHECK)]);

  const byNode = new Map<string, NodeCheck[]>();
  for (const h of history) {
    const arr = byNode.get(h.nodeId) ?? [];
    arr.push(h);
    byNode.set(h.nodeId, arr);
  }

  const okCount = nodeList.filter((n) => n.lastCheckOk === true).length;
  const badCount = nodeList.filter((n) => n.lastCheckOk === false).length;
  const unknownCount = nodeList.length - okCount - badCount;
  const tunnelPort = process.env.TUNNEL_PORT ?? "8080";
  const path = tunnelPath();

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">节点管理</h1>
        <p className="mt-1 text-sm text-slate-400">
          隧道入口同时在 <b className="text-slate-200">网站端口</b>（当前即{" "}
          <code className="mono text-sky-200">
            {baseUrl.replace(/^http/, "ws")}
            {path}
          </code>
          ）和独立端口 <code className="mono text-sky-200">:{tunnelPort}{path}</code> 提供服务。主机填{" "}
          <code className="mono text-sky-200">{AUTO_HOST}</code> 的节点会自动使用用户当前访问本站的网址。
          「上游节点」是你在其他服务器上已有凭据的节点：本站可以用该凭据替用户转发（入口为{" "}
          <code className="mono text-sky-200">{path}/&lt;节点标识&gt;</code>），也可以把凭据直接分发给用户。
        </p>
      </div>

      {/* Health summary */}
      <section className="card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-semibold">节点健康状态</span>
            <span className="text-emerald-300">{okCount} 正常</span>
            <span className={badCount > 0 ? "text-rose-300" : "text-slate-500"}>{badCount} 异常</span>
            <span className="text-slate-500">{unknownCount} 未检测</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            自动检测：{checkIntervalMinutes > 0 ? `每 ${checkIntervalMinutes} 分钟` : "已关闭"} · 上次自动检测{" "}
            {lastAuto ? formatDate(new Date(lastAuto)) : "尚未运行"} · 检测目标 <code className="mono">{CHECK_TARGET}</code>
          </div>
          <p className="mt-2 max-w-3xl text-xs text-slate-500">
            检测方式：从本服务器出发，按用户实际使用的地址（域名 / 端口 / TLS / 路径）建立 WebSocket 连接，用内部探测凭据经该节点访问外网目标，
            依次验证 DNS、证书、反向代理 / CDN、隧道鉴权与出站网络。探测流量不计费、不记录。
          </p>
        </div>
        <form action={adminCheckAllNodesAction}>
          <PendingButton className="btn-primary" pendingText="正在检测全部节点…">
            立即检测全部节点
          </PendingButton>
        </form>
      </section>

      {/* Nodes */}
      <section className="space-y-4">
        {nodeList.map((n) => {
          const r = resolveNode(n, baseUrl);
          const checks = byNode.get(n.id) ?? [];
          const uptime = checks.length ? Math.round((checks.filter((c) => c.ok).length / checks.length) * 100) : null;
          const stage = (n.lastCheckStage ?? null) as CheckStage | null;
          return (
            <div
              key={n.id}
              className={`card p-5 ${
                !n.enabled ? "border-white/5 opacity-70" : n.lastCheckOk === false ? "border-rose-500/40" : ""
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <b className="text-base">{n.name}</b>
                    <StatusBadge ok={n.lastCheckOk} />
                    {n.kind === "upstream" && (
                      <span className={`rounded px-1.5 py-0.5 text-xs ${n.relay ? "bg-violet-400/15 text-violet-200" : "bg-amber-400/15 text-amber-200"}`}>
                        {n.relay ? "上游 · 经本站转发" : "上游 · 直接分发凭据"}
                      </span>
                    )}
                    {r.auto && <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-xs text-sky-300">auto</span>}
                    {!n.enabled && <span className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-slate-300">已停用</span>}
                  </div>
                  <div className="mono mt-1 truncate text-xs text-slate-400">
                    {n.kind === "upstream" && n.relay ? "入口 " : ""}
                    {r.tls ? "wss" : "ws"}://{r.host}:{r.port}
                    {r.path}
                    {r.sni ? ` · SNI ${r.sni}` : ""}
                  </div>
                  {n.kind === "upstream" && r.upstream && (
                    <div className="mono mt-0.5 truncate text-xs text-slate-500">
                      上游 {r.upstream.url} · UUID {(n.upstreamUuid ?? "").slice(0, 8)}…{n.upstreamSni ? ` · SNI ${n.upstreamSni}` : ""}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <form action={adminCheckNodeAction}>
                    <input type="hidden" name="id" value={n.id} />
                    <PendingButton className="btn-primary !px-3 !py-1.5 text-xs" pendingText="检测中…">
                      立即检测
                    </PendingButton>
                  </form>
                  <form action={adminToggleNodeAction}>
                    <input type="hidden" name="id" value={n.id} />
                    <input type="hidden" name="enabled" value={String(!n.enabled)} />
                    <button className="btn-ghost !px-3 !py-1.5 text-xs">{n.enabled ? "停用" : "启用"}</button>
                  </form>
                  <form action={adminDeleteNodeAction}>
                    <input type="hidden" name="id" value={n.id} />
                    <button className="btn-danger !px-3 !py-1.5 text-xs">删除</button>
                  </form>
                </div>
              </div>

              {/* Last result */}
              <div className="mt-4 grid gap-3 rounded-xl border border-white/10 bg-black/20 p-3 md:grid-cols-[1fr_auto] md:items-center">
                <div className="min-w-0 text-sm">
                  {n.lastCheckAt ? (
                    <>
                      <div className={n.lastCheckOk ? "text-emerald-200" : "text-rose-200"}>{n.lastCheckMessage}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        阶段：{stage ? STAGE_LABELS[stage] ?? stage : "—"} · 延迟 {n.lastCheckLatencyMs ?? "—"} ms · 检测于{" "}
                        {formatDate(n.lastCheckAt)}
                      </div>
                    </>
                  ) : (
                    <span className="text-slate-500">尚未检测。点击「立即检测」，或等待自动检测。</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <HistoryStrip checks={checks} />
                  <span className="whitespace-nowrap text-xs text-slate-400">
                    24h 可用率 {uptime === null ? "—" : `${uptime}%`}
                    {checks.length ? `（${checks.length} 次）` : ""}
                  </span>
                </div>
              </div>

              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">编辑节点参数</summary>
                <div className="mt-3">
                  <NodeForm node={n} tunnelPath={path} />
                </div>
              </details>
            </div>
          );
        })}
        <div className="card border-dashed border-amber-400/40 p-5">
          <div className="text-sm font-semibold text-amber-200">快速导入已有凭据的节点</div>
          <p className="mt-1 text-xs text-slate-400">
            适用于你在其他服务器上已经拥有的节点：粘贴「地址 + UUID」即可。默认经本站转发，用户仍使用自己的账号连接本站，凭据不会下发给用户。
          </p>
          <div className="mt-3">
            <NodeImportForm />
          </div>
        </div>
        <div className="card border-dashed border-white/20 p-5">
          <div className="mb-3 text-sm font-semibold text-slate-200">手动添加节点</div>
          <NodeForm tunnelPath={path} />
        </div>
      </section>

      {/* Node server package */}
      <section className="card border-emerald-400/30 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <h2 className="text-lg font-semibold">📦 部署新节点服务器</h2>
            <p className="mt-1 text-sm text-slate-400">
              下载节点服务端源码包，拷到任意一台服务器上运行即可成为本站的节点。它与本站运行的是<b className="text-slate-200">同一份隧道代码</b>，
              连接本站的数据库后，用户直接用自己的账号 / UUID 连接，流量统计、配额、健康检测全部由本站统一管理，不需要再在后台维护凭据。
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-300">
              <li>
                下载并解压到新服务器：<code className="mono text-sky-200">tar xzf s5-tunnel-node.tar.gz &amp;&amp; cd s5-tunnel-node</code>
              </li>
              <li>
                填写 <code className="mono text-sky-200">.env</code> 中的 <code className="mono">DATABASE_URL</code>
                （与本站相同的数据库，需在数据库端放行新服务器 IP）
              </li>
              <li>
                运行 <code className="mono text-sky-200">sudo bash install.sh</code>（Debian / Ubuntu 一键安装为 systemd 服务），或{" "}
                <code className="mono text-sky-200">docker compose up -d</code>
              </li>
              <li>
                用 Caddy / Nginx 给域名配好 HTTPS，把 <code className="mono text-sky-200">{path}</code> 反代到 8080（包内 README 有完整配置）
              </li>
              <li>回到本页「手动添加节点」：类型「本站服务器」，填域名、443、{path}、TLS 开启，然后「立即检测」</li>
            </ol>
          </div>
          <div className="flex flex-col gap-2">
            <a href="/api/admin/node-package?format=tar.gz" className="btn-primary !bg-emerald-500 hover:!bg-emerald-400 !shadow-none">
              下载 s5-tunnel-node.tar.gz
            </a>
            <a href="/api/admin/node-package?format=zip" className="btn-ghost">
              下载 .zip
            </a>
            <a
              href="/api/admin/node-package?format=tar.gz&withDb=1"
              className="btn-ghost text-xs"
              title="将本站的 DATABASE_URL 写入包内 .env，解压即可运行。注意：包内含数据库密码，请勿转发他人。"
            >
              下载含数据库连接串的版本
            </a>
          </div>
        </div>
        <details className="mt-4 text-sm text-slate-400">
          <summary className="cursor-pointer hover:text-slate-200">包内文件说明</summary>
          <pre className="code mt-2">{`s5-tunnel-node/
├── src/
│   ├── main.ts             入口：连接数据库并启动隧道
│   ├── tunnel/server.ts    隧道实现（与本站完全一致）
│   ├── db/                 数据库连接与表结构
│   └── lib/settings.ts     探测凭据等设置
├── install.sh              一键安装脚本（Node.js + systemd）
├── s5-tunnel-node.service  systemd 服务文件
├── Dockerfile / docker-compose.yml
├── .env.example            配置模板（DATABASE_URL、TUNNEL_PORT、TUNNEL_PATH）
└── README.md               部署说明、Nginx / Caddy 配置、排错`}</pre>
        </details>
      </section>

      <section className="card p-6">
        <h2 className="text-lg font-semibold">部署说明</h2>
        <p className="mt-1 text-sm text-slate-400">
          隧道随 Next.js 一起启动（<code className="mono">src/instrumentation.ts</code>），并直接挂在网站端口上，所以只需把整个站点反代到 3000
          （记得带上 WebSocket upgrade 头）。独立端口 {tunnelPort} 可选，用于不经过网站的直连部署。
        </p>
        <pre className="code mt-4">{`# .env
TUNNEL_PATH=${path}         # WebSocket 路径（建议改成随机字符串）
TUNNEL_PORT=${tunnelPort}            # 可选：独立隧道端口，设为 0 关闭
ADMIN_USERNAME=admin         # 首次启动创建的后台管理员
ADMIN_PASSWORD=<强密码>       # 不设置则使用默认密码并在后台提示修改
NODE_CHECK_INTERVAL_MIN=${checkIntervalMinutes}     # 节点自动检测间隔（分钟），0 关闭
NODE_CHECK_TARGET=${CHECK_TARGET}   # 检测时经节点访问的外网目标
NEXT_PUBLIC_SITE_URL=https://your.domain.com   # 可选，不填则跟随访问网址

# Nginx（整站反代到 3000，WebSocket 一并放行）
server {
    listen 443 ssl http2;
    server_name your.domain.com;
    ssl_certificate     /etc/letsencrypt/live/your.domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your.domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 600s;
    }
}

# Caddy（自动 HTTPS，WebSocket 默认支持）
your.domain.com {
    reverse_proxy 127.0.0.1:3000
}`}</pre>
      </section>
    </main>
  );
}
