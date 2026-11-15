import Link from "next/link";
import { redirect } from "next/navigation";
import { acceptOrganizationInvitation, getInvitationByToken, invitationUrl } from "@/lib/invitation-tokens";
import { acceptProductInvitation, getProductInvitationByToken } from "@/lib/product-members";
import { chandlerBaseUrl } from "@/lib/env";
import { getSessionUser } from "@/lib/session";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { pick } from "@/lib/ui-locale";
import { INVITATION_ACCEPT } from "@/lib/ui-strings/workspace";

export const dynamic = "force-dynamic";

interface InvitationView {
  kind: "organization" | "product";
  targetName: string;
  role: string;
  email: string;
}

async function resolveInvitation(token: string): Promise<InvitationView | null> {
  try {
    const organization = await getInvitationByToken(token);
    if (organization) return { kind: "organization", targetName: organization.organizationName, role: organization.role, email: organization.email };
    const product = await getProductInvitationByToken(token);
    if (product) return { kind: "product", targetName: product.productName, role: product.role, email: product.email };
  } catch {
    return null;
  }
  return null;
}

function InviteNotice({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="status-page"><span className="eyebrow">WORKSPACE INVITATION</span><h1>{title}</h1>{children}</main>;
}

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const locale = await resolveUiLocale();
  const L = INVITATION_ACCEPT;
  const invitation = token ? await resolveInvitation(token) : null;
  if (!invitation) {
    return <InviteNotice title={pick(locale, L.invalidTitle)}><p>{pick(locale, L.invalidBody)}</p><Link className="primary-button" href="/">{pick(locale, L.backHome)}</Link></InviteNotice>;
  }

  const targetLabel = `${pick(locale, invitation.kind === "product" ? L.productTargetPrefix : L.workspaceTargetPrefix)}${invitation.targetName}${pick(locale, L.targetSuffix)}`;
  const user = await getSessionUser();
  if (!user) {
    const next = `/invitations/accept?token=${encodeURIComponent(token)}`;
    return <InviteNotice title={pick(locale, L.acceptTitle)}>
      <p>{pick(locale, L.bodyPrefix)}<strong>{targetLabel}</strong>{pick(locale, L.bodyRolePrefix)}<strong>{invitation.role}</strong>{pick(locale, L.bodyEmailPrefix)}{invitation.email}{pick(locale, L.bodyEmailSuffix)}</p>
      <p><Link className="primary-button" href={`/auth/login?next=${encodeURIComponent(next)}`}>{pick(locale, L.loginAcceptButton)}</Link></p>
      <p><a className="secondary-button" href={`${chandlerBaseUrl()}/user/register?next=${encodeURIComponent(invitationUrl(token))}`}>{pick(locale, L.registerAcceptButton)}</a></p>
    </InviteNotice>;
  }

  try {
    let redirectPath = "/organizations";
    if (invitation.kind === "product") {
      const accepted = await acceptProductInvitation(user, token);
      redirectPath = `/products/${accepted.organizationSlug}/${accepted.productSlug}`;
    } else {
      await acceptOrganizationInvitation(user, token);
    }
    redirect(redirectPath);
  } catch (error) {
    const message = error instanceof Error && error.message === "invitation_email_mismatch"
      ? `${pick(locale, L.mismatchPrefix)}${invitation.email}${pick(locale, L.mismatchSuffix)}`
      : pick(locale, L.failureBody);
    const next = `/invitations/accept?token=${encodeURIComponent(token)}`;
    return <InviteNotice title={pick(locale, L.failureTitle)}><p>{message}</p><Link className="primary-button" href={`/auth/login?next=${encodeURIComponent(next)}`}>{pick(locale, L.reloginButton)}</Link></InviteNotice>;
  }
}
