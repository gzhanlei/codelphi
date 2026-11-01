import Link from "next/link";

export interface DashboardProduct {
  id: number;
  slug: string;
  name: string;
  description: string;
  featureCount: number;
  releaseCount: number;
  lastRelease?: Date;
}

export interface DashboardRelease {
  id: number;
  title: string;
  summary: string;
  committedAt: Date;
  productName: string;
  productSlug: string;
}

export function ProductGrid({ products }: { products: DashboardProduct[] }) {
  if (products.length === 0) {
    return <div className="empty-state"><strong>还没有接入产品</strong><p>配置 MySQL 后运行 <code>npm run db:seed</code> 注册 Radar 自身。</p></div>;
  }
  return (
    <div className="product-grid">
      {products.map((product) => (
        <Link href={`/products/${product.slug}`} className="product-card" key={product.id}>
          <div className="product-icon">{product.name.slice(0, 1)}</div>
          <div className="product-card-title"><h3>{product.name}</h3><span>↗</span></div>
          <p>{product.description}</p>
          <div className="product-meta"><span>{Number(product.featureCount)} 个功能</span><span>{Number(product.releaseCount)} 次发布</span></div>
        </Link>
      ))}
    </div>
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
