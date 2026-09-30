import Link from "next/link";
import type { Admin } from "@/db/schema";
import { adminLogoutAction } from "@/lib/admin-actions";
import { AdminNav } from "./AdminNav";

export function AdminHeader({ admin }: { admin: Admin }) {
  return (
    <header className="sticky top-0 z-20 border-b border-amber-400/20 bg-[#140f0b]/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-6">
          <Link href="/admin" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-amber-400 to-rose-500 text-[10px] font-bold text-white">
              ADM
            </span>
            <span>S5 Tunnel 管理后台</span>
          </Link>
          <AdminNav />
        </div>
        <div className="flex items-center gap-2">
          <Link href="/" className="btn-ghost !px-3 !py-1.5 text-xs" target="_blank">
            查看前台 ↗
          </Link>
          <form action={adminLogoutAction} className="flex items-center gap-2">
            <span className="hidden text-xs text-amber-200/80 sm:inline">管理员 {admin.username}</span>
            <button className="btn-ghost !px-3 !py-1.5 text-xs">退出</button>
          </form>
        </div>
      </div>
    </header>
  );
}
