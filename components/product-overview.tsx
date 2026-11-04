import Link from "next/link";
import type { ProductOverviewData } from "@/lib/product-overview";

const architectureStatus: Record<string, string> = { accepted: "已通过验收", rendered: "已生成，待视觉验收", failed: "生成失败" };

function OverviewHero({ data }: { data: ProductOverviewData }) {
  return (
    <section className="overview-hero">
      <span className="eyebrow">PRODUCT OVERVIEW</span>
      <h2>{data.headline}</h2>
      <div className="overview-meta"><span>{data.freshness}</span><span>{data.analysisLabel}</span>{data.headlineSource === "generated" ? <span>代码生成 · {data.headlineEvidence.length} 个证据文件</span> : null}</div>
      <div className="overview-actions"><Link className="primary-button" href="?view=spec">查看产品规格</Link><Link className="secondary-button" href="?view=changes">查看最近变化</Link><a className="explainer-link" href={`/api/products/${data.slug}/explainer`} target="_blank" rel="noreferrer">导出 Explainer ↗</a></div>
    </section>
  );
}

function ArchitectureError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="overview-error">{message}</p>;
}

function ArchitectureLink({ architecture }: { architecture: NonNullable<ProductOverviewData["architecture"]> }) {
  if (!architecture.href) return <div className="overview-note"><span>{architectureStatus[architecture.status] || architecture.status}</span><ArchitectureError message={architecture.errorMessage} /></div>;
  return <Link className="architecture-link" href={architecture.href}>查看交互式架构图 <span>Spec v{architecture.specVersionId} · {architecture.revision.slice(0, 7)} ↗</span></Link>;
}

function ArchitecturePanel({ data }: { data: ProductOverviewData }) {
  return (
    <section className="overview-panel architecture-panel">
      <div className="overview-panel-heading"><span>01</span><h2>产品如何工作</h2></div>
      <p>从页面与 API 到代码分析、规格版本和外部服务，查看真实组件关系。</p>
      {data.architecture ? <ArchitectureLink architecture={data.architecture} /> : <p className="overview-note">尚未生成架构文档。</p>}
    </section>
  );
}

function CapabilityList({ capabilities }: { capabilities: ProductOverviewData["capabilities"] }) {
  if (capabilities.length === 0) return <p className="overview-note">尚无功能规格。</p>;
  return <div className="capability-list">{capabilities.map((feature) => <Link href={feature.href} className="capability-item" key={feature.id}><strong>{feature.name}</strong><span>{feature.scenarioCount} 个场景 · {feature.source === "manual" ? "人工维护" : "代码生成"}</span><p>{feature.summary}</p></Link>)}</div>;
}

function CapabilitiesPanel({ data }: { data: ProductOverviewData }) {
  return (
    <section className="overview-panel">
      <div className="overview-panel-heading"><span>02</span><h2>当前核心能力</h2></div>
      <p>按场景覆盖排序，点击进入现有规格工作台。</p>
      <CapabilityList capabilities={data.capabilities} />
    </section>
  );
}

function ReleaseChanges({ data }: { data: ProductOverviewData }) {
  if (data.changes.length === 0) return <p className="overview-note">本次分析未发现规格行为变化。</p>;
  return <div className="overview-change-list">{data.changes.map((change) => <div className="overview-change" key={change.id}><span className={`change-kind ${change.kind}`}>{change.kind}</span><strong>{change.featureName}{change.scenarioReference ? ` · ${change.scenarioReference}` : ""}</strong><p>{change.summary}</p></div>)}</div>;
}

function ChangesContent({ data }: { data: ProductOverviewData }) {
  if (!data.latestRelease) return <p className="overview-note">尚无发布记录。</p>;
  return <ReleaseChanges data={data} />;
}

function ChangesPanel({ data }: { data: ProductOverviewData }) {
  return (
    <section className="overview-panel">
      <div className="overview-panel-heading"><span>03</span><h2>最近改变了什么</h2></div>
      <p>优先展示确定性的行为 Diff，而不是 Commit 列表或 AI 摘要。</p>
      <ChangesContent data={data} />
      <Link className="overview-text-link" href="?view=changes">查看全部发布变化 →</Link>
    </section>
  );
}

function TrustPanel({ data }: { data: ProductOverviewData }) {
  const { trust } = data;
  return (
    <section className="overview-panel trust-panel">
      <div className="overview-panel-heading"><span>04</span><h2>规格可信度</h2></div>
      <p>所有结论都关联当前规格版本、代码证据和人工修订。</p>
      <dl className="trust-grid"><div><dt>功能 / 场景</dt><dd>{trust.featureCount} / {trust.scenarioCount}</dd></div><div><dt>人工功能 / 场景</dt><dd>{trust.manualFeatureCount} / {trust.manualScenarioCount}</dd></div><div><dt>证据文件</dt><dd>{trust.evidencePathCount}</dd></div><div><dt>规格版本</dt><dd>{trust.specVersionId === null ? "未生成" : trust.specVersionId}</dd></div></dl>
    </section>
  );
}

export function ProductOverview({ data }: { data: ProductOverviewData }) {
  return (
    <div className="product-overview">
      <OverviewHero data={data} />
      <div className="overview-grid"><ArchitecturePanel data={data} /><CapabilitiesPanel data={data} /><ChangesPanel data={data} /><TrustPanel data={data} /></div>
    </div>
  );
}
