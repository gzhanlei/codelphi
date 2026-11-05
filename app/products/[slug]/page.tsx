import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AnalyzeButton } from "@/components/analyze-button";
import { AnalysisFeedbackButton } from "@/components/analysis-feedback-button";
import { AppShell } from "@/components/app-shell";
import { DemoShell } from "@/components/demo-shell";
import { ProductTabs, ProductView, RepositoryLink, RunStatus } from "@/components/product-navigation";
import { RemoveProductButton } from "@/components/remove-product-button";
import { publicDemoSlugs } from "@/lib/env";
import { getProductDetails } from "@/lib/product-details";
import { featureIdFromParam } from "@/lib/spec-editor-client";
import { buildProductOverview, type ProductOverviewData } from "@/lib/product-overview";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

export const dynamic = "force-dynamic";

type ProductDetails = NonNullable<Awaited<ReturnType<typeof getProductDetails>>>;

/** 产品页主体：标题区、运行状态、视图 Tab 与视图内容；demo 与登录分支共用。 */
function ProductPageBody({ slug, view, mode, featureId, details, overview, actions, canEdit, showFeedback }: {
  slug: string;
  view: string;
  mode: string;
  featureId?: number;
  details: ProductDetails;
  overview: ProductOverviewData;
  actions: ReactNode;
  canEdit: boolean;
  showFeedback: boolean;
}) {
  return (
    <>
      <div className="page-heading product-heading">
        <div><span className="eyebrow">PRODUCT SPACE</span><h1>{details.product.name}</h1>{view === "overview" ? null : <p>{details.product.description}</p>}<RepositoryLink repository={details.repository} /></div>
        <div className="page-actions">{actions}</div>
      </div>
      <RunStatus run={details.latestRun} />
      {showFeedback && details.latestRun?.status === "failed" ? <AnalysisFeedbackButton slug={details.product.slug} /> : null}
      <ProductTabs slug={slug} view={view} featureCount={details.features.length} releaseCount={details.releases.length} />
      <ProductView view={view} productSlug={slug} features={details.features} scenarios={details.scenarios} releases={details.releases} changes={details.changes} behaviorChanges={details.behaviorChanges} mode={mode} featureId={featureId} overview={overview} canEdit={canEdit} />
    </>
  );
}

export default async function ProductPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ view?: string; mode?: string; feature?: string }> }) {
  const { slug } = await params;
  const { view = "overview", mode = "spec", feature } = await searchParams;
  const featureId = featureIdFromParam(feature);
  const user = await getSessionUser();
  const access = user ? await requireProductAccess(user, slug) : null;

  if (!user || !access) {
    if (!publicDemoSlugs().has(slug)) {
      if (!user) redirect("/login");
      notFound();
    }
    const demoDetails = await getProductDetails(slug);
    if (!demoDetails) notFound();
    const demoOverview = buildProductOverview(demoDetails);
    return (
      <DemoShell>
        <ProductPageBody slug={slug} view={view} mode={mode} featureId={featureId} details={demoDetails} overview={demoOverview} canEdit={true} showFeedback={false} actions={<AnalyzeButton slug={demoDetails.product.slug} />} />
      </DemoShell>
    );
  }

  const details = await getProductDetails(slug, access.product.organizationId);
  if (!details) notFound();
  const overview = buildProductOverview(details);

  return (
    <AppShell user={user}>
      <Link href="/" className="back-link">← 所有产品</Link>
      <ProductPageBody
        slug={slug}
        view={view}
        mode={mode}
        featureId={featureId}
        details={details}
        overview={overview}
        canEdit={access.role !== "viewer"}
        showFeedback={true}
        actions={
          <>
            <AnalyzeButton slug={details.product.slug} />
            {access.via === "organization" && access.role !== "viewer" ? <RemoveProductButton slug={details.product.slug} name={details.product.name} /> : null}
          </>
        }
      />
    </AppShell>
  );
}
