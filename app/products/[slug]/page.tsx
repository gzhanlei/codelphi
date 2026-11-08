import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AnalyzeButton } from "@/components/analyze-button";
import { AnalysisFeedbackButton } from "@/components/analysis-feedback-button";
import { AppShell } from "@/components/app-shell";
import { DemoShell } from "@/components/demo-shell";
import { NotificationSettings } from "@/components/notification-settings";
import { ProductIdentitySettings } from "@/components/product-identity-settings";
import { ProductMembersSettings } from "@/components/product-members-settings";
import { ProductTabs, ProductView, RepositoryLink, RunStatus } from "@/components/product-navigation";
import { PublicDemoSettings } from "@/components/public-demo-settings";
import { RemoveProductButton } from "@/components/remove-product-button";
import { findProductByOldSlug } from "@/lib/product-rename";
import { getProductDetails } from "@/lib/product-details";
import { listProductMembers } from "@/lib/product-members";
import { isPublicDemo } from "@/lib/public-demo";
import { featureIdFromParam } from "@/lib/spec-editor-client";
import { driftTargetFeatureId, featureHref } from "@/lib/spec-editor-ui";
import { buildProductOverview, type ProductOverviewData } from "@/lib/product-overview";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

export const dynamic = "force-dynamic";

type ProductDetails = NonNullable<Awaited<ReturnType<typeof getProductDetails>>>;

/** 产品页主体：标题区、运行状态、视图 Tab 与视图内容；demo 与登录分支共用。 */
function ProductPageBody({ slug, view, mode, featureId, details, overview, actions, canEdit, showFeedback, showSettings, settings }: {
  slug: string;
  view: string;
  mode: string;
  featureId?: number;
  details: ProductDetails;
  overview: ProductOverviewData;
  actions: ReactNode;
  canEdit: boolean;
  showFeedback: boolean;
  showSettings: boolean;
  settings?: ReactNode;
}) {
  // 漂移横幅直达第一个待核实条目所在功能；核实在规格工作台的功能详情页完成。
  const driftFeatureId = details.driftCount > 0 ? driftTargetFeatureId(details.features, details.scenarios) : undefined;
  return (
    <>
      <div className="page-heading product-heading">
        <div><span className="eyebrow">PRODUCT SPACE</span><h1>{details.product.name}</h1>{view === "overview" ? null : <p>{details.product.description}</p>}<RepositoryLink repository={details.repository} /></div>
        <div className="page-actions">{actions}</div>
      </div>
      <RunStatus run={details.latestRun} />
      {details.driftCount > 0 ? <div className="drift-banner" role="status">⚠️ {details.driftCount} 条人工规格可能已过时（最近一次分析的行为变化触及了这些功能）。逐条「标记已核实」后标记会消除。{driftFeatureId ? <Link className="drift-banner-link" href={featureHref(driftFeatureId)}>去核实 →</Link> : null}</div> : null}
      {showFeedback && details.latestRun?.status === "failed" ? <AnalysisFeedbackButton slug={details.product.slug} /> : null}
      <ProductTabs slug={slug} view={view} featureCount={details.features.length} releaseCount={details.releaseTotal} showSettings={showSettings} />
      {settings}
      {/* settings 是独立视图；ProductView 对未知 view 会静默落到发布变化，这里显式排除 */}
      {view === "settings" ? null : <ProductView view={view} productSlug={slug} features={details.features} scenarios={details.scenarios} releases={details.releases} changes={details.changes} behaviorChanges={details.behaviorChanges} foldedChanges={details.foldedChanges} regressionTasks={details.regressionTasks} releaseTotal={details.releaseTotal} mode={mode} featureId={featureId} overview={overview} canEdit={canEdit} />}
    </>
  );
}

export default async function ProductPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ view?: string; mode?: string; feature?: string }> }) {
  const { slug } = await params;
  const rawParams = await searchParams;
  const { view = "overview", mode = "spec", feature } = await rawParams;
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
    // 公开演示：数据库开关（产品设置页可改）+ PUBLIC_DEMO_SLUGS 环境变量过渡兜底。
    if (!await isPublicDemo(slug)) {
      if (!user) redirect("/login");
      notFound();
    }
    const demoDetails = await getProductDetails(slug);
    if (!demoDetails) notFound();
    const demoOverview = buildProductOverview(demoDetails);
    const demoView = view === "settings" ? "overview" : view;
    return (
      <DemoShell>
        <ProductPageBody slug={slug} view={demoView} mode={mode} featureId={featureId} details={demoDetails} overview={demoOverview} canEdit={true} showFeedback={false} showSettings={false} actions={<AnalyzeButton slug={demoDetails.product.slug} />} />
      </DemoShell>
    );
  }

  const details = await getProductDetails(slug, access.product.organizationId);
  if (!details) notFound();
  const overview = buildProductOverview(details);
  const isOrganizationMember = access.via === "organization";
  const isOwner = isOrganizationMember && access.role === "owner";

  const settings = view === "settings" ? (
    <>
      <ProductIdentitySettings slug={details.product.slug} name={details.product.name} canEdit={access.role !== "viewer"} />
      <PublicDemoSettings slug={details.product.slug} enabled={details.product.isPublicDemo === 1} canManage={isOrganizationMember && access.role !== "viewer"} />
      <ProductMembersSettings
        slug={details.product.slug}
        {...await listProductMembers(details.product.id, access.product.organizationId)}
        canManage={isOwner}
        canInvite={isOwner}
      />

      <NotificationSettings slug={details.product.slug} canEditChannels={access.role !== "viewer"} />
    </>
  ) : null;

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
        showSettings={true}
        settings={settings}
        actions={
          <>
            <AnalyzeButton slug={details.product.slug} />
            {isOrganizationMember && access.role !== "viewer" ? <RemoveProductButton slug={details.product.slug} name={details.product.name} /> : null}
          </>
        }
      />
    </AppShell>
  );
}
