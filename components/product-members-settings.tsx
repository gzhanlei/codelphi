"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import { cancelInvitation, inviteMember, removeMember, type InvitationEntry, type MemberEntry } from "@/lib/product-client";

const roleLabels: Record<string, string> = { owner: "所有者", editor: "编辑者", viewer: "查看者" };

function MemberRow({ slug, member, canManage, onRemoved }: { slug: string; member: MemberEntry; canManage: boolean; onRemoved: (message: string) => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setPending(true);
    setError("");
    try {
      await removeMember(slug, member.userId);
      onRemoved("成员已移除");
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "移除成员失败"));
    } finally {
      setPending(false);
    }
  };
  return (
    <li className="notification-channel">
      <span className={`notification-kind ${member.role === "editor" || member.role === "owner" ? "on" : "off"}`}>{roleLabels[member.role] ?? member.role}</span>
      <code className="notification-target">{member.displayName || member.email}{member.email ? ` · ${member.email}` : ""}</code>
      {canManage ? <span className="notification-channel-actions"><button className="text-button" type="button" disabled={pending} onClick={remove}>{pending ? "…" : "移除"}</button></span> : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </li>
  );
}

/** 设置页 · 成员管理：工作区成员只读，产品级成员可移除，owner 可邀请与取消邀请。 */
export function ProductMembersSettings({ slug, organizationMembers, productMembers, invitations, canManage, canInvite }: {
  slug: string;
  organizationMembers: MemberEntry[];
  productMembers: MemberEntry[];
  invitations: InvitationEntry[];
  canManage: boolean;
  canInvite: boolean;
}) {
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
      setError("请输入邮箱");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await inviteMember(slug, { email: trimmed, role });
      if (result.status === "member_added") {
        setNotice("成员已加入。");
      } else {
        setNotice(`邀请已创建：${result.inviteUrl ?? ""}${result.emailSent ? "（Chandler 注册邮件已发送）" : "（请复制链接发送给对方）"}`);
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
      reload("邀请已取消");
    } catch (cause: unknown) {
      setError(errorMessage(cause, "取消邀请失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>03</span><h2>成员管理</h2></div>
      <p className="overview-note">工作区成员天然可以访问本产品；产品级成员仅限被单独邀请的人。</p>
      {organizationMembers.length > 0 ? (
        <>
          <p className="overview-note">工作区成员（{organizationMembers.length}）</p>
          <ul className="notification-channel-list">
            {organizationMembers.map((member) => <MemberRow key={`org-${member.userId}`} slug={slug} member={member} canManage={false} onRemoved={reload} />)}
          </ul>
        </>
      ) : null}
      <p className="overview-note">产品级成员（{productMembers.length}）</p>
      {productMembers.length > 0 ? (
        <ul className="notification-channel-list">
          {productMembers.map((member) => <MemberRow key={member.userId} slug={slug} member={member} canManage={canManage} onRemoved={reload} />)}
        </ul>
      ) : (
        <p className="empty-state">暂无产品级成员。</p>
      )}
      {invitations.length > 0 ? (
        <>
          <p className="overview-note">待接受的邀请（{invitations.length}）</p>
          <ul className="notification-channel-list">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="notification-channel">
                <span className="notification-kind off">{roleLabels[invitation.role] ?? invitation.role}</span>
                <code className="notification-target">{invitation.email}</code>
                {canManage ? <span className="notification-channel-actions"><button className="text-button" type="button" disabled={pending} onClick={() => cancel(invitation.id)}>{pending ? "…" : "取消"}</button></span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {canInvite ? (
        <form className="notification-form" onSubmit={(event) => { event.preventDefault(); void invite(); }}>
          <input aria-label="邮箱" type="email" required placeholder="partner@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
          <select aria-label="角色" value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
          </select>
          <button className="secondary-button" type="submit" disabled={pending}>{pending ? "邀请中…" : "邀请成员"}</button>
        </form>
      ) : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="form-success" role="status">{notice}</p> : null}
    </section>
  );
}
