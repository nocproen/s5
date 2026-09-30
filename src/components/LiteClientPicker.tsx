"use client";

import { useState } from "react";
import type { ClientDef } from "@/lib/clients";
import { CopyButton } from "@/components/CopyButton";

export function LiteClientPicker({
  clients,
  manualArgs,
  nodeId,
}: {
  clients: ClientDef[];
  /** e.g. `--server wss://host/tunnel --uuid xxxx --listen 127.0.0.1:1080` */
  manualArgs: string;
  nodeId?: string;
}) {
  const [active, setActive] = useState<ClientDef>(clients[0]);
  const nodeParam = nodeId ? `&node=${nodeId}` : "";
  const downloadHref = `/api/client/download?lang=${active.id}${nodeParam}`;
  const runScript = active.run.join("\n");

  const manualCmd: Record<string, string> = {
    node: `node socks5-ws-client.mjs ${manualArgs}`,
    python: `python3 socks5_ws_client.py ${manualArgs}`,
    go: `go run socks5-ws-client.go ${manualArgs}`,
    rust: `cargo run --release -- ${manualArgs}`,
    java: `java Socks5WsClient.java ${manualArgs}`,
    csharp: `dotnet run -- ${manualArgs}`,
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {clients.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setActive(c)}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition ${
              active.id === c.id
                ? "border-sky-400/60 bg-sky-400/15 text-sky-100"
                : "border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.08]"
            }`}
          >
            <span>{c.icon}</span>
            {c.name}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{active.icon}</span>
            <div>
              <div className="font-semibold">{active.name} 版</div>
              <div className="text-xs text-slate-400">{active.highlight}</div>
            </div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-300">
            <dt className="text-slate-500">运行环境</dt>
            <dd>{active.runtime}</dd>
            <dt className="text-slate-500">依赖</dt>
            <dd>{active.deps}</dd>
            <dt className="text-slate-500">本地端口</dt>
            <dd>
              SOCKS5 <code className="mono text-sky-200">127.0.0.1:1080</code>（可用 <code className="mono">--listen</code> 修改）
            </dd>
          </dl>
          <div className="flex flex-wrap gap-2 pt-1">
            <a href={downloadHref} className="btn-primary">
              下载 {active.downloadName}（已内置配置）
            </a>
            {active.extraFiles?.map((f, i) => (
              <a key={f.file} href={`/api/client/download?lang=${active.id}&extra=${i}`} className="btn-ghost">
                下载 {f.label}
              </a>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            各语言版本功能一致，仅支持 SOCKS5 CONNECT（TCP）。需要 UDP 或分流规则请使用上面的图形客户端。
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="label !mb-0">运行（下载的文件已内置服务器与 UUID）</span>
              <CopyButton text={runScript} label="复制" />
            </div>
            <pre className="code">{runScript}</pre>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="label !mb-0">或手动指定参数</span>
              <CopyButton text={manualCmd[active.id]} label="复制" />
            </div>
            <pre className="code">{manualCmd[active.id]}</pre>
          </div>
          {active.build && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="label !mb-0">编译为可分发的二进制（可选）</span>
                <CopyButton text={active.build.join("\n")} label="复制" />
              </div>
              <pre className="code">{active.build.join("\n")}</pre>
            </div>
          )}
          <div>
            <span className="label">测试</span>
            <pre className="code">{`curl --socks5-hostname 127.0.0.1:1080 https://ifconfig.me`}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
