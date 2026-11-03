import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { listUserOrganizations } from "@/lib/organizations";
import { requireSessionUser } from "@/lib/session";
import { currentOrganization } from "@/lib/organizations";

export const dynamic = "force-dynamic";

export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<{ invited?: string }> }) {
  const user = await requireSessionUser();
  const { invited } = await searchParams;
  const organization = await currentOrganization(user);
  const organizations = await listUserOrganizations(user);

  return (
    <AppShell user={user} organizationName={organization.name}>
      <Link className="back-link" href="/">← 所有产品</Link>
      <div className="page-heading">
        <div><span className="eyebrow">WORKSPACES</span><h1>我的工作区</h1><p>你创建或加入的产品空间。</p></div>
      </div>
      <div className="panel">
        {organization.role === "owner" ? <form className="form-grid" action="/organizations/invite" method="post">
          <h2>邀请成员</h2>
          <p>输入对方的 Chandler 邮箱，选择 editor 或 viewer。首次登录后自动接受邀请。</p>
          <label className="field"><span>邮箱</span><input name="email" type="email" required placeholder="partner@example.com" /></label>
          <label className="field"><span>角色</span><select name="role" defaultValue="editor"><option value="editor">editor</option><option value="viewer">viewer</option></select></label>
          <button className="primary-button" type="submit">邀请</button>
          {invited ? <p className="success-text">{invited === "member_added" ? "成员已加入工作区。" : "邀请已创建，对方首次登录后自动加入。"}</p> : null}
        </form> : null}
      </div>
      <div className="panel">
        <table className="scenario-table">
          <thead><tr><th>工作区</th><th>角色</th><th>操作</th></tr></thead>
          <tbody>
            {organizations.map((item) => <tr key={item.id}>
              <td><strong>{item.name}</strong><br /><small>{item.slug}</small></td>
              <td>{item.role === "owner" ? "所有者" : item.role === "editor" ? "编辑者" : "查看者"}</td>
              <td>
                {item.slug === organization.slug ? <span className="badge">当前工作区</span> : <form action="/organizations/select" method="post">
                  <input type="hidden" name="organization" value={item.slug} />
                  <button className="secondary-button" type="submit">切换</button>
                </form>}
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
