import Link from "next/link";
import { ProductChanges } from "./product-changes";
import { ProductSpec } from "./product-spec";
import type { ChangeRow, FeatureRow, ReleaseRow, ScenarioRow } from "@/lib/types";

interface Repository {
  owner: string;
  name: string;
  defaultBranch: string;
}

export function RepositoryLink({ repository }: { repository?: Repository }) {
  if (!repository) return null;
  return <a className="repository-link" href={`https://github.com/${repository.owner}/${repository.name}`} target="_blank" rel="noreferrer">⌁ {repository.owner}/{repository.name} · {repository.defaultBranch} ↗</a>;
}

function RunError({ message }: { message?: string }) {
  if (!message) return null;
  return <p>{message}</p>;
}

export function RunStatus({ run }: { run?: { status: string; errorMessage?: string } }) {
  if (!run) return null;
  return <div className={`run-status ${run.status}`}><span>最近一次分析：{run.status}</span><RunError message={run.errorMessage} /></div>;
}

function tabClass(selected: boolean) {
  return selected ? "selected" : "";
}

export function ProductTabs({ slug, view, featureCount, releaseCount }: { slug: string; view: string; featureCount: number; releaseCount: number }) {
  return (
    <nav className="view-tabs" aria-label="产品视图">
      <Link className={tabClass(view === "spec")} href={`/products/${slug}?view=spec`}>产品规格 <span>{featureCount}</span></Link>
      <Link className={tabClass(view === "changes")} href={`/products/${slug}?view=changes`}>发布变化 <span>{releaseCount}</span></Link>
    </nav>
  );
}

interface ProductViewProps {
  view: string;
  features: FeatureRow[];
  scenarios: ScenarioRow[];
  releases: ReleaseRow[];
  changes: ChangeRow[];
}

export function ProductView({ view, features, scenarios, releases, changes }: ProductViewProps) {
  return view === "spec"
    ? <ProductSpec features={features} scenarios={scenarios} />
    : <ProductChanges releases={releases} changes={changes} />;
}
