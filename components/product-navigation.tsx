import Link from "next/link";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { PRODUCT_TABS, RUN_STATUS } from "@/lib/ui-strings/product";
import { AnalysisStatusRefresh } from "./analysis-status-refresh";
import { ProductChanges } from "./product-changes";
import { ProductMapView } from "./product-map-view";
import { ProductOverview } from "./product-overview";
import { ProductUseCases } from "./product-use-cases";
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

export function RunStatus({ run, locale = "zh-CN" }: { run?: { status: string; errorMessage?: string }; locale?: UiLocale }) {
  if (!run) return null;
  return <div className={`run-status ${run.status}`} role="status" aria-live="polite"><span>{pick(locale, RUN_STATUS.label)}{run.status}</span><RunError message={run.errorMessage} /><AnalysisStatusRefresh status={run.status} /></div>;
}

export function ProductTabs({ productBase, view, featureCount, releaseCount, journeyCount, noteBadge, showSettings = false, locale = "zh-CN" }: { productBase: string; view: string; featureCount: number; releaseCount: number; journeyCount?: number; noteBadge?: string; showSettings?: boolean; locale?: UiLocale }) {
  return (
    <nav className="view-tabs" aria-label={pick(locale, PRODUCT_TABS.aria)}>
      <Link className={selectedClass(view === "overview")} href={productBase}>{pick(locale, PRODUCT_TABS.overview)}</Link>
      {/* 使用场景始终展示（含未生成的真实空态），不因数据为空被隐藏（入口偏好）；有旅程时带计数。 */}
      <Link className={selectedClass(view === "journeys")} href={`${productBase}?view=journeys`}>{pick(locale, PRODUCT_TABS.journeys)}{journeyCount ? <span>{journeyCount}</span> : null}</Link>
      {/* 产品地图始终展示（含 0 功能空态），不因数据为空被隐藏（入口偏好）。 */}
      <Link className={selectedClass(view === "map")} href={`${productBase}?view=map`}>{pick(locale, PRODUCT_TABS.map)}</Link>
      <Link className={selectedClass(view === "spec")} href={`${productBase}?view=spec`}>{pick(locale, PRODUCT_TABS.spec)} <span>{featureCount}</span></Link>
      {releaseCount > 0 ? <Link className={selectedClass(view === "notes")} href={`${productBase}?view=notes`}>{pick(locale, PRODUCT_TABS.notes)}{noteBadge ? <span className="notes-badge">{noteBadge}</span> : null}</Link> : null}
      <Link className={selectedClass(view === "changes")} href={`${productBase}?view=changes`}>{pick(locale, PRODUCT_TABS.changes)} <span>{releaseCount}</span></Link>
      {showSettings ? <Link className={selectedClass(view === "settings")} href={`${productBase}?view=settings`}>{pick(locale, PRODUCT_TABS.settings)}</Link> : null}
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
  reviewedChanges?: ChangeRow[];
  behaviorChanges: BehaviorChangeRow[];
  foldedChanges?: FoldedBehaviorChangeRow[];
  regressionTasks?: RegressionTaskView[];
  releaseTotal?: number;
  coverage?: CoverageReceiptRow | null;
  completeness?: CompletenessLedgerRow | null;
  featureFlows?: Map<string, FeatureFlowGraph>;
  featureFlowErrors?: Map<string, string>;
  mode?: string;
  featureId?: number;
  overview: ProductOverviewData;
  canEdit?: boolean;
  /** 公开变更日志聚合页（仅公开 demo 产品展示入口）。 */
  changelogHref?: string;
  /** 最新发布的 id（发布稿视图用；无发布时不显示该 Tab）。 */
  latestReleaseId?: number;
  /** 界面语言：由服务端页面传入；客户端孙组件再经 props 下传（缺省 zh-CN 保持存量渲染）。 */
  locale?: UiLocale;
}

function ProductWorkspace({ view, productSlug, productBase, features, scenarios, releases, changes, reviewedChanges, behaviorChanges, foldedChanges, regressionTasks, releaseTotal, coverage, completeness, featureFlows, featureFlowErrors, mode = "spec", featureId, canEdit, changelogHref, locale = "zh-CN" }: Omit<ProductViewProps, "overview">) {
  const selectedFeature = selectFeature(features, featureId);
  return view === "spec"
    ? <SpecWorkspace slug={productSlug} productBase={productBase} tree={buildFeatureTree(features)} feature={selectedFeature} scenarios={scenarios} mode={mode} coverage={coverage} completeness={completeness} featureFlows={featureFlows} featureFlowErrors={featureFlowErrors} locale={locale} />
    : <ProductChanges slug={productSlug} releases={releases} changes={changes} reviewedChanges={reviewedChanges} behaviorChanges={behaviorChanges} foldedChanges={foldedChanges} regressionTasks={regressionTasks} releaseTotal={releaseTotal} canEdit={canEdit} changelogHref={changelogHref} locale={locale} />;
}

export function ProductView(props: ProductViewProps) {
  if (props.view === "overview") return <ProductOverview data={props.overview} canEdit={props.canEdit} locale={props.locale} />;
  // 使用场景视图：理解层投影由 buildProductOverview 一并算好（总览精简卡与这里共用一次解析）。
  if (props.view === "journeys") return <ProductUseCases presentation={props.overview.presentation} hasFeatures={props.features.length > 0} canEdit={Boolean(props.canEdit)} locale={props.locale} />;
  if (props.view === "map") return <ProductMapView features={props.features} scenarios={props.scenarios} />;
  if (props.view === "notes") {
    return props.latestReleaseId ? <ReleaseNotesView slug={props.productSlug} releaseId={props.latestReleaseId} canEdit={Boolean(props.canEdit)} changelogHref={props.changelogHref} locale={props.locale} /> : <p className="overview-note">{pick(props.locale ?? "zh-CN", PRODUCT_TABS.noReleases)}</p>;
  }
  return <ProductWorkspace {...props} />;
}
