"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { PRODUCT_IDENTITY, SETTINGS_COMMON } from "@/lib/ui-strings/workspace";
import { renameProduct } from "@/lib/product-client";

/** 设置页 · 产品标识：显示名与 slug，保存后按新地址跳转。 */
export function ProductIdentitySettings({ slug, name, canEdit, locale = "zh-CN" }: { slug: string; name: string; canEdit: boolean; locale?: UiLocale }) {
  const L = PRODUCT_IDENTITY;
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
      setError(pick(locale, L.nameRequired));
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
        setNotice(pick(locale, L.savedNotice));
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
      <div className="overview-panel-heading"><span>01</span><h2>{pick(locale, L.heading)}</h2></div>
      <p className="overview-note">{pick(locale, L.note)}</p>
      <div className="settings-form">
        <label className="field"><span>{pick(locale, L.nameLabel)}</span><input value={value} maxLength={100} aria-label={pick(locale, L.nameLabel)} onChange={(event) => setValue(event.target.value)} /></label>
        <label className="field"><span>Slug</span><input value={slugValue} maxLength={64} aria-label={pick(locale, L.slugAria)} onChange={(event) => setSlugValue(event.target.value)} /></label>
        <button className="secondary-button" type="button" onClick={save} disabled={pending}>{pending ? pick(locale, SETTINGS_COMMON.saving) : pick(locale, SETTINGS_COMMON.save)}</button>
      </div>
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="form-success" role="status">{notice}</p> : null}
    </section>
  );
}
