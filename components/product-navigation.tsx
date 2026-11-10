import Link from "next/link";
import { AnalysisStatusRefresh } from "./analysis-status-refresh";
import { ProductChanges } from "./product-changes";
import { ProductOverview } from "./product-overview";
import { buildProductOverview, type ProductOverviewData } from "@/lib/product-overview";
import { SpecWorkspace } from "./spec-workspace";
import { buildFeatureTree, selectFeature } from "@/lib/feature-tree";
import { selectedClass } from "@/lib/spec-editor-ui";
import type { BehaviorChangeRow, ChangeRow, FeatureRow, FoldedBehaviorChangeRow, ReleaseRow, ScenarioRow } from "@/lib/types";
import { getCodeHostingAdapter } from "@/lib/code-hosting";
import type { RegressionTaskView } from "@/lib/regression-task-view";
import type { CoverageReceiptRow } from "@/lib/analysis-coverage";
import type { CompletenessLedgerRow } from "@/lib/completeness-ledger";

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
  return <p>{message}</p>;
}

export function RunStatus({ run }: { run?: { status: string; errorMessage?: string } }) {
  if (!run) return null;
  return <div className={`run-status ${run.status}`} role="status" aria-live="polite"><span>最近一次分析：{run.status}</span><RunError message={run.errorMessage} /><AnalysisStatusRefresh status={run.status} /></div>;
}

export function ProductTabs({ productBase, view, featureCount, releaseCount, showSettings = false }: { productBase: string; view: string; featureCount: number; releaseCount: number; showSettings?: boolean }) {
  return (
    <nav className="view-tabs" aria-label="产品视图">
      <Link className={selectedClass(view === "overview")} href={productBase}>概览</Link>
      <Link className={selectedClass(view === "spec")} href={`${productBase}?view=spec`}>产品规格 <span>{featureCount}</span></Link>
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
  mode?: string;
  featureId?: number;
  overview: ProductOverviewData;
  canEdit?: boolean;
}

function ProductWorkspace({ view, productSlug, productBase, features, scenarios, releases, changes, behaviorChanges, foldedChanges, regressionTasks, releaseTotal, coverage, completeness, mode = "spec", featureId, canEdit }: Omit<ProductViewProps, "overview">) {
  const selectedFeature = selectFeature(features, featureId);
  return view === "spec"
    ? <SpecWorkspace slug={productSlug} productBase={productBase} tree={buildFeatureTree(features)} feature={selectedFeature} scenarios={scenarios} mode={mode} coverage={coverage} completeness={completeness} />
    : <ProductChanges slug={productSlug} releases={releases} changes={changes} behaviorChanges={behaviorChanges} foldedChanges={foldedChanges} regressionTasks={regressionTasks} releaseTotal={releaseTotal} canEdit={canEdit} />;
}

export function ProductView(props: ProductViewProps) {
  return props.view === "overview" ? <ProductOverview data={props.overview} canEdit={props.canEdit} /> : <ProductWorkspace {...props} />;
}
