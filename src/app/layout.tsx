import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "S5 Tunnel — 简单稳定的 SOCKS5 代理服务",
  description:
    "注册账号，下载客户端，点击连接即可使用 SOCKS5 代理。兼容 v2rayN / v2rayNG / Shadowrocket / Clash 等主流客户端，手机电脑全平台支持。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="text-slate-100 antialiased">{children}</body>
    </html>
  );
}
