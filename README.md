# S5 Tunnel — WebSocket → SOCKS5 转发服务

用户注册 → 下载客户端 → 客户端通过 WebSocket 连接服务器 → 本地得到 SOCKS5 代理。

## 架构

```
浏览器/应用 --SOCKS5--> 客户端(本机) --WebSocket(wss, 可套 CDN)--> 隧道服务(:8080/tunnel) --TCP/UDP--> 目标
                                                                          │
                                                        Next.js 网站(:3000) + PostgreSQL（用户/节点/流量）
```

- **网站**（Next.js App Router + Drizzle + PostgreSQL）：注册 / 登录、控制台（UUID、订阅链接、二维码、流量统计、最近连接）、客户端下载页。
- **管理后台**（`/admin`，独立登录入口 `/admin/login`）：管理员账号存放在独立的 `admins` 表，使用独立的会话 Cookie，与前台用户完全隔离；前台注册的用户无法进入后台。功能：用户配额 / 到期 / 停用 / 重置密码、节点增删改、**节点健康检测**、管理员账号管理。
- **上游节点（已有凭据）**：后台可粘贴「`wss://地址/路径 --uuid UUID`」或 `vless://` 链接导入其他服务器上的节点。默认「经本站转发」：用户仍用自己的账号连接本站的 `/tunnel/<节点标识>`，本站用上游凭据转发（TCP + UDP），凭据不外泄、流量统计与配额照常；也可选「直接分发凭据」让用户直连上游。
- **部署新节点服务器**：后台「节点管理」可下载 `s5-tunnel-node.tar.gz`（`src/lib/node-package.ts` 动态打包，隧道代码与主站完全一致）。拷到新服务器后填好 `DATABASE_URL`，`sudo bash install.sh`（或 `docker compose up -d`）即成为本站节点，用户直接用自己的 UUID 连接，统计 / 配额 / 检测由主站统一管理。
- **节点健康检测**（`src/lib/node-check.ts`）：从服务器出发，按用户实际使用的地址（域名 / 端口 / TLS / 路径）建立 WebSocket 连接，用内部探测凭据经节点访问外网目标，逐段验证 DNS → TLS 证书 → 反向代理 / CDN → 隧道鉴权 → 出站网络，并给出中文诊断（如"HTTP 404：路径不存在"、"TLS 证书已过期"）。默认每 10 分钟自动执行，后台可手动触发，保留 7 天历史并显示 24h 可用率；探测流量不计费、不记录。
- **隧道服务**（`src/tunnel/server.ts`）：随 `next start` 一起由 `src/instrumentation.ts` 启动，实现 **VLESS over WebSocket** 协议，支持 TCP + UDP，按 UUID 鉴权，统计流量、执行配额与到期。WebSocket 入口**直接挂在网站端口**（`https://<站点>/tunnel`），同时也在独立端口 8080 提供。
- **auto 节点**：主机填 `auto` 的节点会自动跟随用户当前访问网站的地址（预览地址 / 域名变化都无需改配置）。
- **客户端**：
  - 推荐：v2rayN（Windows）、v2rayNG（Android）、Clash Verge Rev（macOS/Windows/Linux）、Shadowrocket（iOS）、Hiddify（全平台）、Xray-core（命令行）—— 全部通过订阅链接 / `vless://` 链接一键导入，本地自动开启 SOCKS5。
  - 自带轻量客户端（`public/client/`，同一协议、6 种语言，控制台可下载已内置个人服务器地址与 UUID 的版本，全部经过实测）：

    | 语言 | 文件 | 运行环境 | 依赖 |
    |---|---|---|---|
    | Node.js | `socks5-ws-client.mjs` | Node 22+ / Bun | 无 |
    | Python | `socks5_ws_client.py` | Python 3.8+ | 无（WebSocket 帧自实现） |
    | Go | `socks5-ws-client.go` | Go 1.18+ | 无（标准库），可交叉编译单文件 |
    | Rust | `rust/` (Cargo 项目) | Rust 1.70+ | tokio + tokio-tungstenite (rustls) |
    | Java | `Socks5WsClient.java` | Java 11+ | 无（`java.net.http.WebSocket`） |
    | C# | `csharp/` (Program.cs + csproj) | .NET 6+ | 无（`ClientWebSocket`） |

## 本地运行

```bash
npm install
npx drizzle-kit push      # 建表
npm run build && npm start
# 网站 http://localhost:3000 ，隧道 ws://localhost:3000/tunnel（也可用 ws://localhost:8080/tunnel）
```

首次启动会自动创建后台管理员（`ADMIN_USERNAME` / `ADMIN_PASSWORD`，默认 `admin` / `admin123456`，请登录 `/admin/login` 后立即在「管理员设置」中修改）。未设置 `TUNNEL_PUBLIC_HOST` 时会自动创建一个 `auto` 节点（跟随访问网址）。

本地自测：

```bash
TUNNEL_ALLOW_LOCALHOST=true npm start
node public/client/socks5-ws-client.mjs --server ws://127.0.0.1:8080/tunnel --uuid <控制台里的UUID>
curl --socks5-hostname 127.0.0.1:1080 http://127.0.0.1:3000/api/health
```

## 生产部署

1. 复制 `.env.example` 为 `.env`，设置 `ADMIN_PASSWORD`，建议把 `TUNNEL_PATH` 改成随机字符串。
2. 用 Nginx / Caddy 前置 TLS，把整站（含 WebSocket upgrade）反代到 `127.0.0.1:3000` 即可（管理后台有完整配置示例）。
3. 可选：域名套 Cloudflare CDN（开启 WebSocket），节点的 SNI/Host 填写域名。

## 协议说明

服务端实现标准 VLESS 请求头解析（`ver | uuid | addons | cmd | port | atyp | addr`），TCP 直接转发，UDP 使用 2 字节长度前缀分包；不支持 Mux（客户端默认关闭即可）。
