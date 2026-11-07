"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteProduct } from "@/lib/product-client";
import { errorMessage } from "@/lib/error-message";

interface RemovalControls {
  setPending: (pending: boolean) => void;
  setError: (message: string) => void;
  onRemoved: () => void;
}

export async function handleProductRemoval(slug: string, controls: RemovalControls, remove: (slug: string) => Promise<"deleted"> = deleteProduct) {
  controls.setPending(true);
  controls.setError("");
  try {
    await remove(slug);
    controls.onRemoved();
  } catch (error) {
    controls.setError(errorMessage(error, "移除产品失败"));
  } finally {
    controls.setPending(false);
  }
}

interface RemoveProductControlProps {
  name: string;
  confirming: boolean;
  pending: boolean;
  error: string;
  onStart: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RemoveProductControl(props: RemoveProductControlProps) {
  if (!props.confirming) {
    return <div className="remove-product-control"><button className="danger-button" type="button" onClick={props.onStart}>移除产品</button>{props.error ? <p className="remove-product-error" role="alert">{props.error}</p> : null}</div>;
  }
  return (
    <div className="remove-product-confirmation" role="alertdialog" aria-label={`移除 ${props.name}`}>
      <strong>移除 {props.name}？</strong>
      <p>CoDelphi 中的分析、规格和历史产物将被永久删除；GitHub 仓库和连接会保留。此操作不可撤销。</p>
      <div className="remove-product-actions">
        <button className="danger-button" type="button" onClick={props.onConfirm} disabled={props.pending}>{props.pending ? "移除中…" : "确认移除"}</button>
        <button className="secondary-button" type="button" onClick={props.onCancel} disabled={props.pending}>取消</button>
      </div>
      {props.error ? <p className="remove-product-error" role="alert">{props.error}</p> : null}
    </div>
  );
}

export function RemoveProductButton({ slug, name }: { slug: string; name: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const onRemoved = () => {
    router.replace("/");
    router.refresh();
  };
  const onConfirm = () => { void handleProductRemoval(slug, { setPending, setError, onRemoved }); };
  const onStart = () => {
    setConfirming(true);
    setError("");
  };
  const onCancel = () => {
    setConfirming(false);
    setError("");
  };
  return <RemoveProductControl name={name} confirming={confirming} pending={pending} error={error} onStart={onStart} onCancel={onCancel} onConfirm={onConfirm} />;
}
