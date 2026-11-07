import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AnalyzeButton } from "@/components/analyze-button";
import { AnalysisFeedbackButton } from "@/components/analysis-feedback-button";
import { AppShell } from "@/components/app-shell";
import { DemoShell } from "@/components/demo-shell";
import { EditNameButton } from "@/components/edit-name-button";
import { NotificationSettings } from "@/components/notification-settings";
import { ProductTabs, ProductView, RepositoryLink, RunStatus } from "@/components/product-navigation";
import { RemoveProductButton } from "@/components/remove-product-button";
import { publicDemoSlugs } from "@/lib/env";
import { findProductByOldSlug } from "@/lib/product-rename";
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
        <div><span className="eyebrow">PRODUCT SPACE</span><h1>{details.product.name}{canEdit ? <EditNameButton slug={details.product.slug} name={details.product.name} /> : null}</h1>{view === "overview" ? null : <p>{details.product.description}</p>}<RepositoryLink repository={details.repository} /></div>
        <div className="page-actions">{actions}</div>
      </div>
      <RunStatus run={details.latestRun} />
      {details.driftCount > 0 ? <div className="drift-banner" role="status">⚠️ {details.driftCount} 条人工规格可能已过时（最近一次分析的行为变化触及了这些功能）。逐一确认并重新保存后标记会消除。</div> : null}
      {showFeedback && details.latestRun?.status === "failed" ? <AnalysisFeedbackButton slug={details.product.slug} /> : null}
      <ProductTabs slug={slug} view={view} featureCount={details.features.length} releaseCount={details.releases.length} />
      {view === "overview" && canEdit ? <NotificationSettings slug={slug} /> : null}
      <ProductView view={view} productSlug={slug} features={details.features} scenarios={details.scenarios} releases={details.releases} changes={details.changes} behaviorChanges={details.behaviorChanges} regressionStatuses={details.regressionStatuses} mode={mode} featureId={featureId} overview={overview} canEdit={canEdit} />
    </>
  );
}

export default async function ProductPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ view?: string; mode?: string; feature?: string }> }) {
  const { slug } = await params;
  const rawParams = await searchParams;
  const { view = "overview", mode = "spec", feature } = rawParams;
  const featureId = featureIdFromParam(feature);
  const user = await getSessionUser();
  const access = user ? await requireProductAccess(user, slug) : null;

  // 改名后旧 slug 的链接不 404：按历史表重定向到现地址，保留原查询参数。
  if (user && !access) {
    const relocated = await findProductByOldSlug(slug);
    if (relocated) {
      const query = new URLSearchParams(Object.entries(rawParams).filter(([, value]) => value !== undefined) as Array<[string, string]>).toString();
      redirect(`/products/${relocated.slug}${query ? `?${query}` : ""}`);
    }
  }

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
