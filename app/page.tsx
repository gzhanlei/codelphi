import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ProductGrid, ReleaseTimeline, type DashboardProduct, type DashboardRelease } from "@/components/dashboard-lists";
import { getDb } from "@/lib/db";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { formatDateIn } from "@/lib/format";
import { pick } from "@/lib/ui-locale";
import { DASHBOARD } from "@/lib/ui-strings/dashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const locale = await resolveUiLocale();
  const user = await requireSessionUser();
  const organization = await requireOrganization(user);
  const db = getDb();
  const PRODUCT_VISIBILITY = `p.organization_id = ? OR p.id IN (
    SELECT pm.product_id FROM product_members pm JOIN users u ON u.id = pm.user_id WHERE u.chandler_sub = ?
  )`;
  const [productRows] = await db.execute(
    `SELECT p.id, p.slug, p.name, p.description, o.slug AS organizationSlug,
            latest_run.status AS analysisStatus,
            (SELECT COUNT(*) FROM features f WHERE f.product_id = p.id AND f.active = 1) AS featureCount,
            (SELECT COUNT(*) FROM releases r WHERE r.product_id = p.id) AS releaseCount,
            (SELECT MAX(r.committed_at) FROM releases r WHERE r.product_id = p.id) AS lastRelease
     FROM products p
     JOIN organizations o ON o.id = p.organization_id
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
            p.name AS productName, p.slug AS productSlug, o.slug AS organizationSlug
     FROM releases r JOIN products p ON p.id = r.product_id
     JOIN organizations o ON o.id = p.organization_id
     WHERE ${PRODUCT_VISIBILITY} ORDER BY r.committed_at DESC LIMIT 8`,
    [organization.id, user.sub],
  );
  const releases = releaseRows as DashboardRelease[];
  const featureTotal = products.reduce((sum, product) => sum + Number(product.featureCount), 0);
  const releaseTotal = products.reduce((sum, product) => sum + Number(product.releaseCount), 0);

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading">
        <div><span className="eyebrow">YOUR PRODUCT PULSE</span><h1>{pick(locale, DASHBOARD.heading)}</h1><p>{pick(locale, DASHBOARD.subheading)}</p></div>
        <div className="page-actions"><span className="date-chip">{formatDateIn(locale, new Date(), { month: "long", day: "numeric", weekday: "short" })}</span><Link href="/products/new" className="primary-button">{pick(locale, DASHBOARD.addProduct)}</Link></div>
      </div>
      <section className="stats-grid" aria-label={pick(locale, DASHBOARD.statsAria)}>
        <div className="stat-card"><span>{pick(locale, DASHBOARD.statProducts)}</span><strong>{products.length}</strong><small>{pick(locale, DASHBOARD.statProductsUnit)}</small></div>
        <div className="stat-card"><span>{pick(locale, DASHBOARD.statFeatures)}</span><strong>{featureTotal}</strong><small>{pick(locale, DASHBOARD.statFeaturesUnit)}</small></div>
        <div className="stat-card"><span>{pick(locale, DASHBOARD.statReleases)}</span><strong>{releaseTotal}</strong><small>{pick(locale, DASHBOARD.statReleasesUnit)}</small></div>
      </section>
      <section className="section-block">
        <div className="section-heading"><h2>{pick(locale, DASHBOARD.sectionProducts)}</h2><span>{products.length}{pick(locale, DASHBOARD.sectionProductsCount)}</span></div>
        <ProductGrid products={products} locale={locale} />
      </section>
      <section className="section-block">
        <div className="section-heading"><h2>{pick(locale, DASHBOARD.sectionChanges)}</h2><span>{pick(locale, DASHBOARD.sectionChangesNote)}</span></div>
        <ReleaseTimeline releases={releases} locale={locale} />
      </section>
    </AppShell>
  );
}
