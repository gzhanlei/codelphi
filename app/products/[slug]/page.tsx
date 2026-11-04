import Link from "next/link";
import { notFound } from "next/navigation";
import { AnalyzeButton } from "@/components/analyze-button";
import { AnalysisFeedbackButton } from "@/components/analysis-feedback-button";
import { AppShell } from "@/components/app-shell";
import { ProductTabs, ProductView, RepositoryLink, RunStatus } from "@/components/product-navigation";
import { RemoveProductButton } from "@/components/remove-product-button";
import { getProductDetails } from "@/lib/product-details";
import { featureIdFromParam } from "@/lib/spec-editor-client";
import { buildProductOverview } from "@/lib/product-overview";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ view?: string; mode?: string; feature?: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user);
  const { slug } = await params;
  const { view = "overview", mode = "spec", feature } = await searchParams;
  const featureId = featureIdFromParam(feature);
  const details = await getProductDetails(slug, organization.id);
  if (!details) notFound();
  const overview = buildProductOverview(details);

  return (
    <AppShell user={user}>
      <Link href="/" className="back-link">← 所有产品</Link>
      <div className="page-heading product-heading">
        <div><span className="eyebrow">PRODUCT SPACE</span><h1>{details.product.name}</h1>{view === "overview" ? null : <p>{details.product.description}</p>}<RepositoryLink repository={details.repository} /></div>
        <div className="page-actions">
          <AnalyzeButton slug={details.product.slug} />
          {organization.role === "viewer" ? null : <RemoveProductButton slug={details.product.slug} name={details.product.name} />}
        </div>
      </div>
      <RunStatus run={details.latestRun} />
      {(details.latestRun?.status === "failed" || details.architecture?.status === "failed") ? <AnalysisFeedbackButton slug={details.product.slug} /> : null}
      <ProductTabs slug={slug} view={view} featureCount={details.features.length} releaseCount={details.releases.length} />
      <ProductView view={view} productSlug={slug} features={details.features} scenarios={details.scenarios} releases={details.releases} changes={details.changes} behaviorChanges={details.behaviorChanges} mode={mode} featureId={featureId} overview={overview} />
    </AppShell>
  );
}
