import Link from "next/link";
import { ProductListRefresh } from "./analysis-status-refresh";

export interface DashboardProduct {
  id: number;
  slug: string;
  name: string;
  description: string;
  featureCount: number;
  releaseCount: number;
  lastRelease?: Date;
  analysisStatus?: string | null;
  analysisRevision?: string | null;
  architectureStatus?: string | null;
  architectureRevision?: string | null;
}

export interface DashboardRelease {
  id: number;
  title: string;
  summary: string;
  committedAt: Date;
  productName: string;
  productSlug: string;
}

function hasCurrentArchitecture(product: DashboardProduct, statuses: ReadonlySet<unknown>) {
  return product.analysisRevision != null && product.architectureRevision === product.analysisRevision && statuses.has(product.architectureStatus);
}

export function isDashboardProductPending(product: DashboardProduct) {
  if (product.analysisStatus === "queued" || product.analysisStatus === "running") return true;
  if (product.analysisStatus !== "succeeded") return false;
  if (hasCurrentArchitecture(product, new Set(["accepted"]))) return false;
  return !hasCurrentArchitecture(product, new Set(["failed", "rendered"]));
}

function ProductCardContent({ product, pending }: { product: DashboardProduct; pending: boolean }) {
  return <>
    <div className="product-icon">{product.name.slice(0, 1)}</div>
    <div className="product-card-title"><h3>{product.name}</h3><span>{pending ? "…" : "↗"}</span></div>
    <p aria-live={pending ? "polite" : undefined}>{pending ? "分析中，请稍候" : product.description}</p>
    <div className="product-meta"><span>{Number(product.featureCount)} 个功能</span><span>{Number(product.releaseCount)} 次发布</span></div>
  </>;
}

export function ProductGrid({ products }: { products: DashboardProduct[] }) {
  if (products.length === 0) {
    return <div className="empty-state"><strong>还没有接入产品</strong><p>配置 MySQL 后运行 <code>npm run db:seed</code> 注册 Radar 自身。</p></div>;
  }
  return (
    <>
      <ProductListRefresh pending={products.some(isDashboardProductPending)} />
      <div className="product-grid">
        {products.map((product) => {
          const pending = isDashboardProductPending(product);
          if (pending) {
            return <article className="product-card product-card-pending" aria-disabled="true" key={product.id}><ProductCardContent product={product} pending /></article>;
          }
          return <Link href={`/products/${product.slug}`} className="product-card" key={product.id}><ProductCardContent product={product} pending={false} /></Link>;
        })}
      </div>
    </>
  );
}

export function ReleaseTimeline({ releases }: { releases: DashboardRelease[] }) {
  if (releases.length === 0) {
    return <div className="empty-state compact"><p>完成第一次代码分析后，发布变化会出现在这里。</p></div>;
  }
  return (
    <div className="timeline-list">
      {releases.map((release) => (
        <Link href={`/products/${release.productSlug}?view=changes`} className="timeline-item" key={release.id}>
          <span className="timeline-dot" />
          <div><div className="timeline-title"><span className="product-tag">{release.productName}</span><h3>{release.title}</h3></div><p>{release.summary}</p></div>
          <time>{new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(release.committedAt))}</time>
        </Link>
      ))}
    </div>
  );
}
