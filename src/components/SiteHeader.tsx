import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { logoutAction } from "@/lib/actions";

export async function SiteHeader({ active }: { active?: string }) {
  const user = await getCurrentUser();
  const nav = user
    ? [
        { href: "/dashboard", label: "控制台", key: "dashboard" },
        { href: "/dashboard/download", label: "下载客户端", key: "download" },
        { href: "/dashboard/settings", label: "账户设置", key: "settings" },
      ]
    : [];

  return (
    <header className="sticky top-0 z-20 border-b border-white/10 bg-[#0b1020]/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-sky-400 to-violet-500 text-xs font-bold text-white">
            S5
          </span>
          <span>S5 Tunnel</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {nav.map((n) => (
            <Link
              key={n.key}
              href={n.href}
              className={`rounded-lg px-3 py-1.5 transition hover:bg-white/10 ${
                active === n.key ? "bg-white/10 text-white" : "text-slate-300"
              }`}
            >
              {n.label}
            </Link>
          ))}
          {user ? (
            <form action={logoutAction} className="ml-2 flex items-center gap-2">
              <span className="hidden text-xs text-slate-400 sm:inline">{user.email}</span>
              <button className="btn-ghost !px-3 !py-1.5 text-xs">退出</button>
            </form>
          ) : (
            <>
              <Link href="/login" className="btn-ghost !px-3 !py-1.5">
                登录
              </Link>
              <Link href="/register" className="btn-primary !px-3 !py-1.5">
                免费注册
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
