/**
 * Builds a self-contained "node server" source package that can be copied to any
 * other machine and run there. The package reuses the exact tunnel implementation
 * of this deployment (src/tunnel/server.ts) with its `@/` imports rewritten to
 * relative paths, plus a tiny entry point, package.json, Dockerfile, install
 * script and README pre-filled with this deployment's settings.
 */
import { readFile } from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import os from "os";
import { tunnelPath } from "@/lib/nodes";

const execFileAsync = promisify(execFile);

export type PackageOptions = {
  /** Public URL of this website (for the README) */
  siteUrl: string;
  /** DATABASE_URL suggestion written into .env.example (never the real one unless requested) */
  databaseUrlHint: string;
  /** Include the real DATABASE_URL in .env (only when the admin explicitly asks) */
  includeDatabaseUrl?: boolean;
  format: "tar.gz" | "zip";
};

type PackageFile = { name: string; content: string | Buffer; mode?: number };

const VERSION = "1.0.0";

// Statically scoped so the build tracer knows exactly which files are read at runtime.
const SRC_DIR = path.join(process.cwd(), "src");

function readSource(rel: "tunnel/server.ts" | "db/index.ts" | "db/schema.ts" | "lib/settings.ts"): Promise<string> {
  return readFile(path.join(/*turbopackIgnore: true*/ SRC_DIR, rel), "utf8");
}

function rewriteImports(source: string, map: Record<string, string>): string {
  let out = source;
  for (const [from, to] of Object.entries(map)) {
    out = out.split(`"${from}"`).join(`"${to}"`);
  }
  return out;
}

