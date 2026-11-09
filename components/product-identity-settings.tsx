"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import { renameProduct } from "@/lib/product-client";

/** 设置页 · 产品标识：显示名与 slug，保存后按新地址跳转。 */
export function ProductIdentitySettings({ slug, name, canEdit }: { slug: string; name: string; canEdit: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [slugValue, setSlugValue] = useState(slug);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (!canEdit) return null;

  const save = async () => {
    const trimmedName = value.trim();
    if (!trimmedName) {
      setError("请输入产品名称");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      const trimmedSlug = slugValue.trim().toLowerCase();
      const next = await renameProduct(slug, { name: trimmedName, slug: trimmedSlug || undefined });
      if (next.slug !== slug) {
        router.push(`/products/${next.organizationSlug}/${next.slug}?view=settings`);
      } else {
        setNotice("产品信息已保存");
        router.refresh();
      }
    } catch (cause: unknown) {
      setError(errorMessage(cause, "保存产品信息失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>01</span><h2>产品标识</h2></div>
      <p className="overview-note">名称展示在导航与通知里；slug 决定访问地址，修改后旧链接会自动重定向。</p>
      <div className="settings-form">
        <label className="field"><span>产品名称</span><input value={value} maxLength={100} aria-label="产品名称" onChange={(event) => setValue(event.target.value)} /></label>
        <label className="field"><span>Slug</span><input value={slugValue} maxLength={64} aria-label="产品 Slug" onChange={(event) => setSlugValue(event.target.value)} /></label>
        <button className="secondary-button" type="button" onClick={save} disabled={pending}>{pending ? "保存中…" : "保存"}</button>
      </div>
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="form-success" role="status">{notice}</p> : null}
    </section>
  );
}
