import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ProductGrid, ReleaseTimeline, type DashboardProduct, type DashboardRelease } from "@/components/dashboard-lists";
import { getDb } from "@/lib/db";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user);
  const db = getDb();
  const PRODUCT_VISIBILITY = `p.organization_id = ? OR p.id IN (
    SELECT pm.product_id FROM product_members pm JOIN users u ON u.id = pm.user_id WHERE u.chandler_sub = ?
  )`;
  const [productRows] = await db.execute(
    `SELECT p.id, p.slug, p.name, p.description,
            latest_run.status AS analysisStatus,
            (SELECT COUNT(*) FROM features f WHERE f.product_id = p.id AND f.active = 1) AS featureCount,
            (SELECT COUNT(*) FROM releases r WHERE r.product_id = p.id) AS releaseCount,
            (SELECT MAX(r.committed_at) FROM releases r WHERE r.product_id = p.id) AS lastRelease
     FROM products p
     LEFT JOIN analysis_runs latest_run ON latest_run.id = (
       SELECT r.id FROM analysis_runs r JOIN repositories repo ON repo.id = r.repository_id
       WHERE repo.product_id = p.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1
     )
     WHERE ${PRODUCT_VISIBILITY} ORDER BY p.name`,
    [organization.id, user.sub],
  );
  const products = productRows as DashboardProduct[];
  const [releaseRows] = await db.execute(
    `SELECT r.id, r.title, r.summary, r.committed_at AS committedAt,
            p.name AS productName, p.slug AS productSlug
     FROM releases r JOIN products p ON p.id = r.product_id
     WHERE ${PRODUCT_VISIBILITY} ORDER BY r.committed_at DESC LIMIT 8`,
    [organization.id, user.sub],
  );
  const releases = releaseRows as DashboardRelease[];
  const featureTotal = products.reduce((sum, product) => sum + Number(product.featureCount), 0);
  const releaseTotal = products.reduce((sum, product) => sum + Number(product.releaseCount), 0);

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading">
        <div><span className="eyebrow">YOUR PRODUCT PULSE</span><h1>产品总览</h1><p>所有产品的当前规格与最新变化，集中在这里。</p></div>
        <div className="page-actions"><span className="date-chip">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</span><Link href="/products/new" className="primary-button">＋ 添加产品</Link></div>
      </div>
      <section className="stats-grid" aria-label="产品统计">
        <div className="stat-card"><span>已接入产品</span><strong>{products.length}</strong><small>个独立产品空间</small></div>
        <div className="stat-card"><span>活跃功能</span><strong>{featureTotal}</strong><small>个可追溯功能</small></div>
        <div className="stat-card"><span>已分析发布</span><strong>{releaseTotal}</strong><small>次代码发布</small></div>
      </section>
      <section className="section-block">
        <div className="section-heading"><h2>产品空间</h2><span>{products.length} 个产品</span></div>
        <ProductGrid products={products} />
      </section>
      <section className="section-block">
        <div className="section-heading"><h2>最近变化</h2><span>按发布时间排序</span></div>
        <ReleaseTimeline releases={releases} />
      </section>
    </AppShell>
  );
}
