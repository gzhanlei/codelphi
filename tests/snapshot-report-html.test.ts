import { describe, expect, it } from "vitest";
import fixture from "./fixtures/snapshot-report.json";
import { renderSnapshotHtml } from "../lib/snapshot/report-html";
import { snapshotEvidenceId } from "../lib/snapshot/report-data";
import type { SnapshotReportData } from "../lib/snapshot/types";

function report(): SnapshotReportData {
  const value = structuredClone(fixture) as SnapshotReportData;
  value.evidenceSnippets[0].id = snapshotEvidenceId({ path: "src/index.ts", startLine: 1 });
  value.evidenceSnippets[1].id = snapshotEvidenceId({ path: "src/index.ts", startLine: 2 });
  value.evidenceSnippets[2].id = snapshotEvidenceId({ path: "src/errors.ts", startLine: 4 });
  return value;
}

describe("single-file snapshot HTML", () => {
  it("renders product, features, scenarios, evidence and coverage without continuous-analysis workflows", () => {
    const html = renderSnapshotHtml(report());
    expect(html).toContain("A small product with traceable behavior.");
    expect(html).toContain("Product snapshots");
    expect(html).toContain("HP-1");
    expect(html).toContain("50.0%");
    expect(html).toContain("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(html).toContain("Analysis boundaries");
    expect(html).not.toContain("Release notes");
    expect(html).not.toContain("Pull request");
  });

  it("prioritizes core capabilities and typical use before full specifications and collapsed evidence", () => {
    const html = renderSnapshotHtml(report());
    const core = html.indexOf('id="core-capabilities"');
    const journeys = html.indexOf('id="journeys"');
    const specification = html.indexOf('id="specification"');
    const evidence = html.indexOf('id="evidence"');
    const boundaries = html.indexOf('id="boundaries"');
    expect(core).toBeGreaterThan(0);
    expect(journeys).toBeGreaterThan(core);
    expect(specification).toBeGreaterThan(journeys);
    expect(evidence).toBeGreaterThan(specification);
    expect(boundaries).toBeGreaterThan(evidence);
    expect(html).toContain("Core capabilities");
    expect(html).toContain("Typical ways to use it");
    expect(html).toContain("Full product specification");
    expect(html).toContain('<details class="evidence-drawer report-section" id="evidence">');
  });

  it("uses relevant file counts rather than bytes or unrelated data files for effective coverage", () => {
    const input = report();
    input.effectiveCoverage = { filesAssembled: 1, filesTotal: 4, ratio: 0.25, dataFilesAssembled: 0, excludedDataFiles: 206, excludedOtherFiles: 0, rawFilesTotal: 210 };
    const html = renderSnapshotHtml(input);
    expect(html).toContain("Effective source coverage");
    expect(html).toContain("25.0%");
    expect(html).toContain("206");
    expect(html).toContain("not included in the denominator");
    expect(html).not.toContain("Implementation bytes assembled");
  });

  it("localizes the complete interface and document language from the invocation language", () => {
    const english = renderSnapshotHtml(report());
    expect(english).toContain('<html lang="en">');
    expect(english).toContain("Search features or scenarios");
    expect(english).toContain("Analysis boundaries");
    expect(english).toContain('aria-label="Snapshot navigation"');

    const chineseReport = report();
    chineseReport.language = "zh-CN";
    chineseReport.product.description = "具有可追溯行为的小型产品。";
    const chinese = renderSnapshotHtml(chineseReport);
    expect(chinese).toContain('<html lang="zh-CN">');
    expect(chinese).toContain("搜索功能或场景");
    expect(chinese).toContain("分析边界");
    expect(chinese).toContain("未提交");
    expect(chinese).toContain('aria-label="快照导航"');
    expect(chinese).not.toContain("Search features or scenarios");
  });

  it("renders a bilingual continuous-analysis call to action after boundaries and before the footer", () => {
    const english = renderSnapshotHtml(report());
    expect(english).toContain('id="codelphi-cta"');
    expect(english).toContain("Want continuous analysis for your repositories?");
    expect(english).toContain('href="https://github.com/gzhanlei/codelphi"');
    expect(english).toContain('href="https://codelphi.com"');
    expect(english.indexOf('id="boundaries"')).toBeLessThan(english.indexOf('id="codelphi-cta"'));
    expect(english.indexOf('id="codelphi-cta"')).toBeLessThan(english.indexOf('<footer class="container footer">'));
    expect(english).toContain('target="_blank" rel="noopener noreferrer"');

    const chineseReport = report();
    chineseReport.language = "zh-CN";
    const chinese = renderSnapshotHtml(chineseReport);
    expect(chinese).toContain("想持续跟进代码仓库？");
    expect(chinese).toContain("GitHub 自托管");
    expect(chinese).toContain("使用 CoDelphi.com");
  });

  it("escapes untrusted AI, repository and path content including script closure", () => {
    const input = report();
    input.features[0].name = '</script><script id="xss">alert(1)</script>';
    input.features[0].scenarios[0].outcome = '<img src=x onerror="alert(1)">';
    input.evidenceSnippets[0].path = '</script><script>alert(2)</script>';
    const html = renderSnapshotHtml(input);
    expect(html).not.toContain('<script id="xss">');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('</script><script>alert(2)</script>');
    expect(html).toContain("&lt;/script&gt;");
    const embedded = /<script id="snapshot-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(embedded).toBeDefined();
    expect(embedded).not.toContain("<");
    const parsed = JSON.parse(embedded!) as SnapshotReportData;
    expect(parsed.features[0].name).toContain("</script>");
  });

  it("contains no remote assets, automatic network calls or unsafe DOM injection", () => {
    const html = renderSnapshotHtml(report());
    expect(html).not.toMatch(/<(?:script|img)[^>]+src\s*=/i);
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("eval(");
    expect(html).not.toContain("innerHTML");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
  });

  it("links evidence with deterministic anchors and only trusted GitHub HTTPS permalinks", () => {
    const input = report();
    input.features[0].scenarios[0].evidence[0].url = "https://evil.test/phish";
    input.evidenceSnippets[1].sourceUrl = "https://evil.test/phish";
    const html = renderSnapshotHtml(input);
    expect(html).toContain(`href="#${snapshotEvidenceId({ path: "src/index.ts", startLine: 2 })}"`);
    expect(html).not.toContain('href="https://evil.test/phish"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("keeps all content readable without JavaScript and includes narrow-screen accessibility rules", () => {
    const html = renderSnapshotHtml(report());
    expect(html).toContain("<details");
    expect(html).toContain("Context");
    expect(html).toContain("Action");
    expect(html).toContain("Outcome");
    expect(html).toMatch(/@media\s*\(max-width:\s*480px\)/);
    expect(html).toMatch(/overflow-wrap:\s*anywhere/);
    expect(html).toContain(":focus-visible");
    expect(html).toContain("prefers-reduced-motion");
  });
});
