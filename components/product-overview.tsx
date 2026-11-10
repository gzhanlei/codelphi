import Link from "next/link";
import { EditDescriptionButton } from "./edit-description-button";
import { changeGroupLabel, type ProductOverviewData } from "@/lib/product-overview";

function OverviewHero({ data, canEdit }: { data: ProductOverviewData; canEdit: boolean }) {
  return (
    <section className="overview-hero">
      <span className="eyebrow">PRODUCT OVERVIEW</span>
      <h2>{data.headline}{canEdit ? <EditDescriptionButton slug={data.slug} description={data.description} /> : null}</h2>
      <div className="overview-meta"><span>{data.freshness}</span><span>{data.analysisLabel}</span>{data.headlineSource === "generated" ? <span>代码生成 · {data.headlineEvidence.length} 个证据文件</span> : null}</div>
      <div className="overview-actions"><Link className="primary-button" href="?view=spec">查看产品规格</Link><Link className="secondary-button" href="?view=changes">查看最近变化</Link><a className="explainer-link" href={`/api/products/${data.slug}/spec.json`} target="_blank" rel="noreferrer">导出 spec.json ↗</a><a className="explainer-link" href={`/api/products/${data.slug}/export/tests?format=gherkin`}>导出 Gherkin ↓</a><a className="explainer-link" href={`/api/products/${data.slug}/export/tests?format=markdown`}>导出 Markdown ↓</a><a className="explainer-link" href={`/api/products/${data.slug}/explainer`} target="_blank" rel="noreferrer">导出 Explainer ↗</a></div>
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
      <div className="overview-panel-heading"><span>01</span><h2>当前核心能力</h2></div>
      <p>按场景覆盖排序，点击进入现有规格工作台。</p>
      <CapabilityList capabilities={data.capabilities} />
    </section>
  );
}

function ReleaseChanges({ data }: { data: ProductOverviewData }) {
  const release = data.latestRelease;
  if (!release || data.changes.length === 0) return <p className="overview-note">本次分析未发现规格行为变化。</p>;
  return (
    <div className="overview-change-list">
      <div className="overview-release-head">
        <strong>{release.title}</strong>
        <span className="overview-release-meta">
          <time>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(release.committedAt))}</time>
          {release.url ? <a href={release.url} target="_blank" rel="noreferrer"><code>{release.sha.slice(0, 7)}</code> ↗</a> : <code>{release.sha.slice(0, 7)}</code>}
        </span>
      </div>
      {release.summary ? <p className="overview-release-summary">{release.summary}</p> : null}
      <p className="overview-change-stats">新增 {data.changeStats.added} · 移除 {data.changeStats.removed} · 更新 {data.changeStats.changed}</p>
      {data.changeGroups.map((group) => <div className="overview-change" key={group.featureName}><strong>{group.featureName}</strong><p>{changeGroupLabel(group)}</p></div>)}
    </div>
  );
}

function QuietRelease({ release }: { release: NonNullable<ProductOverviewData["latestRelease"]> }) {
  return (
    <div className="overview-change-list">
      <div className="overview-change">
        <strong>{release.title}</strong>
        <p>{release.summary}</p>
        <p className="overview-note">本次发布没有规格行为 Diff，详情见发布变化。</p>
      </div>
    </div>
  );
}

function ChangesContent({ data }: { data: ProductOverviewData }) {
  if (!data.latestRelease) return <p className="overview-note">尚无发布记录。</p>;
  if (data.changes.length === 0) return <QuietRelease release={data.latestRelease} />;
  return <ReleaseChanges data={data} />;
}

function ChangesPanel({ data }: { data: ProductOverviewData }) {
  return (
    <section className="overview-panel">
      <div className="overview-panel-heading"><span>02</span><h2>最近改变了什么</h2></div>
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
      <div className="overview-panel-heading"><span>03</span><h2>证据覆盖率</h2></div>
      <p>每条结论都关联规格版本、代码证据与人工修订；证据覆盖描述证据范围，不等于结论正确，采纳前应经人工核实。</p>
      <dl className="trust-grid"><div><dt>功能 / 场景</dt><dd>{trust.featureCount} / {trust.scenarioCount}</dd></div><div><dt>人工功能 / 场景</dt><dd>{trust.manualFeatureCount} / {trust.manualScenarioCount}</dd></div><div><dt>证据文件</dt><dd>{trust.evidencePathCount}</dd></div><div><dt>规格版本</dt><dd>{trust.specVersionId === null ? "未生成" : trust.specVersionId}</dd></div></dl>
    </section>
  );
}

export function ProductOverview({ data, canEdit = false }: { data: ProductOverviewData; canEdit?: boolean }) {
  return (
    <div className="product-overview">
      <OverviewHero data={data} canEdit={canEdit} />
      <div className="overview-grid"><CapabilitiesPanel data={data} /><ChangesPanel data={data} /><TrustPanel data={data} /></div>
    </div>
  );
}
