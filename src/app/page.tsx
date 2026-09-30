import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const steps = [
  {
    n: "01",
    title: "注册账号",
    desc: "填写邮箱和密码即可，自动分配你的专属连接凭据，不需要任何配置。",
  },
  {
    n: "02",
    title: "下载客户端",
    desc: "Windows、macOS、Linux、Android、iOS 都有推荐客户端，一键导入订阅或扫码即可。",
  },
  {
    n: "03",
    title: "开始使用",
    desc: "点击连接，浏览器和应用即可通过本机 SOCKS5 代理（127.0.0.1:1080）上网。",
  },
];

const features = [
  ["全平台支持", "v2rayN、v2rayNG、Shadowrocket、Clash Verge、Hiddify 等主流客户端均可一键导入，手机电脑都能用。"],
  ["流量一目了然", "控制台实时显示已用流量、剩余配额、到期时间和最近连接记录。"],
  ["订阅自动同步", "节点有更新时，客户端更新一下订阅即可，无需手动改配置。"],
  ["标准 SOCKS5", "连接后在本机提供标准 SOCKS5 端口，浏览器、Telegram、命令行工具都能直接使用。"],
  ["开发者友好", "提供 Node.js / Python / Go / Rust / Java / C# 六种语言的开源单文件客户端，服务器上也能跑。"],
  ["凭据随时可换", "UUID 和订阅链接如有泄露，在账户设置中一键重置。"],
];

const faqs = [
  ["需要付费吗？", "注册即送默认流量配额，用完或到期后可联系管理员调整。"],
  ["支持哪些设备？", "Windows、macOS、Linux、Android、iOS 以及任何能运行 Node.js / Python / Go 等语言的设备。"],
  ["连接后怎么用？", "大多数客户端提供「系统代理」开关，打开即可；也可以在软件中手动填写 SOCKS5 127.0.0.1 与对应端口。"],
  ["订阅链接是什么？", "一个专属网址，粘贴到客户端里就能自动获取全部节点，节点变动也会自动同步。"],
];

export default async function HomePage() {
  const user = await getCurrentUser();
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 pb-24">
        <section className="pt-20 pb-16 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1 text-xs text-sky-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" />
            简单、稳定的 SOCKS5 代理服务
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl text-[clamp(2.2rem,6vw,4rem)] font-semibold leading-[1.05] tracking-tight">
            注册、下载、连接，
            <br />
            <span className="bg-gradient-to-r from-sky-300 via-cyan-200 to-violet-300 bg-clip-text text-transparent">
              一分钟获得你的 SOCKS5 代理
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base text-slate-300 sm:text-lg">
            不需要懂技术。注册账号后按提示安装客户端、导入订阅，点击连接就能用，手机和电脑都支持。
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {user ? (
              <Link href="/dashboard" className="btn-primary !px-6 !py-3 text-base">
                进入控制台 →
              </Link>
            ) : (
              <>
                <Link href="/register" className="btn-primary !px-6 !py-3 text-base">
                  免费注册
                </Link>
                <Link href="/login" className="btn-ghost !px-6 !py-3 text-base">
                  已有账号登录
                </Link>
              </>
            )}
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.n} className="card p-6">
              <div className="mono text-xs text-sky-300">{s.n}</div>
              <h3 className="mt-2 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{s.desc}</p>
            </div>
          ))}
        </section>

        <section className="card mt-10 p-6 md:p-8">
          <h2 className="text-xl font-semibold">支持的客户端</h2>
          <p className="mt-2 text-sm text-slate-400">安装后导入订阅链接或扫描二维码即可使用，控制台内有每个平台的详细步骤。</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["🪟", "Windows", "v2rayN"],
              ["🍎", "macOS", "Clash Verge Rev"],
              ["🐧", "Linux", "Xray / Clash Verge"],
              ["🤖", "Android", "v2rayNG"],
              ["📱", "iOS", "Shadowrocket"],
            ].map(([icon, platform, client]) => (
              <div key={platform} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <div className="text-2xl">{icon}</div>
                <div className="mt-2 text-xs uppercase tracking-wider text-slate-400">{platform}</div>
                <div className="font-semibold">{client}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(([t, d]) => (
            <div key={t} className="card p-5">
              <h3 className="font-semibold">{t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{d}</p>
            </div>
          ))}
        </section>

        <section className="card mt-10 p-6 md:p-8">
          <h2 className="text-xl font-semibold">常见问题</h2>
          <dl className="mt-4 grid gap-5 md:grid-cols-2">
            {faqs.map(([q, a]) => (
              <div key={q}>
                <dt className="font-medium text-slate-100">{q}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-slate-400">{a}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>
      <footer className="border-t border-white/10 py-8 text-center text-xs text-slate-500">
        S5 Tunnel · 请遵守当地法律法规使用
        <span className="mx-2">·</span>
        <Link href="/admin/login" className="hover:text-slate-300">
          管理员入口
        </Link>
      </footer>
    </>
  );
}
