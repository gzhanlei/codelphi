import Link from "next/link";
import { redirect } from "next/navigation";
import { acceptOrganizationInvitation, getInvitationByToken, invitationUrl } from "@/lib/invitation-tokens";
import { acceptProductInvitation, getProductInvitationByToken } from "@/lib/product-members";
import { chandlerBaseUrl } from "@/lib/env";
import { getSessionUser } from "@/lib/session";

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
  const invitation = token ? await resolveInvitation(token) : null;
  if (!invitation) {
    return <InviteNotice title="邀请链接无效或已过期"><p>请联系工作区所有者重新发送邀请链接。</p><Link className="primary-button" href="/">返回 CoDelphi</Link></InviteNotice>;
  }

  const targetLabel = invitation.kind === "product" ? `产品「${invitation.targetName}」` : `工作区「${invitation.targetName}」`;
  const user = await getSessionUser();
  if (!user) {
    const next = `/invitations/accept?token=${encodeURIComponent(token)}`;
    return <InviteNotice title="接受邀请">
      <p>你被邀请加入 <strong>{targetLabel}</strong>，角色为 <strong>{invitation.role}</strong>。请使用 {invitation.email} 对应的 Chandler 账号继续。</p>
      <p><Link className="primary-button" href={`/auth/login?next=${encodeURIComponent(next)}`}>已有 Chandler 账号，登录并接受邀请</Link></p>
      <p><a className="secondary-button" href={`${chandlerBaseUrl()}/user/register?next=${encodeURIComponent(invitationUrl(token))}`}>没有 Chandler 账号？注册后接受邀请</a></p>
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
      ? `此邀请仅接受 ${invitation.email} 对应的账号。请退出当前账号后重新登录。`
      : "无法接受邀请，请重新打开链接或联系工作区所有者。";
    const next = `/invitations/accept?token=${encodeURIComponent(token)}`;
    return <InviteNotice title="无法接受邀请"><p>{message}</p><Link className="primary-button" href={`/auth/login?next=${encodeURIComponent(next)}`}>重新登录</Link></InviteNotice>;
  }
}
