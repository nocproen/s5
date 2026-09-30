/**
 * Catalog of the lightweight (single-file) client implementations shipped in /public/client.
 * Every implementation speaks the same protocol (VLESS over WebSocket) and exposes a local SOCKS5 port.
 * Placeholders "__SERVER__" / "__UUID__" inside the source are replaced when a logged-in user downloads it.
 */
export type ClientLang = "node" | "python" | "go" | "rust" | "java" | "csharp";

export type ClientDef = {
  id: ClientLang;
  name: string;
  icon: string;
  /** Path under public/ of the main source file. */
  file: string;
  /** Filename used for the personalized download. */
  downloadName: string;
  /** Extra files (relative to public/) that are not personalized, e.g. Cargo.toml. */
  extraFiles?: { file: string; downloadName: string; label: string }[];
  runtime: string;
  deps: string;
  highlight: string;
  /** Commands for running the personalized file (no args needed). */
  run: string[];
  /** Commands for building a distributable binary (optional). */
  build?: string[];
  contentType: string;
  tested: boolean;
};

export const CLIENTS: ClientDef[] = [
  {
    id: "node",
    name: "Node.js",
    icon: "🟢",
    file: "client/socks5-ws-client.mjs",
    downloadName: "socks5-ws-client.mjs",
    runtime: "Node.js 22+（也可在 Bun / Deno 运行）",
    deps: "零依赖（内置 WebSocket）",
    highlight: "最简单：一个文件一条命令。",
    run: ["node socks5-ws-client.mjs", "# 或: bun socks5-ws-client.mjs"],
    contentType: "text/javascript; charset=utf-8",
    tested: true,
  },
  {
    id: "python",
    name: "Python",
    icon: "🐍",
    file: "client/socks5_ws_client.py",
    downloadName: "socks5_ws_client.py",
    runtime: "Python 3.8+",
    deps: "零依赖（WebSocket 帧自实现，无需 pip）",
    highlight: "几乎所有 Linux / macOS 自带 Python，服务器上最方便。",
    run: ["python3 socks5_ws_client.py"],
    contentType: "text/x-python; charset=utf-8",
    tested: true,
  },
  {
    id: "go",
    name: "Go",
    icon: "🐹",
    file: "client/socks5-ws-client.go",
    downloadName: "socks5-ws-client.go",
    runtime: "Go 1.18+",
    deps: "零依赖（仅标准库）",
    highlight: "可交叉编译成单个静态二进制，分发给没有任何运行时的机器。",
    run: ["go run socks5-ws-client.go"],
    build: [
      "go build -o s5client socks5-ws-client.go",
      "GOOS=windows GOARCH=amd64 go build -o s5client.exe socks5-ws-client.go",
      "GOOS=darwin GOARCH=arm64 go build -o s5client-mac socks5-ws-client.go",
      "GOOS=linux GOARCH=arm64 go build -o s5client-arm64 socks5-ws-client.go",
    ],
    contentType: "text/x-go; charset=utf-8",
    tested: true,
  },
  {
    id: "rust",
    name: "Rust",
    icon: "🦀",
    file: "client/rust/src/main.rs",
    downloadName: "main.rs",
    extraFiles: [{ file: "client/rust/Cargo.toml", downloadName: "Cargo.toml", label: "Cargo.toml" }],
    runtime: "Rust 1.70+（cargo）",
    deps: "tokio + tokio-tungstenite（rustls，无需 OpenSSL）",
    highlight: "性能最高、内存占用最小的原生二进制。",
    run: ["mkdir -p s5client/src && cd s5client", "# 把 Cargo.toml 放到当前目录，main.rs 放到 src/", "cargo run --release"],
    build: ["cargo build --release   # 产物: target/release/s5client"],
    contentType: "text/x-rust; charset=utf-8",
    tested: true,
  },
  {
    id: "java",
    name: "Java",
    icon: "☕",
    file: "client/Socks5WsClient.java",
    downloadName: "Socks5WsClient.java",
    runtime: "Java 11+",
    deps: "零依赖（JDK 内置 java.net.http.WebSocket）",
    highlight: "单文件源码直接启动，无需编译。",
    run: ["java Socks5WsClient.java"],
    contentType: "text/x-java-source; charset=utf-8",
    tested: true,
  },
  {
    id: "csharp",
    name: "C# / .NET",
    icon: "🟣",
    file: "client/csharp/Program.cs",
    downloadName: "Program.cs",
    extraFiles: [{ file: "client/csharp/s5client.csproj", downloadName: "s5client.csproj", label: "s5client.csproj" }],
    runtime: ".NET 6+ SDK",
    deps: "零第三方依赖（内置 ClientWebSocket）",
    highlight: "Windows 用户友好，可发布为单文件 exe。",
    run: ["mkdir s5client && cd s5client", "# 把 Program.cs 与 s5client.csproj 放到当前目录", "dotnet run"],
    build: ["dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true"],
    contentType: "text/plain; charset=utf-8",
    tested: true,
  },
];

export function getClient(id: string | null | undefined): ClientDef {
  return CLIENTS.find((c) => c.id === id) ?? CLIENTS[0];
}

/** Inject the user's server URL and UUID into the placeholders of a client source. */
export function personalize(source: string, serverUrl: string, uuid: string): string {
  return source.replaceAll("__SERVER__", serverUrl).replaceAll("__UUID__", uuid);
}
