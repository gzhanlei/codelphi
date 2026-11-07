"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import { setPublicDemo } from "@/lib/product-client";

/** 设置页 · 公开演示：开启后任何拿到链接的人都能匿名查看该产品全部内容。 */
export function PublicDemoSettings({ slug, enabled, canManage }: { slug: string; enabled: boolean; canManage: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  const toggle = async () => {
    setPending(true);
    setError("");
    try {
      await setPublicDemo(slug, !enabled);
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "保存公开演示设置失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>02</span><h2>公开演示</h2></div>
      <p className="overview-note">把产品作为公开 demo 分享：无需登录即可查看规格、发布与变化，所有编辑操作只作演示不保存。</p>
      <div className="notification-email-row">
        <span className={`notification-kind ${enabled ? "on" : "off"}`}>{enabled ? "公开中" : "未公开"}</span>
        <span className="notification-email-text">{enabled ? "任何人都可以匿名访问此产品页面。" : "只有登录的工作区成员可以访问。"}</span>
        <button className="text-button" type="button" disabled={pending} onClick={toggle}>
          {pending ? "…" : enabled ? "点击关闭" : "点击开启"}
        </button>
      </div>
      {enabled ? <p className="overview-note">⚠️ 开启期间，产品全部内容对公网可见，请确认不包含敏感信息。</p> : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </section>
  );
}
