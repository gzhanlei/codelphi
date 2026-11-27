"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";

/**
 * Task 0 审核界面（只读面）：AI 提出业务域候选，维护者逐项修改、拒绝或整体接受。
 * 候选不写数据库、不改变首页；接受只是确认归属意图，落地仍须运行迁移脚本（Task 3/4）。
 */
interface Candidate {
  name: string;
  summary: string;
  featureIds: number[];
  evidencePaths: string[];
  unknowns: Array<number | string>;
  source: "generated";
}

export function DomainCandidateReview({ slug, canEdit, ungroupedCount }: { slug: string; canEdit: boolean; ungroupedCount?: number | null }) {
  const router = useRouter();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [drafts, setDrafts] = useState<Record<number, { name: string; summary: string }>>({});
  const [rejected, setRejected] = useState<number[]>([]);
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  if (!canEdit) return null;

  const generate = async () => {
    setPending(true);
    setError("");
    setAccepted(false);
    setRejected([]);
    try {
      const response = await fetch(`/api/products/${slug}/domain-candidates`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "候选生成失败");
      if (body.error) setError(body.error);
      setCandidates(body.candidates ?? []);
      setDrafts(Object.fromEntries((body.candidates ?? []).map((candidate: Candidate, index: number) => [index, { name: candidate.name, summary: candidate.summary }])));
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "候选生成失败"));
    } finally {
      setPending(false);
    }
  };

  const draft = (index: number, fallback: Candidate) => drafts[index] ?? { name: fallback.name, summary: fallback.summary };
  const kept = candidates ? candidates.map((candidate, index) => ({ candidate, index })).filter(({ index }) => !rejected.includes(index)) : [];
  const plan = kept.map(({ candidate, index }) => ({ ...candidate, name: draft(index, candidate).name.trim() || candidate.name, summary: draft(index, candidate).summary.trim() || candidate.summary }));

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>08</span><h2>业务分组候选（AI 提案）</h2></div>
      <p className="overview-note">AI 根据本产品的说明、功能与场景提出「业务域」候选，供首页按业务价值聚合。候选仅供参考：这里不会写入数据库，也不会改变当前首页；确认后用迁移脚本落地。</p>
      {ungroupedCount !== undefined && ungroupedCount !== null ? (
        ungroupedCount > 0
          ? <p className="overview-note" style={{ fontWeight: 600 }} role="status">📌 有 {ungroupedCount} 个新功能尚未归入业务分组——push 分析产生的新功能不会自动归入任何业务域；点下方按钮重新生成候选，审核后即可把它们并入。</p>
          : <p className="overview-note" role="status">✓ 没有待归组的新功能。</p>
      ) : null}
      {candidates === null ? (
        <button className="text-button" type="button" onClick={generate} disabled={pending}>{pending ? "生成中…" : "生成业务分组候选"}</button>
      ) : (
        <>
          {candidates.length === 0 && !error ? <p className="overview-note">AI 没有产出有效候选，本产品可保持现有平铺能力卡片。</p> : null}
          {kept.map(({ candidate, index }) => {
            const value = draft(index, candidate);
            const hasUnknowns = candidate.unknowns.length > 0;
            return (
              <div key={`${candidate.name}-${index}`} className="domain-candidate" style={{ border: "1px solid var(--border, #ddd)", borderRadius: 8, padding: "10px 12px", margin: "8px 0" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input aria-label="业务域名称" value={value.name} onChange={(event) => setDrafts((prev) => ({ ...prev, [index]: { ...value, name: event.target.value } }))} style={{ flex: 1 }} />
                  <button className="text-button danger-link" type="button" onClick={() => setRejected((prev) => [...prev, index])}>拒绝</button>
                </div>
                <input aria-label="业务域概述" value={value.summary} onChange={(event) => setDrafts((prev) => ({ ...prev, [index]: { ...value, summary: event.target.value } }))} style={{ width: "100%", marginTop: 6 }} />
                <p className="overview-note">
                  归属功能 {candidate.featureIds.length} 个（{candidate.featureIds.join("、") || "无"}）
                  {candidate.evidencePaths.length > 0 ? ` · 证据 ${candidate.evidencePaths.length} 个文件` : " · 无证据文件"}
                  {` · 来源：AI 生成，未核实`}
                </p>
                {hasUnknowns ? <p className="overview-note">⚠️ 存在无法归属的引用：{candidate.unknowns.join("、")}——确认前请修正。</p> : null}
              </div>
            );
          })}
          {accepted ? (
            <>
              <p className="overview-note">✅ 已确认 {plan.length} 个候选（仅供迁移脚本使用，数据库与首页未改变）：</p>
              <pre style={{ fontSize: 12, overflow: "auto" }}>{JSON.stringify(plan, null, 2)}</pre>
            </>
          ) : (
            <div style={{ display: "flex", gap: 12 }}>
              <button className="text-button" type="button" onClick={() => setAccepted(true)} disabled={pending || kept.length === 0}>全部接受</button>
              <button className="text-button" type="button" onClick={generate} disabled={pending}>{pending ? "生成中…" : "放弃并重新生成"}</button>
            </div>
          )}
        </>
      )}
      {error ? <p className="overview-note">⚠️ {error}</p> : null}
    </section>
  );
}
