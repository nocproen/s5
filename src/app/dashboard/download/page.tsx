import { requireUser } from "@/lib/auth";
import { getResolvedEnabledNodes } from "@/lib/nodes";
import { getBaseUrl } from "@/lib/site";
import { buildWsUrl, importUrls, nodeUuid } from "@/lib/links";
import { SiteHeader } from "@/components/SiteHeader";
import { CopyButton } from "@/components/CopyButton";
import { LiteClientPicker } from "@/components/LiteClientPicker";
import { CLIENTS } from "@/lib/clients";

export const dynamic = "force-dynamic";

const clients = [
  {
    platform: "Windows",
    icon: "🪟",
    recommended: "v2rayN",
    url: "https://github.com/2dust/v2rayN/releases",
    note: "最流行的 Windows 客户端，内置 Xray 内核。默认本地 SOCKS5 端口 10808，可在设置中改为 1080。",
    alt: [
      { name: "Clash Verge Rev", url: "https://github.com/clash-verge-rev/clash-verge-rev/releases" },
      { name: "Hiddify", url: "https://github.com/hiddify/hiddify-app/releases" },
    ],
  },
  {
    platform: "macOS",
    icon: "🍎",
    recommended: "Clash Verge Rev",
    url: "https://github.com/clash-verge-rev/clash-verge-rev/releases",
    note: "支持 Apple Silicon / Intel，导入订阅后开启系统代理即可，本地混合端口 7890 同时支持 SOCKS5 与 HTTP。",
    alt: [
      { name: "v2rayN (macOS)", url: "https://github.com/2dust/v2rayN/releases" },
      { name: "Hiddify", url: "https://github.com/hiddify/hiddify-app/releases" },
    ],
  },
  {
    platform: "Linux",
    icon: "🐧",
    recommended: "Xray-core (命令行)",
    url: "https://github.com/XTLS/Xray-core/releases",
    note: "官方内核，单二进制文件。使用下方生成的 config.json 直接运行：xray run -c config.json。",
    alt: [
      { name: "Clash Verge Rev", url: "https://github.com/clash-verge-rev/clash-verge-rev/releases" },
      { name: "v2rayN (Linux)", url: "https://github.com/2dust/v2rayN/releases" },
    ],
  },
  {
    platform: "Android",
    icon: "🤖",
    recommended: "v2rayNG",
    url: "https://github.com/2dust/v2rayNG/releases",
    note: "点击控制台的「导入 v2rayNG」按钮或扫码即可添加，内置 SOCKS5 端口 10808。",
    alt: [
      { name: "NekoBox", url: "https://github.com/MatsuriDayo/NekoBoxForAndroid/releases" },
      { name: "Hiddify", url: "https://github.com/hiddify/hiddify-app/releases" },
    ],
  },
  {
    platform: "iOS",
    icon: "📱",
    recommended: "Shadowrocket",
    url: "https://apps.apple.com/app/shadowrocket/id932747118",
    note: "App Store 付费应用（需非中国区账号），点击「导入 Shadowrocket」一键添加订阅。",
    alt: [
      { name: "Streisand", url: "https://apps.apple.com/app/streisand/id6450534064" },
      { name: "Hiddify", url: "https://apps.apple.com/app/hiddify-proxy-vpn/id6596777532" },
    ],
  },
];

