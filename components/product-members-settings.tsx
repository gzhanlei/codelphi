"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import { pick, type LocaleEntry, type UiLocale } from "@/lib/ui-locale";
import { PRODUCT_MEMBERS } from "@/lib/ui-strings/workspace";
import { cancelInvitation, inviteMember, removeMember, type InvitationEntry, type MemberEntry } from "@/lib/product-client";

const roleLabels: Record<string, LocaleEntry> = {
  owner: PRODUCT_MEMBERS.roleOwner,
  editor: PRODUCT_MEMBERS.roleEditor,
  viewer: PRODUCT_MEMBERS.roleViewer,
};

function MemberRow({ slug, member, canManage, locale, onRemoved }: { slug: string; member: MemberEntry; canManage: boolean; locale: UiLocale; onRemoved: (message: string) => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setPending(true);
    setError("");
    try {
      await removeMember(slug, member.userId);
      onRemoved(pick(locale, PRODUCT_MEMBERS.removedNotice));
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "移除成员失败"));
    } finally {
      setPending(false);
    }
  };
  return (
    <li className="notification-channel">
      <span className={`notification-kind ${member.role === "editor" || member.role === "owner" ? "on" : "off"}`}>{roleLabels[member.role] ? pick(locale, roleLabels[member.role]) : member.role}</span>
      <code className="notification-target">{member.displayName || member.email}{member.email ? ` · ${member.email}` : ""}</code>
      {canManage ? <span className="notification-channel-actions"><button className="text-button" type="button" disabled={pending} onClick={remove}>{pending ? "…" : pick(locale, PRODUCT_MEMBERS.removeButton)}</button></span> : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </li>
  );
}

/** 设置页 · 成员管理：工作区成员只读，产品级成员可移除，owner 可邀请与取消邀请。 */
export function ProductMembersSettings({ slug, organizationMembers, productMembers, invitations, canManage, canInvite, locale = "zh-CN" }: {
  slug: string;
  organizationMembers: MemberEntry[];
  productMembers: MemberEntry[];
  invitations: InvitationEntry[];
  canManage: boolean;
  canInvite: boolean;
  locale?: UiLocale;
}) {
  const L = PRODUCT_MEMBERS;
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reload = (message: string) => {
    setNotice(message);
    router.refresh();
  };

  const invite = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setError(pick(locale, L.emailRequired));
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await inviteMember(slug, { email: trimmed, role });
      if (result.status === "member_added") {
        setNotice(pick(locale, L.memberAddedNotice));
      } else {
        setNotice(`${pick(locale, L.invitedPrefix)}${result.inviteUrl ?? ""}${result.emailSent ? pick(locale, L.invitedEmailSent) : pick(locale, L.invitedEmailFallback)}`);
      }
      setEmail("");
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "邀请失败"));
    } finally {
      setPending(false);
    }
  };

  const cancel = async (invitationId: number) => {
    setPending(true);
    setError("");
    try {
      await cancelInvitation(slug, invitationId);
      reload(pick(locale, L.cancelledNotice));
    } catch (cause: unknown) {
      setError(errorMessage(cause, "取消邀请失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>03</span><h2>{pick(locale, L.heading)}</h2></div>
      <p className="overview-note">{pick(locale, L.note)}</p>
      {organizationMembers.length > 0 ? (
        <>
          <p className="overview-note">{pick(locale, L.orgMembersPrefix)}{organizationMembers.length}{pick(locale, L.countSuffix)}</p>
          <ul className="notification-channel-list">
            {organizationMembers.map((member) => <MemberRow key={`org-${member.userId}`} slug={slug} member={member} canManage={false} locale={locale} onRemoved={reload} />)}
          </ul>
        </>
      ) : null}
      <p className="overview-note">{pick(locale, L.productMembersPrefix)}{productMembers.length}{pick(locale, L.countSuffix)}</p>
      {productMembers.length > 0 ? (
        <ul className="notification-channel-list">
          {productMembers.map((member) => <MemberRow key={member.userId} slug={slug} member={member} canManage={canManage} locale={locale} onRemoved={reload} />)}
        </ul>
      ) : (
        <p className="empty-state">{pick(locale, L.noneProduct)}</p>
      )}
      {invitations.length > 0 ? (
        <>
          <p className="overview-note">{pick(locale, L.pendingPrefix)}{invitations.length}{pick(locale, L.countSuffix)}</p>
          <ul className="notification-channel-list">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="notification-channel">
                <span className="notification-kind off">{roleLabels[invitation.role] ? pick(locale, roleLabels[invitation.role]) : invitation.role}</span>
                <code className="notification-target">{invitation.email}</code>
                {canManage ? <span className="notification-channel-actions"><button className="text-button" type="button" disabled={pending} onClick={() => cancel(invitation.id)}>{pending ? "…" : pick(locale, L.cancelButton)}</button></span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {canInvite ? (
        <form className="notification-form" onSubmit={(event) => { event.preventDefault(); void invite(); }}>
          <input aria-label={pick(locale, L.emailAria)} type="email" required placeholder="partner@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
          <select aria-label={pick(locale, L.roleAria)} value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
          </select>
          <button className="secondary-button" type="submit" disabled={pending}>{pending ? pick(locale, L.inviting) : pick(locale, L.inviteButton)}</button>
        </form>
      ) : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="form-success" role="status">{notice}</p> : null}
    </section>
  );
}
