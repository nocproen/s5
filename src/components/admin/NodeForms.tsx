"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/lib/actions";
import { adminImportNodesAction, adminSaveNodeAction } from "@/lib/admin-actions";

export type NodeFormValues = {
  id: string;
  name: string;
  host: string;
  port: number;
  path: string;
  tls: boolean;
  sni: string | null;
  sortOrder: number;
  kind: string;
  upstreamUrl: string | null;
  upstreamUuid: string | null;
  upstreamSni: string | null;
  relay: boolean;
  routeKey: string | null;
};

function Feedback({ state }: { state: FormState }) {
  if (!state?.error && !state?.success) return null;
  return state.error ? (
    <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{state.error}</p>
  ) : (
    <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{state.success}</p>
  );
}

function ModeRadios({ name, value, onChange }: { name: string; value: "relay" | "direct"; onChange: (v: "relay" | "direct") => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label
        className={`cursor-pointer rounded-xl border p-3 text-sm ${
          value === "relay" ? "border-sky-400/60 bg-sky-400/10" : "border-white/10 bg-white/[0.03]"
        }`}
      >
        <div className="flex items-center gap-2">
          <input type="radio" name={name} value="relay" checked={value === "relay"} onChange={() => onChange("relay")} />
          <b>经本站转发（推荐）</b>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          用户连接本站，本站再用上游凭据转发。凭据不外泄，流量统计 / 配额照常生效；消耗本站带宽。
        </p>
      </label>
      <label
        className={`cursor-pointer rounded-xl border p-3 text-sm ${
          value === "direct" ? "border-amber-400/60 bg-amber-400/10" : "border-white/10 bg-white/[0.03]"
        }`}
      >
        <div className="flex items-center gap-2">
          <input type="radio" name={name} value="direct" checked={value === "direct"} onChange={() => onChange("direct")} />
          <b>直接分发凭据</b>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          把上游地址和 UUID 直接下发给用户，用户直连上游。不占本站带宽，但所有用户共用同一凭据，且本站无法统计流量。
        </p>
      </label>
    </div>
  );
}

