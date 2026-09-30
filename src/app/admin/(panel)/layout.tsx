import type { ReactNode } from "react";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin-auth";
import { AdminHeader } from "@/components/admin/AdminHeader";

export const dynamic = "force-dynamic";

export const metadata = { robots: { index: false, follow: false } };

export default async function AdminPanelLayout({ children }: { children: ReactNode }) {
  const admin = await requireAdmin();
  return (
    <>
      <AdminHeader admin={admin} />
      {admin.mustChangePassword && (
        <div className="border-b border-rose-500/30 bg-rose-500/10">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm text-rose-200">
            <span>⚠️ 当前管理员仍在使用默认密码，任何人都可能登录后台，请立即修改。</span>
            <Link href="/admin/settings" className="btn-danger !px-3 !py-1 text-xs">
              去修改密码
            </Link>
          </div>
        </div>
      )}
      {children}
    </>
  );
}
