"use client";

import { useEffect, useState } from "react";
import type { FeatureHistoryEntry } from "@/lib/feature-history";
import { errorMessage } from "@/lib/error-message";

const kindLabels: Record<string, string> = { added: "新增", changed: "更新", removed: "移除" };

/** 功能行为变迁史（CTO 复盘视图）：按发布分组时间倒序，每条变化可回溯发布与证据语义。 */
export function FeatureHistory({ slug, featureId, featureName }: { slug: string; featureId: number; featureName: string }) {
  const [history, setHistory] = useState<FeatureHistoryEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/products/${slug}/features/${featureId}/history`, { cache: "no-store" });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "加载变迁史失败");
        if (!cancelled) setHistory((await response.json() as { history: FeatureHistoryEntry[] }).history);
      } catch (cause: unknown) {
        if (!cancelled) setError(errorMessage(cause, "加载变迁史失败"));
      }
    })();
    return () => { cancelled = true; };
  }, [slug, featureId]);

  if (error) return <p className="overview-note" role="alert">行为变迁史加载失败：{error}</p>;
  if (history === null) return null;

  return (
    <details className="feature-history">
      <summary>行为变迁史 · 最近 {history.length} 个发布{history.length === 0 ? "（无行为变化记录）" : ""}</summary>
      {history.length === 0 ? <p className="overview-note">「{featureName}」自分析以来没有行为级变化记录。</p> : history.map((entry) => (
        <div className="feature-history-release" key={entry.releaseId}>
          <div className="feature-history-head">
            {entry.url ? <a href={entry.url} target="_blank" rel="noreferrer"><code>{entry.sha.slice(0, 7)}</code> ↗</a> : <code>{entry.sha.slice(0, 7)}</code>}
            <strong>{entry.title}</strong>
            <time>{new Date(entry.committedAt).toLocaleDateString("zh-CN")}</time>
          </div>
          {entry.changes.map((change, index) => (
            <p className="feature-history-change" key={index}>
              <span className={`change-kind ${change.kind}`}>{kindLabels[change.kind] ?? change.kind}</span>
              {change.scenarioReference ? <code>{change.scenarioReference}</code> : null}
              {change.summary}
              {change.highlightType ? <span className="drift-badge" title="Highlight 分类">· {change.highlightType}</span> : null}
            </p>
          ))}
        </div>
      ))}
    </details>
  );
}
