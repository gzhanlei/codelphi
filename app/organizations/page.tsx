import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { listUserOrganizations } from "@/lib/organizations";
import { requireSessionUser } from "@/lib/session";
import { currentOrganization } from "@/lib/organizations";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<{ invited?: string; inviteUrl?: string; emailSent?: string }> }) {
  const user = await requireSessionUser();
  const { invited, inviteUrl, emailSent } = await searchParams;
  const organization = await currentOrganization(user);
  const organizations = await listUserOrganizations(user);
  const db = getDb();
  const [productRows] = await db.execute("SELECT slug, name FROM products WHERE organization_id = ? ORDER BY name", [organization.id]);
  const products = productRows as Array<{ slug: string; name: string }>;

  return (
    <AppShell user={user} organizationName={organization.name}>
      <Link className="back-link" href="/">← 所有产品</Link>
      <div className="page-heading">
        <div><span className="eyebrow">WORKSPACES</span><h1>我的工作区</h1><p>你创建或加入的产品空间。</p></div>
      </div>
      <div className="panel">
        {organization.role === "owner" ? <form className="invite-form" action="/organizations/invite" method="post">
          <h2>邀请成员</h2>
          <p>选择邀请范围：整个工作区，或仅某个产品。系统会通过 Chandler 发送注册邮件；对方登录或注册后，打开邀请链接即可加入。</p>
          <label className="field" style={{ flex: "0 0 260px", width: 260, maxWidth: 260 }}><span>邮箱</span><input name="email" type="email" required placeholder="partner@example.com" /></label>
          <label className="field role-field" style={{ flex: "0 0 200px", width: 200, maxWidth: 200 }}><span>范围</span><select name="product" defaultValue="">
            <option value="">整个工作区</option>
            {products.map((product) => <option key={product.slug} value={product.slug}>仅产品：{product.name}</option>)}
          </select></label>
          <label className="field role-field" style={{ flex: "0 0 120px", width: 120, maxWidth: 120 }}><span>角色</span><select name="role" defaultValue="editor"><option value="editor">editor</option><option value="viewer">viewer</option></select></label>
          <button className="primary-button" type="submit">邀请</button>
          {invited ? <div className="invite-result">
            <p className="success-text">{invited === "member_added" ? "成员已加入。" : "邀请已创建，对方登录或注册后即可加入。"}</p>
            {inviteUrl ? <p><a href={inviteUrl} target="_blank" rel="noreferrer">打开邀请链接</a>
            {emailSent === "true" ? " · Chandler 注册邮件已发送" : " · 该邮箱已注册或未发送注册邮件，请复制邀请链接发送给对方"}</p> : null}
          </div> : null}
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
