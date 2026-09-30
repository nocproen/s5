"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/admin", label: "概览 / 用户" },
  { href: "/admin/nodes", label: "节点" },
  { href: "/admin/settings", label: "管理员设置" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1 text-sm">
      {items.map((it) => {
        const active = it.href === "/admin" ? pathname === "/admin" : pathname.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`rounded-lg px-3 py-1.5 transition hover:bg-white/10 ${
              active ? "bg-amber-400/15 text-amber-200" : "text-slate-300"
            }`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
