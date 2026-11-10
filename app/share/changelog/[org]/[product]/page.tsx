import Link from "next/link";
import { resolvePublicDemoProduct } from "@/lib/public-demo";
import { loadPublishedChangelog } from "@/lib/changelog";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = { added: "新增", changed: "更新", removed: "移除" };

/**
 * M11 可信 changelog 聚合页（GTM 桥面）：匿名只读，按产品聚合全部已发布发布稿。
 * 门控 = 产品公开演示开关（migration 025）；非公开产品按不存在处理（防存在性泄露）。
 * 隐私边界（R5）：展示行为变化与证据路径，不展示代码内容；链接对无仓库权限者不可达。
 */
export default async function ChangelogPage({ params }: { params: Promise<{ org: string; product: string }> }) {
  const { org, product } = await params;
  const demo = await resolvePublicDemoProduct(org, product);
  if (!demo) {
    return (
      <main className="changelog-page"><p className="overview-note">产品不存在或未开放。</p><Link href="/" className="back-link">← 返回首页</Link></main>
    );
  }
  const entries = await loadPublishedChangelog(demo.id);
  return (
    <main className="changelog-page">
      <span className="eyebrow">CHANGELOG</span>
      <h1>{demo.name} 变更日志</h1>
      <p className="changelog-note">由 CoDelphi 从规格行为变化生成，每条经过人工审核后发布；证据路径指向源码仓库，链接对无仓库权限者不可达，本页不展示代码内容。</p>
      {entries.length === 0 ? <p className="overview-note">还没有已发布的变更记录。</p> : entries.map((entry) => (
        <section className="changelog-entry" key={entry.releaseId}>
          <div className="changelog-head">
            <time>{new Date(entry.publishedAt).toLocaleDateString("zh-CN")}</time>
            <h2>{entry.releaseTitle}</h2>
            {entry.releaseUrl ? <a href={entry.releaseUrl} target="_blank" rel="noreferrer"><code>{entry.releaseSha.slice(0, 7)}</code> ↗</a> : <code>{entry.releaseSha.slice(0, 7)}</code>}
          </div>
          {entry.emphasis.trim() ? <p className="changelog-emphasis">{entry.emphasis}</p> : null}
          {entry.blocks.map((block) => (
            <div className="changelog-block" key={block.position}>
              <div className="kind">[{KIND_LABELS[block.kind] ?? block.kind}] {block.featureName}{block.scenarioReference ? ` · ${block.scenarioReference}` : ""}{block.highlightType ? ` · ${block.highlightType}` : ""}</div>
              <p>{block.summary}</p>
              {block.evidencePaths.length > 0 ? <div className="paths">{block.evidencePaths.map((path) => <span className="path" key={path}>{path}</span>)}</div> : null}
            </div>
          ))}
        </section>
      ))}
      <p className="changelog-note">本页内容由规格版本锁定，产品页可见更完整的功能规格与证据。<Link href={`/products/${org}/${product}`} className="text-button">产品页 →</Link></p>
    </main>
  );
}
