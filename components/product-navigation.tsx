import Link from "next/link";
import { AnalysisStatusRefresh } from "./analysis-status-refresh";
import { ProductChanges } from "./product-changes";
import { ProductOverview } from "./product-overview";
import { buildProductOverview, type ProductOverviewData } from "@/lib/product-overview";
import { SpecWorkspace } from "./spec-workspace";
import { buildFeatureTree, selectFeature } from "@/lib/feature-tree";
import { scenariosForFeature } from "@/lib/spec-editor-ui";
import type { BehaviorChangeRow, ChangeRow, FeatureRow, ReleaseRow, ScenarioRow } from "@/lib/types";
import { getCodeHostingAdapter } from "@/lib/code-hosting";

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

function tabClass(selected: boolean) {
  return selected ? "selected" : "";
}

export function ProductTabs({ slug, view, featureCount, releaseCount }: { slug: string; view: string; featureCount: number; releaseCount: number }) {
  return (
    <nav className="view-tabs" aria-label="产品视图">
      <Link className={tabClass(view === "overview")} href={`/products/${slug}`}>概览</Link>
      <Link className={tabClass(view === "spec")} href={`/products/${slug}?view=spec`}>产品规格 <span>{featureCount}</span></Link>
      <Link className={tabClass(view === "changes")} href={`/products/${slug}?view=changes`}>发布变化 <span>{releaseCount}</span></Link>
    </nav>
  );
}

interface ProductViewProps {
  view: string;
  productSlug: string;
  features: FeatureRow[];
  scenarios: ScenarioRow[];
  releases: ReleaseRow[];
  changes: ChangeRow[];
  behaviorChanges: BehaviorChangeRow[];
  mode?: string;
  featureId?: number;
  overview: ProductOverviewData;
}

function ProductWorkspace({ view, productSlug, features, scenarios, releases, changes, behaviorChanges, mode = "spec", featureId }: Omit<ProductViewProps, "overview">) {
  const selectedFeature = selectFeature(features, featureId);
  return view === "spec"
    ? <SpecWorkspace slug={productSlug} tree={buildFeatureTree(features)} feature={selectedFeature} scenarios={scenariosForFeature(scenarios, selectedFeature)} mode={mode} />
    : <ProductChanges releases={releases} changes={changes} behaviorChanges={behaviorChanges} />;
}

export function ProductView(props: ProductViewProps) {
  return props.view === "overview" ? <ProductOverview data={props.overview} /> : <ProductWorkspace {...props} />;
}
