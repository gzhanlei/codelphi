import Link from "next/link";
import { AnalysisStatusRefresh } from "./analysis-status-refresh";
import { ProductChanges } from "./product-changes";
import { ProductMapView } from "./product-map-view";
import { ProductOverview } from "./product-overview";
import { ReleaseNotesView } from "./release-notes-view";
import { buildProductOverview, type ProductOverviewData } from "@/lib/product-overview";
import { explainRunFailure } from "@/lib/run-failure-explain";
import { SpecWorkspace } from "./spec-workspace";
import { buildFeatureTree, selectFeature } from "@/lib/feature-tree";
import { selectedClass } from "@/lib/spec-editor-ui";
import type { BehaviorChangeRow, ChangeRow, FeatureRow, FoldedBehaviorChangeRow, ReleaseRow, ScenarioRow } from "@/lib/types";
import { getCodeHostingAdapter } from "@/lib/code-hosting";
import type { RegressionTaskView } from "@/lib/regression-task-view";
import type { CoverageReceiptRow } from "@/lib/analysis-coverage";
import type { CompletenessLedgerRow } from "@/lib/completeness-ledger";
import type { FeatureFlowGraph } from "@/lib/semantic-feature-flow";

interface Repository {
  provider?: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

export function RepositoryLink({ repository }: { repository?: Repository }) {
  if (!repository) return null;
  const adapter = getCodeHostingAdapter(repository.provider ?? "github");
  return <a className="repository-link" href={adapter.repositoryUrl(repository)} target="_blank" rel="noreferrer">⌁ {repository.owner}/{repository.name} · {repository.defaultBranch} ↗</a>;
}

function RunError({ message }: { message?: string }) {
  if (!message) return null;
  // 页面只给人类友好的解释（2026-11-12 用户裁决）；技术原文在 DB 与 GitHub issue。
  return <p>{explainRunFailure(message).userMessage}</p>;
}

export function RunStatus({ run }: { run?: { status: string; errorMessage?: string } }) {
  if (!run) return null;
  return <div className={`run-status ${run.status}`} role="status" aria-live="polite"><span>最近一次分析：{run.status}</span><RunError message={run.errorMessage} /><AnalysisStatusRefresh status={run.status} /></div>;
}

export function ProductTabs({ productBase, view, featureCount, releaseCount, noteBadge, showSettings = false }: { productBase: string; view: string; featureCount: number; releaseCount: number; noteBadge?: string; showSettings?: boolean }) {
  return (
    <nav className="view-tabs" aria-label="产品视图">
      <Link className={selectedClass(view === "overview")} href={productBase}>概览</Link>
      {/* 产品地图始终展示（含 0 功能空态），不因数据为空被隐藏（入口偏好）。 */}
      <Link className={selectedClass(view === "map")} href={`${productBase}?view=map`}>产品地图</Link>
      <Link className={selectedClass(view === "spec")} href={`${productBase}?view=spec`}>产品规格 <span>{featureCount}</span></Link>
      {releaseCount > 0 ? <Link className={selectedClass(view === "notes")} href={`${productBase}?view=notes`}>发布稿{noteBadge ? <span className="notes-badge">{noteBadge}</span> : null}</Link> : null}
      <Link className={selectedClass(view === "changes")} href={`${productBase}?view=changes`}>发布变化 <span>{releaseCount}</span></Link>
      {showSettings ? <Link className={selectedClass(view === "settings")} href={`${productBase}?view=settings`}>设置</Link> : null}
    </nav>
  );
}

interface ProductViewProps {
  view: string;
  /** API fetch 仍按 slug；页面链接一律用 canonical 基路径。 */
  productSlug: string;
  productBase: string;
  features: FeatureRow[];
  scenarios: ScenarioRow[];
  releases: ReleaseRow[];
  changes: ChangeRow[];
  behaviorChanges: BehaviorChangeRow[];
  foldedChanges?: FoldedBehaviorChangeRow[];
  regressionTasks?: RegressionTaskView[];
  releaseTotal?: number;
  coverage?: CoverageReceiptRow | null;
  completeness?: CompletenessLedgerRow | null;
  featureFlows?: Map<string, FeatureFlowGraph>;
  mode?: string;
  featureId?: number;
  overview: ProductOverviewData;
  canEdit?: boolean;
  /** 公开变更日志聚合页（仅公开 demo 产品展示入口）。 */
  changelogHref?: string;
  /** 最新发布的 id（发布稿视图用；无发布时不显示该 Tab）。 */
  latestReleaseId?: number;
}

function ProductWorkspace({ view, productSlug, productBase, features, scenarios, releases, changes, behaviorChanges, foldedChanges, regressionTasks, releaseTotal, coverage, completeness, featureFlows, mode = "spec", featureId, canEdit, changelogHref }: Omit<ProductViewProps, "overview">) {
  const selectedFeature = selectFeature(features, featureId);
  return view === "spec"
    ? <SpecWorkspace slug={productSlug} productBase={productBase} tree={buildFeatureTree(features)} feature={selectedFeature} scenarios={scenarios} mode={mode} coverage={coverage} completeness={completeness} featureFlows={featureFlows} />
    : <ProductChanges slug={productSlug} releases={releases} changes={changes} behaviorChanges={behaviorChanges} foldedChanges={foldedChanges} regressionTasks={regressionTasks} releaseTotal={releaseTotal} canEdit={canEdit} changelogHref={changelogHref} />;
}

export function ProductView(props: ProductViewProps) {
  if (props.view === "overview") return <ProductOverview data={props.overview} canEdit={props.canEdit} />;
  if (props.view === "map") return <ProductMapView features={props.features} scenarios={props.scenarios} />;
  if (props.view === "notes") {
    return props.latestReleaseId ? <ReleaseNotesView slug={props.productSlug} releaseId={props.latestReleaseId} canEdit={Boolean(props.canEdit)} changelogHref={props.changelogHref} /> : <p className="overview-note">尚无发布，先生成一次分析。</p>;
  }
  return <ProductWorkspace {...props} />;
}