export async function buildNodePackageFiles(opts: PackageOptions): Promise<PackageFile[]> {
  const tPath = tunnelPath();
  const [serverTs, dbIndexTs, schemaTs, settingsTs] = await Promise.all([
    readSource("tunnel/server.ts"),
    readSource("db/index.ts"),
    readSource("db/schema.ts"),
    readSource("lib/settings.ts"),
  ]);

  const files: PackageFile[] = [];

  // --- source (verbatim from this deployment, imports rewritten) ---
  files.push({
    name: "src/tunnel/server.ts",
    content: rewriteImports(serverTs, { "@/db": "../db", "@/db/schema": "../db/schema", "@/lib/settings": "../lib/settings" }),
  });
  files.push({ name: "src/db/index.ts", content: dbIndexTs });
  files.push({ name: "src/db/schema.ts", content: schemaTs });
  files.push({
    name: "src/lib/settings.ts",
    content: rewriteImports(settingsTs, { "@/db": "../db", "@/db/schema": "../db/schema" }),
  });

  files.push({
    name: "src/main.ts",
    content: `import "dotenv/config";
import { ensureProbeCredential, ensureSettingsTable } from "./lib/settings";
import { startTunnelServer, tunnelConfig } from "./tunnel/server";

async function main() {
  // The tunnel authenticates users against the shared PostgreSQL database.
  await ensureSettingsTable();
  await ensureProbeCredential();
  startTunnelServer();
  console.log(\`[node] S5 Tunnel node server ready on :\${tunnelConfig.port}\${tunnelConfig.path}\`);
}

main().catch((err) => {
  console.error("[node] fatal", err);
  process.exit(1);
});
`,
  });

  // --- project files ---
  files.push({
    name: "package.json",
    content: JSON.stringify(
      {
        name: "s5-tunnel-node",
        version: VERSION,
        private: true,
        type: "commonjs",
        description: "S5 Tunnel node server (VLESS over WebSocket). Point it at the shared database and it becomes a node of your site.",
        scripts: {
          start: "tsx src/main.ts",
          check: "tsc --noEmit",
        },
        dependencies: {
          "drizzle-orm": "0.45.2",
          dotenv: "17.3.1",
          pg: "8.20.0",
          tsx: "4.20.3",
          ws: "8.22.0",
        },
        devDependencies: {
          "@types/node": "22.19.15",
          "@types/pg": "8.18.0",
          "@types/ws": "8.18.1",
          typescript: "5.9.3",
        },
        engines: { node: ">=20" },
      },
      null,
      2,
    ),
  });

  files.push({
    name: "tsconfig.json",
    content: JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "commonjs",
          moduleResolution: "node",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          noEmit: true,
          types: ["node"],
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  });

  const envBody = `# ===== S5 Tunnel 节点服务器 =====
# 与主站相同的 PostgreSQL 连接串（节点通过它验证用户 UUID、统计流量）。
# 需要在数据库服务器上放行本机 IP（pg_hba.conf / 安全组），并建议使用 SSL：在末尾加 ?sslmode=require
DATABASE_URL=${opts.includeDatabaseUrl ? opts.databaseUrlHint : "postgresql://USER:PASSWORD@DB_HOST:5432/app_db"}

# 监听端口与 WebSocket 路径（路径必须与主站一致：${tPath}）
TUNNEL_PORT=8080
TUNNEL_PATH=${tPath}

# 允许代理访问本机回环地址（仅调试）
# TUNNEL_ALLOW_LOCALHOST=true
`;
  files.push({ name: opts.includeDatabaseUrl ? ".env" : ".env.example", content: envBody });
  if (opts.includeDatabaseUrl) files.push({ name: ".env.example", content: envBody.replace(/^DATABASE_URL=.*$/m, "DATABASE_URL=postgresql://USER:PASSWORD@DB_HOST:5432/app_db") });

  files.push({
    name: "Dockerfile",
    content: `FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY tsconfig.json ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npx", "tsx", "src/main.ts"]
`,
  });

  files.push({
    name: "docker-compose.yml",
    content: `services:
  node:
    build: .
    restart: unless-stopped
    env_file: .env
    ports:
      - "8080:8080"
`,
  });

  files.push({
    name: "s5-tunnel-node.service",
    content: `[Unit]
Description=S5 Tunnel node server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=s5node
WorkingDirectory=/opt/s5-tunnel-node
EnvironmentFile=/opt/s5-tunnel-node/.env
ExecStart=/usr/bin/npx tsx src/main.ts
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
`,
  });

  files.push({
    name: "install.sh",
    mode: 0o755,
    content: `#!/usr/bin/env bash
# 一键部署脚本（Debian / Ubuntu，需 root）。用法：sudo bash install.sh
set -euo pipefail
DIR=/opt/s5-tunnel-node
SRC="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  echo "==> 安装 Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> 复制到 $DIR"
id -u s5node >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin s5node
mkdir -p "$DIR"
cp -r "$SRC"/src "$SRC"/package.json "$SRC"/tsconfig.json "$DIR"/
[ -f "$DIR/.env" ] || cp "$SRC"/.env* "$DIR"/ 2>/dev/null || true
[ -f "$DIR/.env" ] || cp "$SRC"/.env.example "$DIR"/.env
chown -R s5node:s5node "$DIR"

echo "==> 安装依赖"
cd "$DIR" && sudo -u s5node npm install --omit=dev --no-audit --no-fund

echo "==> 安装 systemd 服务"
cp "$SRC"/s5-tunnel-node.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now s5-tunnel-node
sleep 2
systemctl --no-pager status s5-tunnel-node | head -15

echo
echo "完成。请确认 $DIR/.env 中的 DATABASE_URL 正确，然后："
echo "  1) 用 Nginx / Caddy 为本机域名配置 HTTPS，并把 ${tPath} 反代到 127.0.0.1:8080（见 README.md）"
echo "  2) 到主站后台「节点管理」添加本站服务器类型节点：域名 = 本机域名，端口 443，路径 ${tPath}，TLS 开启"
echo "  3) 点击「立即检测」验证"
`,
  });

  files.push({
    name: "README.md",
    content: `# S5 Tunnel 节点服务器

这是从主站 **${opts.siteUrl}** 后台导出的节点服务端源码（与主站运行的隧道代码完全一致，版本 ${VERSION}）。
把它部署到任意一台服务器上，连上主站的数据库，它就成为主站的一个节点：用户用自己的账号 / UUID 直接连接，
流量统计、配额、到期、健康检测全部由主站统一管理。

## 方式一：一键脚本（Debian / Ubuntu）

\`\`\`bash
tar xzf s5-tunnel-node.tar.gz && cd s5-tunnel-node
cp .env.example .env && nano .env        # 填写 DATABASE_URL（与主站相同的数据库）
sudo bash install.sh                     # 安装 Node.js、依赖、systemd 服务
\`\`\`

## 方式二：Docker

\`\`\`bash
cp .env.example .env && nano .env
docker compose up -d --build
\`\`\`

## 方式三：手动运行

\`\`\`bash
npm install
npm start          # 监听 0.0.0.0:8080${tPath}
\`\`\`

## 配置 HTTPS（推荐，客户端使用 wss://）

Caddy（自动申请证书，最简单）：

\`\`\`
node1.example.com {
    reverse_proxy 127.0.0.1:8080
}
\`\`\`

Nginx：

\`\`\`nginx
server {
    listen 443 ssl http2;
    server_name node1.example.com;
    ssl_certificate     /etc/letsencrypt/live/node1.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/node1.example.com/privkey.pem;

    location ${tPath} {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 600s;
    }
    location / { return 404; }
}
\`\`\`

也可以把域名套在 Cloudflare 后面（开启 WebSocket，代理状态为橙色云）。

## 在主站添加节点

主站后台 → 节点管理 → 手动添加节点：

| 字段 | 值 |
|---|---|
| 类型 | 本站服务器（直连出口） |
| 域名 / IP | node1.example.com |
| 端口 | 443（直接暴露 8080 明文时填 8080 并关闭 TLS，仅建议测试） |
| WS 路径 | ${tPath} |
| TLS | 开启 |

保存后点击「立即检测」，看到「正常 · 目标响应 …」即部署成功。

## 数据库连通性

- 节点需要能访问主站的 PostgreSQL：在数据库服务器的 \`pg_hba.conf\` 与防火墙 / 安全组中放行节点 IP，或使用云数据库的公网地址。
- 强烈建议加密连接：\`DATABASE_URL=postgresql://...?sslmode=require\`。
- 排错：\`journalctl -u s5-tunnel-node -f\`（systemd）或 \`docker compose logs -f\`。

## 常见问题

- **检测提示 HTTP 404**：反向代理没有把 \`${tPath}\` 转发到 8080，或 TUNNEL_PATH 与主站不一致。
- **检测提示 unauthorized**：节点连接的不是主站数据库（DATABASE_URL 填错）。
- **连接被拒绝**：服务未启动或端口被防火墙拦截，\`ss -lntp | grep 8080\` 查看监听。
`,
  });

  return files;
}

/** Create the archive with system tar / zip (both available on Linux). */
export async function buildNodePackageArchive(opts: PackageOptions): Promise<{ data: Buffer; filename: string; contentType: string }> {
  const files = await buildNodePackageFiles(opts);
  const dir = await mkdtemp(path.join(os.tmpdir(), "s5node-"));
  const root = path.join(dir, "s5-tunnel-node");
  try {
    for (const f of files) {
      const full = path.join(root, f.name);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, f.content, { mode: f.mode ?? 0o644 });
    }
    if (opts.format === "zip") {
      const out = path.join(dir, "s5-tunnel-node.zip");
      await execFileAsync("zip", ["-qr", out, "s5-tunnel-node"], { cwd: dir });
      return { data: await readFile(out), filename: "s5-tunnel-node.zip", contentType: "application/zip" };
    }
    const out = path.join(dir, "s5-tunnel-node.tar.gz");
    await execFileAsync("tar", ["-czf", out, "s5-tunnel-node"], { cwd: dir });
    return { data: await readFile(out), filename: "s5-tunnel-node.tar.gz", contentType: "application/gzip" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
