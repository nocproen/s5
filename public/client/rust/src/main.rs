//! S5 Tunnel 轻量客户端 (Rust) —— 本地 SOCKS5 ⇄ WebSocket ⇄ 服务器
//! S5 Tunnel lightweight client (Rust) — local SOCKS5 ⇄ WebSocket ⇄ server
//!
//! 依赖 tokio + tokio-tungstenite（见同目录 Cargo.toml），编译为单个静态二进制。
//!
//!     cargo build --release
//!     ./target/release/s5client --server wss://example.com/tunnel --uuid <UUID> --listen 127.0.0.1:1080
//!
//! 协议：VLESS over WebSocket（与 v2rayN / v2rayNG / Shadowrocket / Clash Meta 等客户端兼容）。

use futures_util::{SinkExt, StreamExt};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const DEFAULT_SERVER: &str = "__SERVER__";
const DEFAULT_UUID: &str = "__UUID__";
const DEFAULT_LISTEN: &str = "127.0.0.1:1080";

static ACTIVE: AtomicUsize = AtomicUsize::new(0);

struct Config {
    server: String,
    uuid: [u8; 16],
    verbose: bool,
}

fn parse_uuid(s: &str) -> Option<[u8; 16]> {
    let hex: String = s.chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn vless_header(uuid: &[u8; 16], host: &str, port: u16) -> Vec<u8> {
    let mut b = Vec::with_capacity(64);
    b.push(0); // version
    b.extend_from_slice(uuid);
    b.push(0); // addons length
    b.push(1); // cmd: TCP
    b.extend_from_slice(&port.to_be_bytes());
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            b.push(1);
            b.extend_from_slice(&ip.octets());
        }
        Ok(IpAddr::V6(ip)) => {
            b.push(3);
            b.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            b.push(2);
            b.push(host.len() as u8);
            b.extend_from_slice(host.as_bytes());
        }
    }
    b
}

fn socks_fail(code: u8) -> [u8; 10] {
    [5, code, 0, 1, 0, 0, 0, 0, 0, 0]
}
const SOCKS_OK: [u8; 10] = [5, 0, 0, 1, 0, 0, 0, 0, 0, 0];

