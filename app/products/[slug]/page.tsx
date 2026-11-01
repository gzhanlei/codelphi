import Link from "next/link";
import { notFound } from "next/navigation";
import { AnalyzeButton } from "@/components/analyze-button";
import { AppShell } from "@/components/app-shell";
import { ProductTabs, ProductView, RepositoryLink, RunStatus } from "@/components/product-navigation";
import { getProductDetails } from "@/lib/product-details";
import { featureIdFromParam } from "@/lib/spec-editor-client";
import { requireSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ view?: string; mode?: string; feature?: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await params;
  const { view = "spec", mode = "spec", feature } = await searchParams;
  const featureId = featureIdFromParam(feature);
  const details = await getProductDetails(slug);
  if (!details) notFound();

  return (
    <AppShell user={user}>
      <Link href="/" className="back-link">← 所有产品</Link>
      <div className="page-heading product-heading">
        <div><span className="eyebrow">PRODUCT SPACE</span><h1>{details.product.name}</h1><p>{details.product.description}</p><RepositoryLink repository={details.repository} /></div>
        <AnalyzeButton slug={details.product.slug} />
      </div>
      <RunStatus run={details.latestRun} />
      <ProductTabs slug={slug} view={view} featureCount={details.features.length} releaseCount={details.releases.length} />
      <ProductView view={view} productSlug={slug} features={details.features} scenarios={details.scenarios} releases={details.releases} changes={details.changes} behaviorChanges={details.behaviorChanges} mode={mode} featureId={featureId} />
    </AppShell>
  );
}
