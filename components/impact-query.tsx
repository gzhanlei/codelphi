"use client";

import { useState } from "react";
import { featureHref } from "@/lib/spec-editor-ui";
import { errorMessage } from "@/lib/error-message";

export interface ImpactFeatureImpact {
  featureId: number;
  feature: string;
  scenarios: Array<{ reference: string | null; evidencePath: string }>;
}

/** 查询结果为纯渲染（SSR 可测）；交互状态由外层 SpecImpactQuery 持有。 */
export function ImpactResult({ slug, affected }: { slug: string; affected: ImpactFeatureImpact[] }) {
  if (affected.length === 0) {
    return <p className="impact-hint">这些文件没有命中任何规格场景——可能是新能力，也可能与用户可见行为无关。</p>;
  }
  return (
    <div className="impact-result">
      {affected.map((impact) => (
        <div className="impact-feature" key={impact.featureId}>
          <a className="impact-feature-name" href={`/products/${slug}${featureHref(impact.featureId)}`}>{impact.feature}</a>
          <ul>
            {impact.scenarios.map((scenario, index) => (
              <li key={`${scenario.reference ?? "feature"}-${index}`}>
                {scenario.reference
                  ? <><code className="impact-ref">{scenario.reference}</code> {scenario.evidencePath}</>
                  : <span>整功能受影响（证据路径命中）</span>}
              </li>
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
          aria-label="影响面查询"
          type="text"
          placeholder="改动前查影响面：输入文件路径，逗号分隔（如 components/release-card.tsx,lib/ai.ts）"
          value={files}
          onChange={(event) => setFiles(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void query(); }}
        />
        <button className="secondary-button" type="button" onClick={() => void query()} disabled={pending || files.trim() === ""}>
          {pending ? "查询中…" : "查询影响面"}
        </button>
      </div>
      {failed ? <p className="impact-hint" role="alert">影响面查询暂时不可用，请稍后重试。</p> : null}
      {affected ? <ImpactResult slug={slug} affected={affected} /> : null}
    </div>
  );
}
