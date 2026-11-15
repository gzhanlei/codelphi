"use client";

import { useEffect, useState } from "react";
import type { UiLocale } from "@/lib/ui-locale";
import { pick } from "@/lib/ui-locale";
import { KNOWLEDGE_HEALTH } from "@/lib/ui-strings/product";
import { formatDateIn } from "@/lib/format";
import { errorMessage } from "@/lib/error-message";
import type { KnowledgeHealthReport } from "@/lib/knowledge-health";

/** 知识健康面板（P2 第一版）：只展示事实统计——漂移、核实覆盖、回归四态、维护分布；无综合分。 */
export function KnowledgeHealthPanel({ slug, locale = "zh-CN" }: { slug: string; locale?: UiLocale }) {
  const [report, setReport] = useState<KnowledgeHealthReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/products/${slug}/knowledge-health`, { cache: "no-store" });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? pick(locale, KNOWLEDGE_HEALTH.loadFailed));
        if (!cancelled) setReport((await response.json() as { report: KnowledgeHealthReport }).report);
      } catch (cause: unknown) {
        if (!cancelled) setFailed(errorMessage(cause, pick(locale, KNOWLEDGE_HEALTH.loadFailed)));
      }
    })();
    return () => { cancelled = true; };
  }, [slug, locale]);

  if (failed) return null;
  if (!report) return null;

  const verifiedShare = report.totalItems === 0 ? 0 : Math.round((report.verifiedCount / report.totalItems) * 100);
  // 与原 toLocaleDateString("zh-CN") 同构的数字式日期（缺省 locale 渲染不变，仅随 locale 切换）
  const dateOptions = { year: "numeric", month: "numeric", day: "numeric" } as const;

  return (
    <section className="overview-panel knowledge-health-panel">
      <div className="overview-panel-heading"><h2>{pick(locale, KNOWLEDGE_HEALTH.heading)}</h2></div>
      <p>{pick(locale, KNOWLEDGE_HEALTH.intro)}</p>
      <div className="stats-grid">
        <div className="stat-card"><span>{pick(locale, KNOWLEDGE_HEALTH.staleLabel)}</span><strong>{report.staleCount}</strong><small>{pick(locale, KNOWLEDGE_HEALTH.staleUnit)}</small></div>
        <div className="stat-card"><span>{pick(locale, KNOWLEDGE_HEALTH.verifiedLabel)}</span><strong>{report.verifiedCount} / {report.totalItems}</strong><small>{pick(locale, KNOWLEDGE_HEALTH.verifiedUnit).replace("{share}", String(verifiedShare))}</small></div>
        <div className="stat-card"><span>{pick(locale, KNOWLEDGE_HEALTH.lastVerifiedLabel)}</span><strong style={{ fontSize: 15 }}>{report.latestVerifiedAt ? formatDateIn(locale, report.latestVerifiedAt, dateOptions) : "—"}</strong><small>{pick(locale, KNOWLEDGE_HEALTH.lastVerifiedUnit)}</small></div>
        <div className="stat-card"><span>{pick(locale, KNOWLEDGE_HEALTH.regressionLabel)}</span><strong>{report.regression.passed}/{report.regression.total}</strong><small>{pick(locale, KNOWLEDGE_HEALTH.regressionUnit).replace("{passed}", String(report.regression.passed)).replace("{failed}", String(report.regression.failed)).replace("{skipped}", String(report.regression.skipped)).replace("{pending}", String(report.regression.pending))}</small></div>
      </div>
      {report.staleItems.length > 0 ? (
        <div className="health-stale-list">
          <h3>{pick(locale, KNOWLEDGE_HEALTH.staleListHeading)}</h3>
          {report.staleItems.map((item, index) => (
            <div className="health-stale-item" key={index}>
              <span>{item.kind === "feature" ? pick(locale, KNOWLEDGE_HEALTH.kindFeature) : pick(locale, KNOWLEDGE_HEALTH.kindScenario)} · {item.name}{item.reference ? ` · ${item.reference}` : ""}</span>
              <span className="health-stale-date">{pick(locale, KNOWLEDGE_HEALTH.staleSince).replace("{date}", formatDateIn(locale, item.staleSince, dateOptions))}</span>
            </div>
          ))}
        </div>
      ) : null}
      {report.maintenance.length > 0 ? (
        <div className="health-maintenance">
          <h3>{pick(locale, KNOWLEDGE_HEALTH.maintenanceHeading).replace("{days}", String(report.maintenanceWindowDays))}</h3>
          {report.maintenance.map((entry) => (
            <div className="health-maintenance-row" key={entry.editor}><span>{entry.editor}</span><span>{pick(locale, KNOWLEDGE_HEALTH.maintenanceEdits).replace("{count}", String(entry.edits))}</span></div>
          ))}
          {report.unattributedEdits > 0 ? <p className="overview-note">{pick(locale, KNOWLEDGE_HEALTH.maintenanceUnattributed).replace("{count}", String(report.unattributedEdits))}</p> : null}
          <p className="overview-note">{pick(locale, KNOWLEDGE_HEALTH.maintenanceDisclaimer)}</p>
        </div>
      ) : null}
    </section>
  );
}
