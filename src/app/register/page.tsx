import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/SiteHeader";
import { AuthForm } from "@/components/AuthForm";
import { registerAction } from "@/lib/actions";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  return (
    <>
      <SiteHeader />
      <main className="mx-auto grid min-h-[calc(100vh-3.5rem)] max-w-md place-items-center px-4 py-12">
        <div className="card w-full p-8">
          <h1 className="text-2xl font-semibold">创建账号</h1>
          <p className="mt-1 text-sm text-slate-400">注册即自动分配专属 UUID 与订阅链接，注册后即可下载客户端使用。</p>
          <div className="mt-6">
            <AuthForm mode="register" action={registerAction} />
          </div>
        </div>
      </main>
    </>
  );
}
