"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FeatureTreeItem } from "@/lib/feature-tree";
import type { FeatureRow, ScenarioRow } from "@/lib/types";
import { deleteConfirmedFeature } from "@/lib/spec-editor-client";
import { errorMessage } from "@/lib/error-message";
import { entityId, featureHref, scenariosForFeature, scenariosForFeatureTree } from "@/lib/spec-editor-ui";
import { coverageByteLabel, coverageExplainer, coverageFilesLabel } from "@/lib/coverage-display";
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
import { pick, type UiLocale } from "@/lib/ui-locale";
import { COVERAGE, LEDGER, SPEC_EDITOR } from "@/lib/ui-strings/product";
import type { FeatureFlowGraph } from "@/lib/semantic-feature-flow";


export function SpecWorkspace({ slug, productBase, tree, feature, scenarios, mode, coverage, completeness, featureFlows, featureFlowErrors, locale = "zh-CN" }: { slug: string; productBase: string; tree: FeatureTreeItem[]; feature?: FeatureRow; scenarios: ScenarioRow[]; mode: string; coverage?: CoverageReceiptRow | null; completeness?: CompletenessLedgerRow | null; featureFlows?: Map<string, FeatureFlowGraph>; featureFlowErrors?: Map<string, string>; locale?: UiLocale }) {
  const router = useRouter();
  const guard = useDemoGuard();
  const [editor, setEditor] = useState<FeatureEditorMode>(null);
  const [error, setError] = useState("");
  const featureScenarios = scenariosForFeature(scenarios, feature);
  const implementationScenarios = scenariosForFeatureTree(scenarios, feature, tree);
  const featureFlow = feature ? featureFlows?.get(specFeatureKey(feature.name)) : undefined;
  const featureFlowErrorCode = feature ? featureFlowErrors?.get(specFeatureKey(feature.name)) : undefined;

  async function removeFeature() {
    if (guard()) return;
    const deleted = await deleteConfirmedFeature(feature).catch((cause) => {
      setError(errorMessage(cause, pick(locale, SPEC_EDITOR.deleteFeatureError)));
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
        const overall = describeLedgerOverall(details.overall, locale);
        // 源码覆盖的量化事实已在上面的覆盖率披露行，内联清单不重复；维度状态保留在悬浮明细
        const issues = summarizeLedgerIssues(details, coverage ? ["sourceCoverage"] : [], locale);
        return (
          <p className={`completeness-disclosure completeness-${overall.tone}`} title={pick(locale, LEDGER.dimensionsTitle).replace("{states}", formatLedgerDimensions(details))}>
            {pick(locale, LEDGER.disclosurePrefix).replace("{overall}", overall.label)}
            {issues.length > 0 ? `——${issues.map((issue) => `${issue.label}${pick(locale, issue.state === "failed" ? LEDGER.stateFailed : LEDGER.statePartial)}（${issue.reason}）`).join("；")}` : ""}
            {pick(locale, LEDGER.disclosureSuffix)}
          </p>
        );
      })() : null}
      {coverage ? (
        <p className="coverage-disclosure" title={pick(locale, COVERAGE.disclosureTitle)}>
          {coverageByteLabel(coverage, locale)}（{coverageFilesLabel(coverage, locale)}，{pick(locale, COVERAGE.partitionsUnit).replace("{count}", String(coverage.partitionsUsed))}）
          {coverage.partitionsCapped ? pick(locale, COVERAGE.cappedNote) : ""}
          。{coverageExplainer(locale)}
          {/* R6：静态提取盲区的人工补充入口要可发现——指向数据说明页（边界声明）与页内编辑器 */}
          {pick(locale, COVERAGE.runtimeBlindSpotPrefix)}
          <a href="/data-notice" target="_blank" rel="noreferrer">{pick(locale, COVERAGE.boundaryLabel)}</a>
          {pick(locale, COVERAGE.runtimeBlindSpotTail)}
        </p>
      ) : null}
      </div>
      <div className="spec-search-bar">
        <SpecSearch slug={slug} productBase={productBase} />
        <SpecImpactQuery slug={slug} productBase={productBase} />
        <SpecAsk slug={slug} productBase={productBase} locale={locale} />
      </div>
      <FeatureTree slug={slug} items={tree} selectedId={entityId(feature)} onCreateRoot={() => openEditor("root")} />
      <div className="spec-detail">
        <FeatureEditor slug={slug} editor={editor} feature={feature} onSaved={(id) => { setEditor(null); router.push(featureHref(id)); }} onClose={() => setEditor(null)} />
        <SpecDetail slug={slug} productBase={productBase} feature={feature} scenarios={featureScenarios} implementationScenarios={implementationScenarios} mode={mode} error={error} featureFlow={featureFlow} featureFlowErrorCode={featureFlowErrorCode} onEdit={() => openEditor("edit")} onDelete={removeFeature} onCreateChild={() => openEditor("child")} onCreateRoot={() => openEditor("root")} locale={locale} />
      </div>
    </div>
  );
}