export function NodeForm({ node, tunnelPath }: { node?: NodeFormValues; tunnelPath: string }) {
  const [state, formAction, pending] = useActionState(adminSaveNodeAction, undefined);
  const [kind, setKind] = useState<"local" | "upstream">(node?.kind === "upstream" ? "upstream" : "local");
  const [mode, setMode] = useState<"relay" | "direct">(node && node.kind === "upstream" && !node.relay ? "direct" : "relay");
  const isAutoEntry = !node || node.host === "auto" || node.kind !== "upstream";

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="id" value={node?.id ?? ""} />
      <div className="grid gap-3 md:grid-cols-4">
        <div>
          <label className="label">类型</label>
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as "local" | "upstream")} className="input">
            <option value="local">本站服务器（直连出口）</option>
            <option value="upstream">上游节点（已有凭据）</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="label">名称</label>
          <input name="name" defaultValue={node?.name ?? ""} className="input" placeholder="香港 01" required />
        </div>
        <div>
          <label className="label">排序</label>
          <input name="sortOrder" type="number" defaultValue={node?.sortOrder ?? 0} className="input" />
        </div>
      </div>

      {kind === "local" ? (
        <div className="grid gap-3 md:grid-cols-5">
          <div className="md:col-span-2">
            <label className="label">域名 / IP（auto = 跟随网址）</label>
            <input name="host" defaultValue={node?.host ?? ""} className="input" placeholder="hk.example.com 或 auto" required />
          </div>
          <div>
            <label className="label">端口</label>
            <input name="port" type="number" defaultValue={node?.port ?? 443} className="input" />
          </div>
          <div>
            <label className="label">WS 路径</label>
            <input name="path" defaultValue={node?.path ?? tunnelPath} className="input" />
          </div>
          <div>
            <label className="label">SNI / Host（可选）</label>
            <input name="sni" defaultValue={node?.sni ?? ""} className="input" placeholder="套 CDN 时填写" />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300 md:col-span-5">
            <input type="checkbox" name="tls" defaultChecked={node?.tls ?? true} className="h-4 w-4" /> TLS (wss)
          </label>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="md:col-span-2">
              <label className="label">上游地址</label>
              <input
                name="upstreamUrl"
                defaultValue={node?.upstreamUrl ?? ""}
                className="input mono"
                placeholder="wss://example.com/tunnel"
                required
              />
            </div>
            <div>
              <label className="label">上游 UUID（凭据）</label>
              <input
                name="upstreamUuid"
                defaultValue={node?.upstreamUuid ?? ""}
                className="input mono"
                placeholder="d55ebd24-74f0-434c-a3c3-…"
                pattern="[0-9a-fA-F-]{36}"
                required
              />
            </div>
            <div>
              <label className="label">上游 SNI / Host（可选）</label>
              <input name="upstreamSni" defaultValue={node?.upstreamSni ?? ""} className="input" placeholder="上游套 CDN 时填写" />
            </div>
          </div>
          <ModeRadios name="mode" value={mode} onChange={setMode} />
          {mode === "relay" && (
            <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
              用户看到的入口：
              <code className="mono text-sky-200">
                {" "}
                {isAutoEntry ? "（当前网址）" : `${node?.tls ? "wss" : "ws"}://${node?.host}:${node?.port}`}
                {tunnelPath}/{node?.routeKey ?? "<保存后生成>"}
              </code>
              <details className="mt-2">
                <summary className="cursor-pointer hover:text-slate-200">自定义入口地址（高级，通常保持 auto）</summary>
                <div className="mt-2 grid gap-3 md:grid-cols-4">
                  <div>
                    <label className="label">入口域名</label>
                    <input name="host" defaultValue={node?.kind === "upstream" ? (node?.host ?? "auto") : "auto"} className="input" />
                  </div>
                  <div>
                    <label className="label">端口</label>
                    <input name="port" type="number" defaultValue={node?.kind === "upstream" ? (node?.port ?? 443) : 443} className="input" />
                  </div>
                  <div>
                    <label className="label">SNI / Host</label>
                    <input name="sni" defaultValue={node?.kind === "upstream" ? (node?.sni ?? "") : ""} className="input" />
                  </div>
                  <label className="flex items-center gap-2 pt-6 text-sm text-slate-300">
                    <input type="checkbox" name="tls" defaultChecked={node?.kind === "upstream" ? (node?.tls ?? true) : true} className="h-4 w-4" /> TLS
                  </label>
                </div>
              </details>
            </div>
          )}
        </div>
      )}

      <Feedback state={state} />
      <button className="btn-primary" disabled={pending}>
        {pending ? "保存中…" : node ? "保存修改" : "添加节点"}
      </button>
    </form>
  );
}

export function NodeImportForm() {
  const [state, formAction, pending] = useActionState(adminImportNodesAction, undefined);
  const [mode, setMode] = useState<"relay" | "direct">("relay");
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label className="label" htmlFor="import-text">
          粘贴凭据（每行一个）
        </label>
        <textarea
          id="import-text"
          name="text"
          rows={4}
          className="input mono"
          placeholder={`wss://3000-xxxx.e2b.app/tunnel --uuid d55ebd24-74f0-434c-a3c3-c2c14afadf54\nvless://UUID@host:443?type=ws&path=%2Ftunnel&security=tls#香港 01`}
          required
        />
        <p className="mt-1 text-xs text-slate-500">支持「wss://地址/路径 --uuid UUID」（轻量客户端命令格式）与 vless:// 链接（仅 WebSocket 传输）。</p>
      </div>
      <ModeRadios name="mode" value={mode} onChange={setMode} />
      <Feedback state={state} />
      <button className="btn-primary" disabled={pending}>
        {pending ? "导入中…" : "导入节点"}
      </button>
    </form>
  );
}
