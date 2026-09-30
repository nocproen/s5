import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/admin-auth";
import { AdminLoginForm } from "@/components/admin/AdminForms";

export const dynamic = "force-dynamic";

export const metadata = { title: "管理后台登录 — S5 Tunnel", robots: { index: false, follow: false } };

export default async function AdminLoginPage() {
  const admin = await getCurrentAdmin();
  if (admin) redirect("/admin");
  return (
    <main className="mx-auto grid min-h-screen max-w-md place-items-center px-4 py-12">
      <div className="card w-full border-amber-400/20 p-8">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-amber-400 to-rose-500 text-xs font-bold text-white">
            ADM
          </span>
          <div>
            <h1 className="text-xl font-semibold">管理后台</h1>
            <p className="text-xs text-slate-400">仅限管理员，与用户账号相互独立</p>
          </div>
        </div>
        <div className="mt-6">
          <AdminLoginForm />
        </div>
        <p className="mt-6 text-center text-xs text-slate-500">
          <Link href="/" className="hover:text-slate-300">
            ← 返回前台
          </Link>
        </p>
      </div>
    </main>
  );
}
