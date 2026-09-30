import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/SiteHeader";
import { AuthForm } from "@/components/AuthForm";
import { loginAction } from "@/lib/actions";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  return (
    <>
      <SiteHeader />
      <main className="mx-auto grid min-h-[calc(100vh-3.5rem)] max-w-md place-items-center px-4 py-12">
        <div className="card w-full p-8">
          <h1 className="text-2xl font-semibold">登录</h1>
          <p className="mt-1 text-sm text-slate-400">欢迎回来，登录后查看你的节点与流量。</p>
          <div className="mt-6">
            <AuthForm mode="login" action={loginAction} />
          </div>
        </div>
      </main>
    </>
  );
}
