"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import { renameProduct } from "@/lib/product-client";
import { useDemoGuard } from "./demo-mode";

export function EditNameButton({ slug, name }: { slug: string; name: string }) {
  const router = useRouter();
  const guard = useDemoGuard();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [value, setValue] = useState(name);
  const [slugValue, setSlugValue] = useState(slug);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setValue(name); setSlugValue(slug); }, [name, slug]);

  const open = () => {
    setValue(name);
    setSlugValue(slug);
    setError("");
    setPending(false);
    dialogRef.current?.showModal();
  };
  const close = () => dialogRef.current?.close();
  const save = async () => {
    const trimmedName = value.trim();
    if (!trimmedName) {
      setError("请输入产品名称");
      return;
    }
    if (guard()) {
      close();
      return;
    }
    setPending(true);
    setError("");
    try {
      const trimmedSlug = slugValue.trim().toLowerCase();
      const nextSlug = await renameProduct(slug, { name: trimmedName, slug: trimmedSlug || undefined });
      close();
      if (nextSlug !== slug) {
        router.push(`/products/${nextSlug}`);
      } else {
        router.refresh();
      }
    } catch (cause: unknown) {
      setError(errorMessage(cause, "保存产品信息失败"));
      setPending(false);
    }
  };

  return (
    <>
      <button className="edit-description-button" type="button" aria-label="编辑产品名称" title="编辑产品名称" onClick={open}>✎</button>
      <dialog className="description-dialog" ref={dialogRef} aria-label="编辑产品名称">
        <h3>编辑产品名称</h3>
        <input className="name-dialog-input" value={value} maxLength={100} placeholder="产品名称" aria-label="产品名称" onChange={(event) => setValue(event.target.value)} />
        <input className="name-dialog-input" value={slugValue} maxLength={64} placeholder="slug（URL 标识，留空保持不变）" aria-label="产品 Slug" onChange={(event) => setSlugValue(event.target.value)} />
        <p className="description-dialog-hint">Slug 决定访问地址，修改后旧链接会自动重定向；若该产品配置为公开演示（PUBLIC_DEMO_SLUGS），需同步更新环境变量。</p>
        {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
        <div className="description-dialog-actions">
          <button className="secondary-button" type="button" onClick={close} disabled={pending}>取消</button>
          <button className="primary-button" type="button" onClick={save} disabled={pending}>{pending ? "保存中…" : "保存"}</button>
        </div>
      </dialog>
    </>
  );
}