export default async function DownloadPage() {
  const user = await requireUser();
  const baseUrl = await getBaseUrl();
  const nodeList = await getResolvedEnabledNodes(baseUrl);
  const node = nodeList[0];
  const firstUuid = node ? nodeUuid(node, user.proxyUuid) : user.proxyUuid;
  const subUrl = `${baseUrl}/api/sub/${user.subToken}`;
  const imports = importUrls(subUrl);

  const xrayConfig = node
    ? JSON.stringify(
        {
          log: { loglevel: "warning" },
          inbounds: [
            {
              tag: "socks-in",
              listen: "127.0.0.1",
              port: 1080,
              protocol: "socks",
              settings: { udp: true },
              sniffing: { enabled: true, destOverride: ["http", "tls"] },
            },
          ],
          outbounds: [
            {
              tag: "proxy",
              protocol: "vless",
              settings: {
                vnext: [
                  {
                    address: node.host,
                    port: node.port,
                    users: [{ id: firstUuid, encryption: "none" }],
                  },
                ],
              },
              streamSettings: {
                network: "ws",
                security: node.tls ? "tls" : "none",
                ...(node.tls ? { tlsSettings: { serverName: node.sni || node.host, fingerprint: "chrome" } } : {}),
                wsSettings: { path: node.path, headers: { Host: node.sni || node.host } },
              },
              mux: { enabled: false },
            },
            { tag: "direct", protocol: "freedom" },
          ],
        },
        null,
        2,
      )
    : "";

  const manualArgs = node
    ? `--server ${buildWsUrl(node)} --uuid ${firstUuid} --listen 127.0.0.1:1080`
    : `--server wss://your-host/tunnel --uuid ${user.proxyUuid} --listen 127.0.0.1:1080`;

  return (
    <>
      <SiteHeader active="download" />
      <main className="mx-auto max-w-6xl space-y-8 px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold">下载客户端</h1>
          <p className="mt-1 text-sm text-slate-400">
            按你的设备选择一个客户端安装，导入订阅链接或扫码后点击连接即可。连接成功后，本机会提供一个 SOCKS5 代理端口供浏览器和应用使用。
          </p>
        </div>

        {/* Lightweight clients */}
        <section className="card border-sky-400/30 p-6">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">⚡ 轻量客户端（推荐给开发者 / 服务器）</h2>
            <span className="rounded-full bg-sky-400/15 px-2 py-0.5 text-xs text-sky-200">{CLIENTS.length} 种语言 · 单文件 · 零/极少依赖</span>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            不想装图形客户端？用你熟悉的语言跑一个单文件命令行客户端即可，在本机提供 SOCKS5 端口。
            选择语言后下载的文件已内置你的服务器地址与 UUID，直接运行即可；源码开放，可自行审计或二次开发。
          </p>
          <div className="mt-5">
            <LiteClientPicker clients={CLIENTS} manualArgs={manualArgs} nodeId={node?.id} />
          </div>
        </section>

        {/* GUI clients */}
        <section>
          <h2 className="text-lg font-semibold">图形界面客户端（按平台推荐）</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {clients.map((c) => (
              <div key={c.platform} className="card flex flex-col p-5">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{c.icon}</span>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-slate-400">{c.platform}</div>
                    <div className="font-semibold">{c.recommended}</div>
                  </div>
                </div>
                <p className="mt-3 flex-1 text-sm leading-relaxed text-slate-400">{c.note}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <a href={c.url} target="_blank" rel="noreferrer" className="btn-primary !px-3 !py-1.5 text-xs">
                    下载 {c.recommended}
                  </a>
                  {c.alt.map((a) => (
                    <a key={a.name} href={a.url} target="_blank" rel="noreferrer" className="btn-ghost !px-3 !py-1.5 text-xs">
                      {a.name}
                    </a>
                  ))}
                </div>
              </div>
            ))}
            <div className="card flex flex-col p-5">
              <div className="flex items-center gap-2">
                <span className="text-2xl">🔗</span>
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-400">一键导入</div>
                  <div className="font-semibold">在手机上点击</div>
                </div>
              </div>
              <p className="mt-3 flex-1 text-sm text-slate-400">安装客户端后，在手机浏览器打开本页点击对应按钮，自动添加订阅。</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <a href={imports.v2rayng} className="btn-ghost !px-3 !py-1.5 text-xs">v2rayNG</a>
                <a href={imports.shadowrocket} className="btn-ghost !px-3 !py-1.5 text-xs">Shadowrocket</a>
                <a href={imports.clash} className="btn-ghost !px-3 !py-1.5 text-xs">Clash</a>
                <a href={imports.hiddify} className="btn-ghost !px-3 !py-1.5 text-xs">Hiddify</a>
              </div>
            </div>
          </div>
        </section>

        {/* Tutorial */}
        <section className="card p-6">
          <h2 className="text-lg font-semibold">通用步骤</h2>
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-slate-300">
            <li>安装上面推荐的客户端。</li>
            <li>
              复制控制台里的 <b>订阅链接</b>，在客户端中「从订阅添加 / 从剪贴板导入」；或直接扫描节点二维码。
              <div className="mt-2 flex items-center gap-2">
                <code className="mono flex-1 truncate rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs">{subUrl}</code>
                <CopyButton text={subUrl} />
              </div>
            </li>
            <li>选择节点并点击连接。</li>
            <li>
              客户端会在本机开启 SOCKS5 端口：v2rayN / v2rayNG 为 <code className="mono text-sky-200">10808</code>，Clash 为{" "}
              <code className="mono text-sky-200">7890</code>（混合端口），轻量客户端 / Xray 为 <code className="mono text-sky-200">1080</code>。
              开启「系统代理」或在应用中填写 SOCKS5 地址即可。
            </li>
            <li>
              通过订阅或扫码导入的节点参数已经配置好，无需手动修改；若手动添加节点，请保持「Mux 多路复用」关闭（默认即关闭）。
            </li>
          </ol>
        </section>

        {/* Xray CLI config */}
        {node && (
          <section className="card p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Xray-core 命令行配置</h2>
                <p className="mt-1 text-sm text-slate-400">
                  保存为 <code className="mono text-sky-200">config.json</code>，运行 <code className="mono text-sky-200">xray run -c config.json</code>
                  ，本地 SOCKS5 在 127.0.0.1:1080。
                </p>
              </div>
              <CopyButton text={xrayConfig} label="复制配置" />
            </div>
            <pre className="code mt-4 max-h-96">{xrayConfig}</pre>
          </section>
        )}
      </main>
    </>
  );
}
