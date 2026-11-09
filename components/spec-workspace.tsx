"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FeatureTreeItem } from "@/lib/feature-tree";
import type { FeatureRow, ScenarioRow } from "@/lib/types";
import { deleteConfirmedFeature } from "@/lib/spec-editor-client";
import { errorMessage } from "@/lib/error-message";
import { entityId, featureHref, scenariosForFeature, scenariosForFeatureTree } from "@/lib/spec-editor-ui";
import { FeatureTree } from "./feature-tree";
import { SpecSearch } from "./spec-search";
import { SpecAsk } from "./spec-ask";
import { SpecImpactQuery } from "./impact-query";
import { useDemoGuard } from "./demo-mode";
import { FeatureEditor, SpecDetail, type FeatureEditorMode } from "./spec-workspace-content";
import type { CoverageReceiptRow } from "@/lib/analysis-coverage";

// W0-2 增量盲评重跑达标前，覆盖披露必须带此标注（docs/specsight-gap-improvement-plan.md §3.3）。
const W0_UNMET_NOTE = "（分片多趟验收未达标，W0-2 重跑进行中）";

export function SpecWorkspace({ slug, productBase, tree, feature, scenarios, mode, coverage }: { slug: string; productBase: string; tree: FeatureTreeItem[]; feature?: FeatureRow; scenarios: ScenarioRow[]; mode: string; coverage?: CoverageReceiptRow | null }) {
  const router = useRouter();
  const guard = useDemoGuard();
  const [editor, setEditor] = useState<FeatureEditorMode>(null);
  const [error, setError] = useState("");
  const featureScenarios = scenariosForFeature(scenarios, feature);
  const implementationScenarios = scenariosForFeatureTree(scenarios, feature, tree);

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
      {coverage ? (
        <p className="coverage-disclosure" title="证据覆盖率按本规格版本对应的完整实现面计算">
          证据覆盖率 {(coverage.coverageRatio * 100).toFixed(1)}%（装配 {coverage.implFilesAssembled}/{coverage.implFilesTotal} 个实现文件，{coverage.partitionsUsed} 趟提取）
          {coverage.partitionsCapped ? "；本规格未覆盖全部实现面（提取趟数触顶），未覆盖部分不产生结论。" : ""}
          {W0_UNMET_NOTE}
        </p>
      ) : null}
      <div className="spec-search-bar">
        <SpecSearch slug={slug} productBase={productBase} />
        <SpecImpactQuery slug={slug} productBase={productBase} />
        <SpecAsk slug={slug} productBase={productBase} />
      </div>
      <FeatureTree slug={slug} items={tree} selectedId={entityId(feature)} onCreateRoot={() => openEditor("root")} />
      <div className="spec-detail">
        <FeatureEditor slug={slug} editor={editor} feature={feature} onSaved={(id) => { setEditor(null); router.push(featureHref(id)); }} onClose={() => setEditor(null)} />
        <SpecDetail slug={slug} productBase={productBase} feature={feature} scenarios={featureScenarios} implementationScenarios={implementationScenarios} mode={mode} error={error} onEdit={() => openEditor("edit")} onDelete={removeFeature} onCreateChild={() => openEditor("child")} onCreateRoot={() => openEditor("root")} />
      </div>
    </div>
  );
}