async fn handle(mut sock: TcpStream, cfg: Arc<Config>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _ = sock.set_nodelay(true);
    // greeting
    let mut hdr = [0u8; 2];
    sock.read_exact(&mut hdr).await?;
    if hdr[0] != 5 {
        return Ok(());
    }
    let mut methods = vec![0u8; hdr[1] as usize];
    sock.read_exact(&mut methods).await?;
    sock.write_all(&[5, 0]).await?; // NO AUTH
    // request
    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await?;
    let host = match req[3] {
        1 => {
            let mut b = [0u8; 4];
            sock.read_exact(&mut b).await?;
            Ipv4Addr::from(b).to_string()
        }
        3 => {
            let mut l = [0u8; 1];
            sock.read_exact(&mut l).await?;
            let mut b = vec![0u8; l[0] as usize];
            sock.read_exact(&mut b).await?;
            String::from_utf8_lossy(&b).into_owned()
        }
        4 => {
            let mut b = [0u8; 16];
            sock.read_exact(&mut b).await?;
            Ipv6Addr::from(b).to_string()
        }
        _ => {
            sock.write_all(&socks_fail(8)).await?;
            return Ok(());
        }
    };
    let mut pb = [0u8; 2];
    sock.read_exact(&mut pb).await?;
    let port = u16::from_be_bytes(pb);
    if req[1] != 1 {
        sock.write_all(&socks_fail(7)).await?;
        return Ok(());
    }
    let n = ACTIVE.fetch_add(1, Ordering::Relaxed) + 1;
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            ACTIVE.fetch_sub(1, Ordering::Relaxed);
        }
    }
    let _guard = Guard;
    if cfg.verbose {
        eprintln!("→ {}:{} (active {})", host, port, n);
    }

    let (ws, _) = match connect_async(cfg.server.as_str()).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("连接服务器失败: {}", e);
            sock.write_all(&socks_fail(5)).await?;
            return Ok(());
        }
    };
    let (mut tx, mut rx) = ws.split();
    tx.send(Message::Binary(vless_header(&cfg.uuid, &host, port).into())).await?;
    sock.write_all(&SOCKS_OK).await?;

    let (mut sr, mut sw) = sock.into_split();
    let mut up = tokio::spawn(async move {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            let n = match sr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                break;
            }
        }
        let _ = tx.close().await;
    });
    let verbose = cfg.verbose;
    let (h2, p2) = (host.clone(), port);
    let mut down = tokio::spawn(async move {
        let mut header_done = false;
        let mut pending: Vec<u8> = Vec::new();
        while let Some(Ok(msg)) = rx.next().await {
            let data: Vec<u8> = match msg {
                Message::Binary(b) => b.to_vec(),
                Message::Close(frame) => {
                    if let Some(f) = frame {
                        let code: u16 = f.code.into();
                        if code == 1008 {
                            eprintln!("服务器拒绝连接: {}（请检查 UUID / 流量 / 有效期）", f.reason);
                        }
                        if verbose {
                            eprintln!("← {}:{} closed ({})", h2, p2, code);
                        }
                    }
                    break;
                }
                _ => continue,
            };
            let out: Vec<u8> = if !header_done {
                pending.extend_from_slice(&data);
                if pending.len() < 2 {
                    continue;
                }
                let al = pending[1] as usize;
                if pending.len() < 2 + al {
                    continue;
                }
                header_done = true;
                let o = pending[2 + al..].to_vec();
                pending.clear();
                o
            } else {
                data
            };
            if out.is_empty() {
                continue;
            }
            if sw.write_all(&out).await.is_err() {
                break;
            }
        }
        let _ = sw.shutdown().await;
    });
    tokio::select! {
        _ = &mut up => { down.abort(); }
        _ = &mut down => { up.abort(); }
    }
    Ok(())
}

fn arg(args: &[String], name: &str, env: &str, fallback: &str) -> String {
    if let Some(i) = args.iter().position(|a| a == name) {
        if let Some(v) = args.get(i + 1) {
            return v.clone();
        }
    }
    std::env::var(env).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Select the TLS crypto provider explicitly (required by rustls 0.23).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let server = arg(&args, "--server", "S5_SERVER", DEFAULT_SERVER);
    let uuid_str = arg(&args, "--uuid", "S5_UUID", DEFAULT_UUID);
    let listen = arg(&args, "--listen", "S5_LISTEN", DEFAULT_LISTEN);
    let verbose = args.iter().any(|a| a == "-v" || a == "--verbose");
    if server.starts_with("__") || uuid_str.starts_with("__") {
        eprintln!("用法: s5client --server wss://host/tunnel --uuid <UUID> [--listen 127.0.0.1:1080]");
        std::process::exit(1);
    }
    let uuid = match parse_uuid(&uuid_str) {
        Some(u) => u,
        None => {
            eprintln!("UUID 格式不正确");
            std::process::exit(1);
        }
    };
    let cfg = Arc::new(Config { server: server.clone(), uuid, verbose });
    let listener = TcpListener::bind(&listen).await?;
    println!("✔ SOCKS5 代理已启动: socks5://{}", listen);
    println!("  服务器: {}", server);
    println!("  UUID  : {}…", &uuid_str[..8]);
    println!("  把浏览器/系统代理设置为 SOCKS5 {} 即可使用，Ctrl+C 退出", listen);
    loop {
        let (sock, _) = listener.accept().await?;
        let cfg = cfg.clone();
        tokio::spawn(async move {
            if let Err(e) = handle(sock, cfg.clone()).await {
                if cfg.verbose {
                    eprintln!("error: {}", e);
                }
            }
        });
    }
}
