"use client";

import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/error-message";
import type { KnowledgeHealthReport } from "@/lib/knowledge-health";

/** 知识健康面板（P2 第一版）：只展示事实统计——漂移、核实覆盖、回归四态、维护分布；无综合分。 */
export function KnowledgeHealthPanel({ slug }: { slug: string }) {
  const [report, setReport] = useState<KnowledgeHealthReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/products/${slug}/knowledge-health`, { cache: "no-store" });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "加载知识健康失败");
        if (!cancelled) setReport((await response.json() as { report: KnowledgeHealthReport }).report);
      } catch (cause: unknown) {
        if (!cancelled) setFailed(errorMessage(cause, "加载知识健康失败"));
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  if (failed) return null;
  if (!report) return null;

  const verifiedShare = report.totalItems === 0 ? 0 : Math.round((report.verifiedCount / report.totalItems) * 100);

  return (
    <section className="overview-panel knowledge-health-panel">
      <div className="overview-panel-heading"><span>05</span><h2>知识健康</h2></div>
      <p>事实统计，不是健康分——每项数字都可点开追溯；采纳前应经人工核实。</p>
      <div className="stats-grid">
        <div className="stat-card"><span>待核实漂移</span><strong>{report.staleCount}</strong><small>条人工规格可能过时</small></div>
        <div className="stat-card"><span>已核实条目</span><strong>{report.verifiedCount} / {report.totalItems}</strong><small>当前版本核实覆盖约 {verifiedShare}%</small></div>
        <div className="stat-card"><span>最近一次核实</span><strong style={{ fontSize: 15 }}>{report.latestVerifiedAt ? new Date(report.latestVerifiedAt).toLocaleDateString("zh-CN") : "—"}</strong><small>核实是唯一清漂移的人工动作</small></div>
        <div className="stat-card"><span>最新发布回归</span><strong>{report.regression.passed}/{report.regression.total}</strong><small>通过 · 未通过 {report.regression.failed} · 跳过 {report.regression.skipped} · 待验证 {report.regression.pending}</small></div>
      </div>
      {report.staleItems.length > 0 ? (
        <div className="health-stale-list">
          <h3>最久未核实的漂移条目</h3>
          {report.staleItems.map((item, index) => (
            <div className="health-stale-item" key={index}>
              <span>{item.kind === "feature" ? "功能" : "场景"} · {item.name}{item.reference ? ` · ${item.reference}` : ""}</span>
              <span className="health-stale-date">自 {new Date(item.staleSince).toLocaleDateString("zh-CN")}</span>
            </div>
          ))}
        </div>
      ) : null}
      {report.maintenance.length > 0 ? (
        <div className="health-maintenance">
          <h3>近 {report.maintenanceWindowDays} 天人工编辑分布</h3>
          {report.maintenance.map((entry) => (
            <div className="health-maintenance-row" key={entry.editor}><span>{entry.editor}</span><span>{entry.edits} 次</span></div>
          ))}
          {report.unattributedEdits > 0 ? <p className="overview-note">另有 {report.unattributedEdits} 次归因前（migration 064 之前）的历史编辑未计入。</p> : null}
          <p className="overview-note">维护记录 ≠ 掌握知识：分布只反映编辑投入，不做人员能力或 Bus Factor 推断。</p>
        </div>
      ) : null}
    </section>
  );
}
