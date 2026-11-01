import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/lib/db";
import { requireSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

interface ProductRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  featureCount: number;
  releaseCount: number;
  lastRelease?: Date;
}

interface ReleaseRow {
  id: number;
  title: string;
  summary: string;
  committedAt: Date;
  productName: string;
  productSlug: string;
}

export default async function DashboardPage() {
  const user = await requireSessionUser();
  const db = getDb();
  const [productRows] = await db.execute(
    `SELECT p.id, p.slug, p.name, p.description,
            (SELECT COUNT(*) FROM features f WHERE f.product_id = p.id AND f.active = 1) AS featureCount,
            (SELECT COUNT(*) FROM releases r WHERE r.product_id = p.id) AS releaseCount,
            (SELECT MAX(r.committed_at) FROM releases r WHERE r.product_id = p.id) AS lastRelease
     FROM products p ORDER BY p.name`,
  );
  const products = productRows as ProductRow[];
  const [releaseRows] = await db.execute(
    `SELECT r.id, r.title, r.summary, r.committed_at AS committedAt,
            p.name AS productName, p.slug AS productSlug
     FROM releases r JOIN products p ON p.id = r.product_id
     ORDER BY r.committed_at DESC LIMIT 8`,
  );
  const releases = releaseRows as ReleaseRow[];
  const featureTotal = products.reduce((sum, product) => sum + Number(product.featureCount), 0);
  const releaseTotal = products.reduce((sum, product) => sum + Number(product.releaseCount), 0);

  return (
    <AppShell user={user}>
      <div className="page-heading">
        <div><span className="eyebrow">YOUR PRODUCT PULSE</span><h1>产品总览</h1><p>所有产品的当前规格与最新变化，集中在这里。</p></div>
        <span className="date-chip">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</span>
      </div>
      <section className="stats-grid" aria-label="产品统计">
        <div className="stat-card"><span>已接入产品</span><strong>{products.length}</strong><small>个独立产品空间</small></div>
        <div className="stat-card"><span>活跃功能</span><strong>{featureTotal}</strong><small>个可追溯功能</small></div>
        <div className="stat-card"><span>已分析发布</span><strong>{releaseTotal}</strong><small>次代码发布</small></div>
      </section>
      <section className="section-block">
        <div className="section-heading"><h2>产品空间</h2><span>{products.length} 个产品</span></div>
        {products.length === 0 ? (
          <div className="empty-state"><strong>还没有接入产品</strong><p>配置 MySQL 后运行 <code>npm run db:seed</code> 注册 Radar 自身。</p></div>
        ) : (
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
        )}
      </section>
      <section className="section-block">
        <div className="section-heading"><h2>最近变化</h2><span>按发布时间排序</span></div>
        {releases.length === 0 ? (
          <div className="empty-state compact"><p>完成第一次代码分析后，发布变化会出现在这里。</p></div>
        ) : (
          <div className="timeline-list">
            {releases.map((release) => (
              <Link href={`/products/${release.productSlug}?view=changes`} className="timeline-item" key={release.id}>
                <span className="timeline-dot" />
                <div><div className="timeline-title"><span className="product-tag">{release.productName}</span><h3>{release.title}</h3></div><p>{release.summary}</p></div>
                <time>{new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(release.committedAt))}</time>
              </Link>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}
