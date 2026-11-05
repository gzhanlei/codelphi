"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import { updateDescription } from "@/lib/product-client";
import { useDemoMode } from "./demo-mode";

export function EditDescriptionButton({ slug, description }: { slug: string; description: string }) {
  const router = useRouter();
  const { demo, showNotice } = useDemoMode();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [value, setValue] = useState(description);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setValue(description); }, [description]);

  const open = () => {
    setValue(description);
    setError("");
    dialogRef.current?.showModal();
  };
  const close = () => dialogRef.current?.close();
  const save = () => {
    if (demo) {
      close();
      showNotice();
      return;
    }
    setPending(true);
    setError("");
    updateDescription(slug, value.trim()).then(() => {
      close();
      router.refresh();
    }).catch((cause: unknown) => {
      setError(errorMessage(cause, "保存产品概况失败"));
    }).finally(() => setPending(false));
  };

  return (
    <>
      <button className="edit-description-button" type="button" aria-label="编辑产品概况" title="编辑产品概况" onClick={open}>✎</button>
      <dialog className="description-dialog" ref={dialogRef} aria-label="编辑产品概况">
        <h3>编辑产品概况</h3>
        <textarea value={value} maxLength={1000} placeholder="用一两句话描述这个产品…" aria-label="产品概况内容" onChange={(event) => setValue(event.target.value)} />
        <p className="description-dialog-hint">人工编辑后自动分析不会覆盖；清空保存则由下次分析重新生成。</p>
        {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
        <div className="description-dialog-actions">
          <button className="secondary-button" type="button" onClick={close} disabled={pending}>取消</button>
          <button className="primary-button" type="button" onClick={save} disabled={pending}>{pending ? "保存中…" : "保存"}</button>
        </div>
      </dialog>
    </>
  );
}
