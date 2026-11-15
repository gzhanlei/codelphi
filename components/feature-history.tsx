"use client";

import { useEffect, useState } from "react";
import type { UiLocale } from "@/lib/ui-locale";
import { pick } from "@/lib/ui-locale";
import { FEATURE_HISTORY } from "@/lib/ui-strings/product";
import { formatDateIn } from "@/lib/format";
import type { FeatureHistoryEntry } from "@/lib/feature-history";
import { errorMessage } from "@/lib/error-message";

const kindEntries: Record<string, typeof FEATURE_HISTORY.kindAdded> = {
  added: FEATURE_HISTORY.kindAdded,
  changed: FEATURE_HISTORY.kindChanged,
  removed: FEATURE_HISTORY.kindRemoved,
};

/** 功能行为变迁史（CTO 复盘视图）：按发布分组时间倒序，每条变化可回溯发布与证据语义。 */
export function FeatureHistory({ slug, featureId, featureName, locale = "zh-CN" }: { slug: string; featureId: number; featureName: string; locale?: UiLocale }) {
  const [history, setHistory] = useState<FeatureHistoryEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/products/${slug}/features/${featureId}/history`, { cache: "no-store" });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? pick(locale, FEATURE_HISTORY.loadFailed));
        if (!cancelled) setHistory((await response.json() as { history: FeatureHistoryEntry[] }).history);
      } catch (cause: unknown) {
        if (!cancelled) setError(errorMessage(cause, pick(locale, FEATURE_HISTORY.loadFailed)));
      }
    })();
    return () => { cancelled = true; };
  }, [slug, featureId, locale]);

  if (error) return <p className="overview-note" role="alert">{pick(locale, FEATURE_HISTORY.panelFailed).replace("{error}", error)}</p>;
  if (history === null) return null;

  return (
    <details className="feature-history">
      <summary>{pick(locale, FEATURE_HISTORY.summary).replace("{count}", String(history.length))}{history.length === 0 ? pick(locale, FEATURE_HISTORY.summaryEmpty) : ""}</summary>
      {history.length === 0 ? <p className="overview-note">{pick(locale, FEATURE_HISTORY.emptyBody).replace("{name}", featureName)}</p> : history.map((entry) => (
        <div className="feature-history-release" key={entry.releaseId}>
          <div className="feature-history-head">
            {entry.url ? <a href={entry.url} target="_blank" rel="noreferrer"><code>{entry.sha.slice(0, 7)}</code> ↗</a> : <code>{entry.sha.slice(0, 7)}</code>}
            <strong>{entry.title}</strong>
            <time>{formatDateIn(locale, entry.committedAt, { year: "numeric", month: "numeric", day: "numeric" })}</time>
          </div>
          {entry.changes.map((change, index) => (
            <p className="feature-history-change" key={index}>
              <span className={`change-kind ${change.kind}`}>{kindEntries[change.kind] ? pick(locale, kindEntries[change.kind]) : change.kind}</span>
              {change.scenarioReference ? <code>{change.scenarioReference}</code> : null}
              {change.summary}
              {change.highlightType ? <span className="drift-badge" title={pick(locale, FEATURE_HISTORY.highlightTitle)}>· {change.highlightType}</span> : null}
            </p>
          ))}
        </div>
      ))}
    </details>
  );
}
