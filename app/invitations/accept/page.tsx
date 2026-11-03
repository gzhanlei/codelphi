import Link from "next/link";
import { redirect } from "next/navigation";
import { acceptOrganizationInvitation, getInvitationByToken, invitationUrl } from "@/lib/invitation-tokens";
import { chandlerBaseUrl } from "@/lib/env";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

function InviteNotice({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="status-page"><span className="eyebrow">WORKSPACE INVITATION</span><h1>{title}</h1>{children}</main>;
}

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  let invitation;
  try {
    invitation = token ? await getInvitationByToken(token) : null;
  } catch {
    invitation = null;
  }
  if (!invitation) {
    return <InviteNotice title="邀请链接无效或已过期"><p>请联系工作区所有者重新发送邀请链接。</p><Link className="primary-button" href="/">返回 Radar</Link></InviteNotice>;
  }

  const user = await getSessionUser();
  if (!user) {
    const next = `/invitations/accept?token=${encodeURIComponent(token)}`;
    return <InviteNotice title="接受工作区邀请">
      <p>你被邀请加入 <strong>{invitation.organizationName}</strong>，角色为 <strong>{invitation.role}</strong>。请使用 {invitation.email} 对应的 Chandler 账号继续。</p>
      <p><Link className="primary-button" href={`/auth/login?next=${encodeURIComponent(next)}`}>已有 Chandler 账号，登录并接受邀请</Link></p>
      <p><a className="secondary-button" href={`${chandlerBaseUrl()}/user/register?next=${encodeURIComponent(invitationUrl(token))}`}>没有 Chandler 账号？注册后接受邀请</a></p>
    </InviteNotice>;
  }

  try {
    await acceptOrganizationInvitation(user, token);
    redirect("/organizations");
  } catch (error) {
    const message = error instanceof Error && error.message === "invitation_email_mismatch"
      ? `此邀请仅接受 ${invitation.email} 对应的账号。请退出当前账号后重新登录。`
      : "无法接受邀请，请重新打开链接或联系工作区所有者。";
    return <InviteNotice title="无法接受邀请"><p>{message}</p><Link className="primary-button" href={`/auth/login?next=${encodeURIComponent(`/invitations/accept?token=${token}`)}`}>重新登录</Link></InviteNotice>;
  }
}
