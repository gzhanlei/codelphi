"use client";

import { useState } from "react";
import Link from "next/link";
import { errorMessage } from "@/lib/error-message";
import { useDemoGuard } from "./demo-mode";

export interface PublishFeatureOption {
  featureName: string;
  added: number;
  changed: number;
  removed: number;
}

/**
 * 「发布产品」入口（用户主动流）：总览页按钮 → 勾选功能（默认全选）→ 生成发布稿草稿
 * → 跳到发布卡校对并发布。生成是用户主动行为，不自动预生成。
 */
export function OverviewPublishButton({ slug, releaseId, releaseTitle, features }: {
  slug: string;
  releaseId: number;
  releaseTitle: string;
  features: PublishFeatureOption[];
}) {
  const guard = useDemoGuard();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const toggle = (name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const generate = async () => {
    if (guard()) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/products/${slug}/releases/${releaseId}/release-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, releaseId, features: [...selected] }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "生成发布稿失败");
      setDone(true);
    } catch (cause: unknown) {
      setError(errorMessage(cause, "生成发布稿失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <button className="primary-button" type="button" onClick={() => { if (guard()) return; setOpen(true); setError(""); }}>发布产品</button>
      {open ? (
        <dialog className="publish-dialog" open>
          <h3>发布产品 · {releaseTitle}</h3>
          <p className="overview-note">勾选本次发布要宣布的功能（默认全选），生成发布稿草稿；生成后到发布卡校对文案并发布。</p>
          {done ? (
            <div className="publish-done">
              <p>发布稿草稿已生成（{selected.size} 个功能）。</p>
              <Link className="primary-button" href="?view=notes" onClick={() => setOpen(false)}>去校对并发布 →</Link>
            </div>
          ) : features.length === 0 ? (
            <p className="overview-note">本次发布没有规格行为变化（纯文档/测试/版本号提交），无可宣布项。历史发布可在发布变化视图的发布卡里手动生成。</p>
          ) : (
            <>
              <div className="publish-features">
                {features.map((feature) => (
                  <label className="publish-feature" key={feature.featureName}>
                    <input type="checkbox" checked={selected.has(feature.featureName)} onChange={() => toggle(feature.featureName)} />
                    <span>
                      <strong>{feature.featureName}</strong>
                      <span className="publish-feature-count">新增 {feature.added} · 更新 {feature.changed} · 移除 {feature.removed}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="release-notes-actions">
                <button className="primary-button" type="button" disabled={pending || selected.size === 0} onClick={generate}>
                  {pending ? "生成中…" : `生成发布稿（已选 ${selected.size} 个功能）`}
                </button>
                <button className="secondary-button" type="button" disabled={pending} onClick={() => setOpen(false)}>取消</button>
              </div>
            </>
          )}
          {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
        </dialog>
      ) : null}
    </>
  );
}
