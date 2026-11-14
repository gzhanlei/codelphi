import Link from "next/link";
import { ProductListRefresh } from "./analysis-status-refresh";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { DASHBOARD as L } from "@/lib/ui-strings/dashboard";
import { formatDateIn } from "@/lib/format";

export interface DashboardProduct {
  id: number;
  slug: string;
  organizationSlug: string;
  name: string;
  description: string;
  featureCount: number;
  releaseCount: number;
  lastRelease?: Date;
  analysisStatus?: string | null;
}

export interface DashboardRelease {
  id: number;
  title: string;
  summary: string;
  committedAt: Date;
  productName: string;
  productSlug: string;
  organizationSlug: string;
}

export function isDashboardProductPending(product: DashboardProduct) {
  return product.analysisStatus === "queued" || product.analysisStatus === "running";
}

/** 非首次接入（已有功能或发布数据）：分析中也保持入口，不让列表页卡片失去可点性。 */
export function hasDashboardProductContent(product: DashboardProduct) {
  return Number(product.featureCount) > 0 || Number(product.releaseCount) > 0;
}

/** 时间线日期：当年发布只显示月日，跨年的发布补年份（否则「11月8日」有歧义）。 */
export function timelineDate(committedAt: Date, locale: UiLocale = "zh-CN") {
  const date = new Date(committedAt);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return formatDateIn(locale, date, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

function ProductCardContent({ product, pending, locale = "zh-CN" }: { product: DashboardProduct; pending: boolean; locale?: UiLocale }) {
  const hasContent = hasDashboardProductContent(product);
  return <>
    <div className="product-icon">{product.name.slice(0, 1)}</div>
    <div className="product-card-title"><h3>{product.name}</h3><span>{pending ? "…" : "↗"}</span></div>
    <p aria-live={pending ? "polite" : undefined}>{pending ? (hasContent ? pick(locale, L.analyzingWithHistory) : pick(locale, L.analyzing)) : product.description}</p>
    <div className="product-meta"><span>{Number(product.featureCount)}{pick(locale, L.featureUnit)}</span><span>{Number(product.releaseCount)}{pick(locale, L.releaseUnit)}</span></div>
  </>;
}

export function ProductGrid({ products, locale = "zh-CN" }: { products: DashboardProduct[]; locale?: UiLocale }) {
  if (products.length === 0) {
    return <div className="empty-state"><strong>{pick(locale, L.emptyProductsTitle)}</strong><p>{pick(locale, L.emptyProductsBody)}<code>npm run db:seed</code>{pick(locale, L.emptyProductsTail)}</p></div>;
  }
  return (
    <>
      <ProductListRefresh pending={products.some(isDashboardProductPending)} />
      <div className="product-grid">
        {products.map((product) => {
          const pending = isDashboardProductPending(product);
          const card = <ProductCardContent product={product} pending={pending} locale={locale} />;
          if (!pending || hasDashboardProductContent(product)) {
            return <Link href={`/products/${product.organizationSlug}/${product.slug}`} className="product-card" key={product.id}>{card}</Link>;
          }
          // 首次接入（尚无任何功能/发布数据）：没有可看的内容，保持非链接等待卡
          return <article className="product-card product-card-pending" aria-disabled="true" key={product.id}>{card}</article>;
        })}
      </div>
    </>
  );
}

export function ReleaseTimeline({ releases, locale = "zh-CN" }: { releases: DashboardRelease[]; locale?: UiLocale }) {
  if (releases.length === 0) {
    return <div className="empty-state compact"><p>{pick(locale, L.emptyTimeline)}</p></div>;
  }
  return (
    <div className="timeline-list">
      {releases.map((release) => (
        <Link href={`/products/${release.organizationSlug}/${release.productSlug}?view=changes`} className="timeline-item" key={release.id}>
          <span className="timeline-dot" />
          <div><div className="timeline-title"><span className="product-tag">{release.productName}</span><h3>{release.title}</h3></div><p>{release.summary}</p></div>
          <time>{timelineDate(release.committedAt, locale)}</time>
        </Link>
      ))}
    </div>
  );
}
