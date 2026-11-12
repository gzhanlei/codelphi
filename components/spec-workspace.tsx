"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FeatureTreeItem } from "@/lib/feature-tree";
import type { FeatureRow, ScenarioRow } from "@/lib/types";
import { deleteConfirmedFeature } from "@/lib/spec-editor-client";
import { errorMessage } from "@/lib/error-message";
import { entityId, featureHref, scenariosForFeature, scenariosForFeatureTree } from "@/lib/spec-editor-ui";
import { coverageByteLabel, coverageFilesLabel } from "@/lib/coverage-display";
import { FeatureTree } from "./feature-tree";
import { SpecSearch } from "./spec-search";
import { SpecAsk } from "./spec-ask";
import { SpecImpactQuery } from "./impact-query";
import { useDemoGuard } from "./demo-mode";
import { FeatureEditor, SpecDetail, type FeatureEditorMode } from "./spec-workspace-content";
import type { CoverageReceiptRow } from "@/lib/analysis-coverage";
import type { CompletenessLedgerRow } from "@/lib/completeness-ledger";
import { describeLedgerOverall, formatLedgerDimensions, summarizeLedgerIssues, toLedgerDetailsView } from "@/lib/completeness-ledger-view";
import { specFeatureKey } from "@/lib/spec-diff";
import type { FeatureFlowGraph } from "@/lib/semantic-feature-flow";


export function SpecWorkspace({ slug, productBase, tree, feature, scenarios, mode, coverage, completeness, featureFlows }: { slug: string; productBase: string; tree: FeatureTreeItem[]; feature?: FeatureRow; scenarios: ScenarioRow[]; mode: string; coverage?: CoverageReceiptRow | null; completeness?: CompletenessLedgerRow | null; featureFlows?: Map<string, FeatureFlowGraph> }) {
  const router = useRouter();
  const guard = useDemoGuard();
  const [editor, setEditor] = useState<FeatureEditorMode>(null);
  const [error, setError] = useState("");
  const featureScenarios = scenariosForFeature(scenarios, feature);
  const implementationScenarios = scenariosForFeatureTree(scenarios, feature, tree);
  const featureFlow = feature ? featureFlows?.get(specFeatureKey(feature.name)) : undefined;

  async function removeFeature() {
    if (guard()) return;
    const deleted = await deleteConfirmedFeature(feature).catch((cause) => {
      setError(errorMessage(cause, "删除功能失败"));
      return false;
    });
    if (deleted) router.push("?view=spec");
  }

  // 只读 demo 下编辑面板不该打开：所有编辑入口先过 demo guard，保存时再拦一次。
  const openEditor = (mode: FeatureEditorMode) => {
    if (guard()) return;
    setEditor(mode);
  };

  return (
    <div className="spec-workspace">
      <div className="spec-disclosures">
      {completeness ? (() => {
        const details = toLedgerDetailsView(completeness.details);
        if (!details) return null;
        const overall = describeLedgerOverall(details.overall);
        // 源码覆盖的量化事实已在上面的覆盖率披露行，内联清单不重复；维度状态保留在悬浮明细
        const issues = summarizeLedgerIssues(details, coverage ? ["sourceCoverage"] : []);
        return (
          <p className={`completeness-disclosure completeness-${overall.tone}`} title={`六维度状态：${formatLedgerDimensions(details)}`}>
            分析完整性：{overall.label}
            {issues.length > 0 ? `——${issues.map((issue) => `${issue.label}${issue.state === "failed" ? "失败" : "部分"}（${issue.reason}）`).join("；")}` : ""}
            。分析成功不等于完整，完整不等于正确；结论采纳前应经人工核实。
          </p>
        );
      })() : null}
      {coverage ? (
        <p className="coverage-disclosure" title="源码装配覆盖率按本规格版本对应的完整实现面（文件字节）计算">
          {coverageByteLabel(coverage)}（{coverageFilesLabel(coverage)}，{coverage.partitionsUsed} 趟提取）
          {coverage.partitionsCapped ? "；本规格未覆盖全部实现面（提取趟数触顶），未覆盖部分不产生结论。" : ""}
          {/* R6：静态提取盲区的人工补充入口要可发现——指向数据说明页（边界声明）与页内编辑器 */}
          。运行时开关与数据依赖行为静态提取不可见（<a href="/data-notice" target="_blank" rel="noreferrer">边界说明</a>）；发现缺口请在左侧功能树进入功能页，用「编辑/新增场景」人工补充并标记核实。
        </p>
      ) : null}
      </div>
      <div className="spec-search-bar">
        <SpecSearch slug={slug} productBase={productBase} />
        <SpecImpactQuery slug={slug} productBase={productBase} />
        <SpecAsk slug={slug} productBase={productBase} />
      </div>
      <FeatureTree slug={slug} items={tree} selectedId={entityId(feature)} onCreateRoot={() => openEditor("root")} />
      <div className="spec-detail">
        <FeatureEditor slug={slug} editor={editor} feature={feature} onSaved={(id) => { setEditor(null); router.push(featureHref(id)); }} onClose={() => setEditor(null)} />
        <SpecDetail slug={slug} productBase={productBase} feature={feature} scenarios={featureScenarios} implementationScenarios={implementationScenarios} mode={mode} error={error} featureFlow={featureFlow} onEdit={() => openEditor("edit")} onDelete={removeFeature} onCreateChild={() => openEditor("child")} onCreateRoot={() => openEditor("root")} />
      </div>
    </div>
  );
}
