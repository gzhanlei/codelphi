"use client";

import { useState } from "react";
import { featureHref } from "@/lib/spec-editor-ui";
import { errorMessage } from "@/lib/error-message";

export interface ImpactScenario {
  reference: string | null;
  evidencePath: string;
  context: string | null;
  action: string | null;
  outcome: string | null;
}

export interface ImpactFeatureImpact {
  /** 工作台层 feature id（stable-links 已解析）；条目已从最新规格退役时为 null。 */
  featureId: number | null;
  feature: string;
  scenarios: ImpactScenario[];
}

function scenarioLine(scenario: ImpactScenario) {
  const behavior = [scenario.context, scenario.action, scenario.outcome].filter(Boolean).join(" → ");
  const evidence = <span className="impact-evidence">证据 {scenario.evidencePath}</span>;
  if (!scenario.reference) return <span>整个功能与该文件相关（{evidence}）</span>;
  return (
    <>
      <code className="impact-ref">{scenario.reference}</code>
      {behavior ? ` ${behavior} ` : " "}
      {evidence}
    </>
  );
}

/** 查询结果为纯渲染（SSR 可测）；交互状态由外层 SpecImpactQuery 持有。 */
export function ImpactResult({ slug, affected }: { slug: string; affected: ImpactFeatureImpact[] }) {
  if (affected.length === 0) {
    return <p className="impact-hint">这些文件没有关联到任何产品行为——可能是新能力，也可能与用户可见行为无关。</p>;
  }
  return (
    <div className="impact-result">
      {affected.map((impact) => (
        <div className="impact-feature" key={`${impact.feature}-${impact.featureId ?? "retired"}`}>
          {impact.featureId
            ? <a className="impact-feature-name" href={`/products/${slug}${featureHref(impact.featureId)}`}>{impact.feature}</a>
            : <span className="impact-feature-name">{impact.feature}</span>}
          <ul>
            {impact.scenarios.map((scenario, index) => (
              <li key={`${scenario.reference ?? "feature"}-${index}`}>{scenarioLine(scenario)}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function SpecImpactQuery({ slug }: { slug: string }) {
  const [files, setFiles] = useState("");
  const [affected, setAffected] = useState<ImpactFeatureImpact[] | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function query() {
    const paths = files.split(",").map((path) => path.trim()).filter(Boolean);
    if (paths.length === 0 || pending) return;
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/products/${slug}/impact?files=${encodeURIComponent(paths.join(","))}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`impact query failed: ${response.status}`);
      const payload = await response.json() as { affected: ImpactFeatureImpact[] };
      setAffected(payload.affected);
    } catch {
      // 与规格搜索同一原则：失败给可见反馈，不静默。
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="impact-query">
      <div className="impact-query-bar">
        <input
          aria-label="行为查询"
          type="text"
          placeholder="输入文件路径，查它们实现了哪些产品行为（逗号分隔，如 components/release-card.tsx,lib/ai.ts）"
          value={files}
          onChange={(event) => setFiles(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void query(); }}
        />
        <button className="secondary-button" type="button" onClick={() => void query()} disabled={pending || files.trim() === ""}>
          {pending ? "查询中…" : "查询行为"}
        </button>
      </div>
      {failed ? <p className="impact-hint" role="alert">查询暂时不可用，请稍后重试。</p> : null}
      {affected ? <ImpactResult slug={slug} affected={affected} /> : null}
    </div>
  );
}
