import Link from "next/link";
import { notFound } from "next/navigation";
import { AnalyzeButton } from "@/components/analyze-button";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/lib/db";
import { requireSessionUser } from "@/lib/session";
import type { Evidence } from "@/lib/types";

export const dynamic = "force-dynamic";

interface FeatureRow { id: number; name: string; summary: string }
interface ScenarioRow { id: number; featureId: number; reference: string; context: string; action: string; outcome: string; category: string; evidence: unknown }
interface ReleaseRow { id: number; title: string; summary: string; sha: string; url: string; committedAt: Date }
interface ChangeRow { id: number; releaseId: number; featureName: string; kind: string; description: string; userImpact: string; evidence: unknown }

const kindLabels: Record<string, string> = { added: "新增", changed: "变化", removed: "移除", fixed: "修复", reviewed: "已检查" };
const categoryLabels: Record<string, string> = { happy: "正常路径", edge: "边界情况", error: "错误路径" };

function evidenceItems(value: unknown): Evidence[] {
  if (Array.isArray(value)) return value as Evidence[];
  if (typeof value === "string") {
    try { return JSON.parse(value) as Evidence[]; } catch { return []; }
  }
  return [];
}

function EvidenceLinks({ value }: { value: unknown }) {
  const items = evidenceItems(value);
  if (items.length === 0) return null;
  return <div className="evidence-list">{items.map((item, index) => item.url ? <a href={item.url} target="_blank" rel="noreferrer" key={`${item.path}-${index}`}>{item.path}{item.startLine ? `:${item.startLine}` : ""} ↗</a> : <code key={`${item.path}-${index}`}>{item.path}{item.startLine ? `:${item.startLine}` : ""}</code>)}</div>;
}

export default async function ProductPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ view?: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await params;
  const { view = "spec" } = await searchParams;
  const db = getDb();
  const [products] = await db.execute("SELECT id, slug, name, description FROM products WHERE slug = ?", [slug]);
  const product = (products as Array<{ id: number; slug: string; name: string; description: string }>)[0];
  if (!product) notFound();

  const [repositories] = await db.execute("SELECT owner, name, default_branch AS defaultBranch FROM repositories WHERE product_id = ?", [product.id]);
  const repository = (repositories as Array<{ owner: string; name: string; defaultBranch: string }>)[0];
  const [runs] = await db.execute(
    `SELECT r.status, r.error_message AS errorMessage FROM analysis_runs r
     JOIN repositories repo ON repo.id = r.repository_id WHERE repo.product_id = ? ORDER BY r.created_at DESC LIMIT 1`,
    [product.id],
  );
  const latestRun = (runs as Array<{ status: string; errorMessage?: string }>)[0];

  const [featureRows] = await db.execute("SELECT id, name, summary FROM features WHERE product_id = ? AND active = 1 ORDER BY name", [product.id]);
  const features = featureRows as FeatureRow[];
  const featureIds = features.map((feature) => feature.id);
  let scenarios: ScenarioRow[] = [];
  if (featureIds.length > 0) {
    const placeholders = featureIds.map(() => "?").join(",");
    const [rows] = await db.execute(`SELECT id, feature_id AS featureId, reference, context, action, outcome, category, evidence FROM scenarios WHERE active = 1 AND feature_id IN (${placeholders}) ORDER BY reference`, featureIds);
    scenarios = rows as ScenarioRow[];
  }

  const [releaseRows] = await db.execute("SELECT id, title, summary, sha, url, committed_at AS committedAt FROM releases WHERE product_id = ? ORDER BY committed_at DESC LIMIT 30", [product.id]);
  const releases = releaseRows as ReleaseRow[];
  let changes: ChangeRow[] = [];
  if (releases.length > 0) {
    const ids = releases.map((release) => release.id);
    const placeholders = ids.map(() => "?").join(",");
    const [rows] = await db.execute(`SELECT id, release_id AS releaseId, feature_name AS featureName, kind, description, user_impact AS userImpact, evidence FROM changes WHERE release_id IN (${placeholders}) ORDER BY id`, ids);
    changes = rows as ChangeRow[];
  }

  return (
    <AppShell user={user}>
      <Link href="/" className="back-link">← 所有产品</Link>
      <div className="page-heading product-heading">
        <div><span className="eyebrow">PRODUCT SPACE</span><h1>{product.name}</h1><p>{product.description}</p>{repository && <a className="repository-link" href={`https://github.com/${repository.owner}/${repository.name}`} target="_blank" rel="noreferrer">⌁ {repository.owner}/{repository.name} · {repository.defaultBranch} ↗</a>}</div>
        <AnalyzeButton slug={product.slug} />
      </div>
      {latestRun && <div className={`run-status ${latestRun.status}`}><span>最近一次分析：{latestRun.status}</span>{latestRun.errorMessage && <p>{latestRun.errorMessage}</p>}</div>}
      <nav className="view-tabs" aria-label="产品视图">
        <Link className={view === "spec" ? "selected" : ""} href={`/products/${slug}?view=spec`}>产品规格 <span>{features.length}</span></Link>
        <Link className={view === "changes" ? "selected" : ""} href={`/products/${slug}?view=changes`}>发布变化 <span>{releases.length}</span></Link>
      </nav>

      {view === "spec" ? (
        features.length === 0 ? <div className="empty-state"><strong>还没有产品规格</strong><p>点击“立即分析”，Radar 会从当前代码生成功能与场景。</p></div> :
        <div className="feature-list">{features.map((feature) => {
          const items = scenarios.filter((scenario) => scenario.featureId === feature.id);
          return <section className="feature-card" key={feature.id}><div className="feature-header"><div><h2>{feature.name}</h2><p>{feature.summary}</p></div><span>{items.length} 个场景</span></div><div className="scenario-list">{items.map((scenario) => <article className="scenario" key={scenario.id}><div className="scenario-label"><span className={`scenario-kind ${scenario.category}`}>{categoryLabels[scenario.category]}</span><code>{scenario.reference}</code></div><dl><div><dt>情境</dt><dd>{scenario.context}</dd></div><div><dt>操作</dt><dd>{scenario.action}</dd></div><div><dt>结果</dt><dd>{scenario.outcome}</dd></div></dl><EvidenceLinks value={scenario.evidence} /></article>)}</div></section>;
        })}</div>
      ) : (
        releases.length === 0 ? <div className="empty-state"><strong>还没有发布记录</strong><p>GitHub push 或手动分析后，这里会显示产品变化。</p></div> :
        <div className="release-list">{releases.map((release) => <section className="release-card" key={release.id}><div className="release-header"><div><time>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(new Date(release.committedAt))}</time><h2>{release.title}</h2></div><a href={release.url} target="_blank" rel="noreferrer"><code>{release.sha.slice(0, 7)}</code> ↗</a></div><p className="release-summary">{release.summary}</p><div className="change-list">{changes.filter((change) => change.releaseId === release.id).map((change) => <article className="change-item" key={change.id}><span className={`change-kind ${change.kind}`}>{kindLabels[change.kind]}</span><div><span className="change-feature">{change.featureName}</span><p>{change.description}</p>{change.userImpact && <p className="user-impact">用户影响：{change.userImpact}</p>}<EvidenceLinks value={change.evidence} /></div></article>)}</div></section>)}</div>
      )}
    </AppShell>
  );
}
