import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { listUserOrganizations } from "@/lib/organizations";
import { requireSessionUser } from "@/lib/session";
import { currentOrganization } from "@/lib/organizations";
import { pick } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { ORGANIZATIONS as L } from "@/lib/ui-strings/dashboard";

export const dynamic = "force-dynamic";

export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<{ invited?: string; inviteUrl?: string; emailSent?: string }> }) {
  const user = await requireSessionUser();
  const { invited, inviteUrl, emailSent } = await searchParams;
  const organization = await currentOrganization(user);
  const organizations = await listUserOrganizations(user);
  const locale = await resolveUiLocale();

  return (
    <AppShell user={user} organizationName={organization.name}>
      <Link className="back-link" href="/">{pick(locale, L.backLink)}</Link>
      <div className="page-heading">
        <div><span className="eyebrow">WORKSPACES</span><h1>{pick(locale, L.heading)}</h1><p>{pick(locale, L.subheading)}</p></div>
      </div>
      <div className="panel">
        {organization.role === "owner" ? <form className="invite-form" action="/organizations/invite" method="post">
          <h2>{pick(locale, L.inviteHeading)}</h2>
          <p>{pick(locale, L.inviteBody)}</p>
          <label className="field" style={{ flex: "0 0 260px", width: 260, maxWidth: 260 }}><span>{pick(locale, L.email)}</span><input name="email" type="email" required placeholder="partner@example.com" /></label>
          <label className="field role-field" style={{ flex: "0 0 120px", width: 120, maxWidth: 120 }}><span>{pick(locale, L.role)}</span><select name="role" defaultValue="editor"><option value="editor">editor</option><option value="viewer">viewer</option></select></label>
          <button className="primary-button" type="submit">{pick(locale, L.inviteButton)}</button>
          {invited ? <div className="invite-result">
            <p className="success-text">{invited === "member_added" ? pick(locale, L.memberAdded) : pick(locale, L.inviteCreated)}</p>
            {inviteUrl ? <p><a href={inviteUrl} target="_blank" rel="noreferrer">{pick(locale, L.openInviteLink)}</a>
            {emailSent === "true" ? pick(locale, L.inviteEmailSent) : pick(locale, L.inviteEmailFallback)}</p> : null}
          </div> : null}
        </form> : null}
      </div>
      <div className="panel">
        <table className="scenario-table">
          <thead><tr><th>{pick(locale, L.tableWorkspace)}</th><th>{pick(locale, L.tableRole)}</th><th>{pick(locale, L.tableActions)}</th></tr></thead>
          <tbody>
            {organizations.map((item) => <tr key={item.id}>
              <td><strong>{item.name}</strong><br /><small>{item.slug}</small></td>
              <td>{item.role === "owner" ? pick(locale, L.roleOwner) : item.role === "editor" ? pick(locale, L.roleEditor) : pick(locale, L.roleViewer)}</td>
              <td>
                {item.slug === organization.slug ? <span className="badge">{pick(locale, L.currentWorkspace)}</span> : <form action="/organizations/select" method="post">
                  <input type="hidden" name="organization" value={item.slug} />
                  <button className="secondary-button" type="submit">{pick(locale, L.switch)}</button>
                </form>}
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
