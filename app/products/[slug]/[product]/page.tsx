import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AnalyzeButton } from "@/components/analyze-button";
import { OverviewPublishButton } from "@/components/overview-publish-dialog";
import { ProductDescriptionLine } from "@/components/product-description-line";
import { AnalysisFeedbackButton } from "@/components/analysis-feedback-button";
import { AppShell } from "@/components/app-shell";
import { DemoShell } from "@/components/demo-shell";
import { NotificationSettings } from "@/components/notification-settings";
import { ProductIdentitySettings } from "@/components/product-identity-settings";
import { ProductMembersSettings } from "@/components/product-members-settings";
import { ProductTabs, ProductView, RepositoryLink, RunStatus } from "@/components/product-navigation";
import { PublicDemoSettings } from "@/components/public-demo-settings";
import { RemoveProductButton } from "@/components/remove-product-button";
import { RepositoryTriggerSettings } from "@/components/repository-trigger-settings";
import { listProductRepositoryTriggers } from "@/lib/analysis-trigger";
import { defaultExecute } from "@/lib/db";
import { getProductDetails } from "@/lib/product-details";
import { productBasePath } from "@/lib/product-links";
import { listProductMembers } from "@/lib/product-members";
import { resolvePublicDemoProduct } from "@/lib/public-demo";
import { featureIdFromParam } from "@/lib/spec-editor-client";
import { driftTargetFeatureId, featureHref } from "@/lib/spec-editor-ui";
import { buildProductOverview, type ProductOverviewData } from "@/lib/product-overview";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

export const dynamic = "force-dynamic";

type ProductDetails = NonNullable<Awaited<ReturnType<typeof getProductDetails>>>;

/** 产品页主体：标题区、运行状态、视图 Tab 与视图内容；demo 与登录分支共用。 */
function ProductPageBody({ productBase, view, mode, featureId, details, overview, actions, canEdit, showFeedback, showSettings, settings }: {
  productBase: string;
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
        <div>
          <span className="eyebrow">PRODUCT SPACE</span>
          <h1>{details.product.name} <RepositoryLink repository={details.repository} /></h1>
          <ProductDescriptionLine slug={details.product.slug} text={details.product.description} canEdit={canEdit} />
        </div>
        <div className="page-actions">
          {actions}
          {details.releases[0] ? <OverviewPublishButton slug={details.product.slug} releaseId={details.releases[0].id} releaseTitle={details.releases[0].title} features={overview.changeGroups.map((group) => ({ featureName: group.featureName, added: group.added, changed: group.changed, removed: group.removed }))} /> : null}
          <details className="export-details"><summary>导出 ▾</summary><div className="export-details-menu"><a href={`/api/products/${details.product.slug}/spec.json`} target="_blank" rel="noreferrer">spec.json ↗</a><a href={`/api/products/${details.product.slug}/export/tests?format=gherkin`}>Gherkin ↓</a><a href={`/api/products/${details.product.slug}/export/tests?format=markdown`}>用例 Markdown ↓</a><a href={`/api/products/${details.product.slug}/explainer`} target="_blank" rel="noreferrer">Explainer ↗</a></div></details>
        </div>
      </div>
      <RunStatus run={details.latestRun} />
      {details.driftCount > 0 ? <div className="drift-banner" role="status">⚠️ {details.driftCount} 条人工规格可能已过时（最近一次分析的行为变化触及了这些功能）。逐条「标记已核实」后标记会消除。{driftFeatureId ? <Link className="drift-banner-link" href={featureHref(driftFeatureId)}>去核实 →</Link> : null}</div> : null}
      {showFeedback && details.latestRun?.status === "failed" ? <AnalysisFeedbackButton slug={details.product.slug} /> : null}
      <ProductTabs productBase={productBase} view={view} featureCount={details.features.length} releaseCount={details.releaseTotal} noteBadge={details.latestReleaseNote?.status === "draft" ? "待校对" : details.latestReleaseNote?.status === "published" ? "✓" : undefined} showSettings={showSettings} />
      {settings}
      {/* settings 是独立视图；ProductView 对未知 view 会静默落到发布变化，这里显式排除 */}
      {view === "settings" ? null : <ProductView view={view} productSlug={details.product.slug} productBase={productBase} features={details.features} scenarios={details.scenarios} releases={details.releases} changes={details.changes} behaviorChanges={details.behaviorChanges} foldedChanges={details.foldedChanges} regressionTasks={details.regressionTasks} releaseTotal={details.releaseTotal} coverage={details.coverage} completeness={details.completeness} mode={mode} featureId={featureId} overview={overview} canEdit={canEdit} changelogHref={details.product.isPublicDemo ? `/share/changelog${productBase.replace(/^\/products/, "")}` : undefined} latestReleaseId={details.releases[0]?.id} />}
    </>
  );
}

// 路由段名约束：/products 下同级动态段必须同名（与旧一段地址共享首段名 slug），
// 故 canonical 地址 /products/{org}/{product} 的参数名为 { slug: 工作区, product: 产品 }。
export default async function ProductPage({ params, searchParams }: { params: Promise<{ slug: string; product: string }>; searchParams: Promise<{ view?: string; mode?: string; feature?: string }> }) {
  const { slug: org, product: slug } = await params;
  const rawParams = await searchParams;
  const { view = "overview", mode = "spec", feature } = await rawParams;
  const featureId = featureIdFromParam(feature);
  const user = await getSessionUser();
  // URL org 段是权威上下文：鉴权直接按该工作区解析，不依赖 cookie 停在哪个工作区。
  const access = user ? await requireProductAccess(user, slug, "viewer", defaultExecute, undefined, org) : null;

  // 产品真实工作区与 URL 不符（如产品级成员撞名）按不存在处理，不泄露存在性。
  if (access && access.organization.slug !== org) notFound();

  if (!user || !access) {
    // 公开演示：数据库开关（产品设置页可改）+ PUBLIC_DEMO_SLUGS 环境变量过渡兜底。
    const demo = await resolvePublicDemoProduct(org, slug);
    if (!demo) {
      if (!user) redirect("/login");
      notFound();
    }
    const productBase = productBasePath(demo.organizationSlug, demo.slug);
    const demoDetails = await getProductDetails(slug, demo.organizationId);
    if (!demoDetails) notFound();
    const demoOverview = buildProductOverview({ ...demoDetails, productBase });
    const demoView = view === "settings" ? "overview" : view;
    return (
      <DemoShell>
        <ProductPageBody productBase={productBase} view={demoView} mode={mode} featureId={featureId} details={demoDetails} overview={demoOverview} canEdit={true} showFeedback={false} showSettings={false} actions={<AnalyzeButton slug={demoDetails.product.slug} />} />
      </DemoShell>
    );
  }

  const productBase = productBasePath(access.organization.slug, slug);
  const details = await getProductDetails(slug, access.product.organizationId);
  if (!details) notFound();
  const overview = buildProductOverview({ ...details, productBase });
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

      <RepositoryTriggerSettings
        slug={details.product.slug}
        repos={await listProductRepositoryTriggers(details.product.id, defaultExecute)}
        canEdit={access.role !== "viewer"}
      />
    </>
  ) : null;

  return (
    <AppShell user={user} organizationName={access.organization.name}>
      <Link href="/" className="back-link">← 所有产品</Link>
      <ProductPageBody
        productBase={productBase}
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
