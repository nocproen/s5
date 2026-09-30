import { asc } from "drizzle-orm";
import { db } from "@/db";
import { admins } from "@/db/schema";
import { requireAdmin } from "@/lib/admin-auth";
import { adminDeleteAdminAction } from "@/lib/admin-actions";
import { formatDate } from "@/lib/links";
import { AdminCreateForm, AdminPasswordForm } from "@/components/admin/AdminForms";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const me = await requireAdmin();
  const list = await db
    .select({
      id: admins.id,
      username: admins.username,
      mustChangePassword: admins.mustChangePassword,
      lastLoginAt: admins.lastLoginAt,
      createdAt: admins.createdAt,
    })
    .from(admins)
    .orderBy(asc(admins.createdAt));

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">管理员设置</h1>
        <p className="mt-1 text-sm text-slate-400">
          后台管理员账号存放在独立的 <code className="mono">admins</code> 表中，与前台用户无关；前台注册的用户永远无法进入后台。
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="card p-6">
          <h2 className="text-lg font-semibold">修改我的密码</h2>
          <p className="mt-1 text-sm text-slate-400">当前登录：{me.username}</p>
          <div className="mt-4">
            <AdminPasswordForm />
          </div>
        </section>

        <section className="card p-6">
          <h2 className="text-lg font-semibold">添加管理员</h2>
          <p className="mt-1 text-sm text-slate-400">为其他运维人员创建独立的后台账号。</p>
          <div className="mt-4">
            <AdminCreateForm />
          </div>
        </section>
      </div>

      <section className="card p-6">
        <h2 className="text-lg font-semibold">管理员列表（{list.length}）</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-400">
              <tr>
                <th className="py-2 pr-4">用户名</th>
                <th className="py-2 pr-4">状态</th>
                <th className="py-2 pr-4">最近登录</th>
                <th className="py-2 pr-4">创建时间</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {list.map((a) => (
                <tr key={a.id} className="text-slate-300">
                  <td className="py-2 pr-4">
                    <b>{a.username}</b>
                    {a.id === me.id && <span className="ml-2 text-xs text-amber-200">（当前）</span>}
                  </td>
                  <td className="py-2 pr-4">
                    {a.mustChangePassword ? <span className="text-rose-300">默认密码未修改</span> : <span className="text-emerald-300">正常</span>}
                  </td>
                  <td className="py-2 pr-4">{formatDate(a.lastLoginAt)}</td>
                  <td className="py-2 pr-4">{formatDate(a.createdAt)}</td>
                  <td className="py-2 pr-4 text-right">
                    {a.id !== me.id && list.length > 1 && (
                      <form action={adminDeleteAdminAction}>
                        <input type="hidden" name="id" value={a.id} />
                        <button className="btn-danger !px-3 !py-1 text-xs">删除</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-6 text-sm text-slate-400">
        <h2 className="text-lg font-semibold text-slate-100">忘记管理员密码？</h2>
        <p className="mt-2">在服务器上直接重置（把 &lt;新密码&gt; 换成你的密码）：</p>
        <pre className="code mt-3">{`node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');console.log(s+':'+c.scryptSync(process.argv[1],s,64).toString('hex'))" '<新密码>' \\
  | xargs -I{} psql "$DATABASE_URL" -c "update admins set password_hash='{}', must_change_password=false where username='${me.username}'"`}</pre>
      </section>
    </main>
  );
}
