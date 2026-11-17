import { snapshotEvidenceId } from "./report-data";
import { fallbackSnapshotPresentation } from "./presentation";
import { REPORT_COPY, REPORT_SCRIPT, REPORT_STYLES, type ReportCopy } from "./report-assets";
import type { SnapshotCoreCapability, SnapshotEvidenceSnippet, SnapshotReportData, SnapshotWarning } from "./types";

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function safeJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function trustedSourceUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) return null;
    return escapeHtml(url.href);
  } catch {
    return null;
  }
}

function warningText(copy: ReportCopy, warning: SnapshotWarning) {
  const template = copy.warningMessages[warning.code] ?? warning.code;
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => String(warning.values?.[key] ?? `{${key}}`));
}

function evidenceLabel(evidence: { path: string; startLine?: number; endLine?: number }) {
  const start = evidence.startLine;
  const end = start === undefined ? undefined : evidence.endLine ?? start;
  return `${evidence.path}${start ? `:L${start}${end === start ? "" : `-L${end}`}` : ""}`;
}

function renderEvidenceLinks(evidence: SnapshotReportData["product"]["evidence"], snippets: Map<string, SnapshotEvidenceSnippet>) {
  return evidence.map((item) => {
    const id = snapshotEvidenceId(item);
    const label = escapeHtml(evidenceLabel(item));
    return snippets.has(id) ? `<a href="#${id}">${label}</a>` : `<span>${label}</span>`;
  }).join("");
}

function renderScenario(scenario: SnapshotReportData["features"][number]["scenarios"][number], copy: ReportCopy, snippets: Map<string, SnapshotEvidenceSnippet>, featureIndex: number, scenarioIndex: number) {
  const search = [scenario.reference, scenario.context, scenario.action, scenario.outcome].join(" ").toLowerCase();
  return `<details class="scenario" id="feature-${featureIndex}-scenario-${scenarioIndex}" data-scenario data-category="${escapeHtml(scenario.category)}" data-search="${escapeHtml(search)}">
  <summary><code class="scenario-ref">${escapeHtml(scenario.reference)}</code><span class="category">${escapeHtml(copy[scenario.category])}</span><span>${escapeHtml(scenario.outcome)}</span></summary>
  <div class="scenario-body">
    <div class="scenario-field"><strong>${escapeHtml(copy.context)}</strong><p>${escapeHtml(scenario.context)}</p></div>
    <div class="scenario-field"><strong>${escapeHtml(copy.action)}</strong><p>${escapeHtml(scenario.action)}</p></div>
    <div class="scenario-field"><strong>${escapeHtml(copy.outcome)}</strong><p>${escapeHtml(scenario.outcome)}</p></div>
    <div class="evidence-links">${renderEvidenceLinks(scenario.evidence, snippets)}</div>
  </div>
</details>`;
}

function renderSnippet(snippet: SnapshotEvidenceSnippet, copy: ReportCopy) {
  const sourceUrl = trustedSourceUrl(snippet.sourceUrl);
  const lines = snippet.lines.map((line) => `<span class="code-line"><span class="line-number">${line.number}</span><span class="code-text">${escapeHtml(line.text)}</span></span>`).join("\n");
  const citation = snippet.citedStartLine === null ? "" : ` · L${snippet.citedStartLine}${snippet.citedEndLine === snippet.citedStartLine ? "" : `–L${snippet.citedEndLine}`}`;
  return `<article class="evidence-card" id="${escapeHtml(snippet.id)}">
  <h3>${escapeHtml(snippet.path)}${escapeHtml(citation)}</h3>
  ${snippet.truncated ? `<p>${escapeHtml(copy.evidenceTruncated)}</p>` : ""}
  ${snippet.unavailable || snippet.lines.length === 0 ? `<p>${escapeHtml(copy.evidenceUnavailable)}</p>` : `<pre><code>${lines}</code></pre>`}
  ${sourceUrl ? `<a class="source-link" href="${sourceUrl}" rel="noopener noreferrer">${escapeHtml(copy.viewSource)}</a>` : ""}
</article>`;
}

function number(value: number, language: SnapshotReportData["language"]) {
  return new Intl.NumberFormat(language).format(value);
}

function scenarioIndex(report: SnapshotReportData) {
  const scenarios = new Map<string, SnapshotReportData["features"][number]["scenarios"][number]>();
  for (const feature of report.features) {
    for (const scenario of feature.scenarios) scenarios.set(`${feature.name}\0${scenario.reference}`, scenario);
  }
  return scenarios;
}

function renderCapability(capability: SnapshotCoreCapability, report: SnapshotReportData, copy: ReportCopy) {
  const firstFeature = report.features.findIndex((feature) => feature.name === capability.featureNames[0]);
  return `<article class="capability-card">
  <h3>${escapeHtml(capability.name)}</h3>
  <p>${escapeHtml(capability.summary)}</p>
  ${firstFeature >= 0 ? `<a href="#spec-feature-${firstFeature}">${number(capability.featureNames.length, report.language)} · ${escapeHtml(copy.specifications)}</a>` : ""}
</article>`;
}

function renderJourneys(capabilities: SnapshotCoreCapability[], report: SnapshotReportData) {
  const scenarios = scenarioIndex(report);
  return capabilities.map((capability) => {
    const selected = capability.scenarioRefs.flatMap((ref) => {
      const scenario = scenarios.get(`${ref.featureName}\0${ref.reference}`);
      return scenario ? [scenario] : [];
    }).slice(0, 2);
    if (selected.length === 0) return "";
    return `<article class="journey-card"><p class="journey-capability">${escapeHtml(capability.name)}</p><div class="journey-steps">${selected.map((scenario) => `<div class="journey-step"><h3>${escapeHtml(scenario.outcome)}</h3><p>${escapeHtml(scenario.context)}</p><p>${escapeHtml(scenario.action)}</p></div>`).join("")}</div></article>`;
  }).join("");
}

export function renderSnapshotHtml(report: SnapshotReportData) {
  const language = report.language === "zh-CN" ? "zh-CN" : "en";
  const copy = REPORT_COPY[language];
  const presentation = report.presentation ?? fallbackSnapshotPresentation({ features: report.features }, language);
  const snippets = new Map(report.evidenceSnippets.map((snippet) => [snippet.id, snippet]));
  const features = report.features.map((feature, featureIndex) => {
    const search = `${feature.name} ${feature.summary}`.toLowerCase();
    return `<article class="feature-card" id="spec-feature-${featureIndex}" data-feature data-feature-search="${escapeHtml(search)}">
  <details class="feature-body">
    <summary class="feature-header"><h3>${escapeHtml(feature.name)}</h3><p>${escapeHtml(feature.summary)}</p></summary>
    <div>${feature.scenarios.map((scenario, scenarioIndex) => renderScenario(scenario, copy, snippets, featureIndex, scenarioIndex)).join("")}</div>
  </details>
</article>`;
  }).join("");
  const warnings = report.warnings.length > 0 ? `<section class="boundary-notices" aria-labelledby="warnings-heading"><div class="section-heading"><h2 id="warnings-heading">${escapeHtml(copy.warnings)}</h2><span>${report.warnings.length}</span></div><ul class="notice-list">${report.warnings.map((warning) => `<li>${escapeHtml(warningText(copy, warning))}</li>`).join("")}</ul></section>` : "";
  const description = presentation.tagline ?? report.product.description ?? copy.noDescription;
  const effectiveCoverage = report.effectiveCoverage ?? {
    filesAssembled: report.coverage.implFilesAssembled,
    filesTotal: report.coverage.implFilesTotal,
    ratio: report.coverage.implFilesTotal === 0 ? 0 : report.coverage.implFilesAssembled / report.coverage.implFilesTotal,
    dataFilesAssembled: 0,
    excludedDataFiles: 0,
    excludedOtherFiles: 0,
    rawFilesTotal: report.coverage.implFilesTotal,
  };
  const coveragePercent = `${(effectiveCoverage.ratio * 100).toFixed(1)}%`;

  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(report.snapshot.name)}${escapeHtml(copy.titleSuffix)}</title>
  <style>${REPORT_STYLES}</style>
</head>
<body data-screen-label="${escapeHtml(copy.productSnapshot)}">
  <span class="top-anchor" id="top"></span>
  <header class="hero" id="overview">
    <div class="hero-inner">
      <p class="eyebrow">${escapeHtml(copy.overview)}</p>
      <h1>${escapeHtml(report.snapshot.name)}</h1>
      <p class="hero-description">${escapeHtml(description)}</p>
      <p class="hero-revision">${escapeHtml(report.snapshot.branch ?? "—")} · ${escapeHtml(report.snapshot.revision.slice(0, 8))}</p>
      <details class="snapshot-details"><summary>${escapeHtml(copy.snapshotDetails)}</summary><div class="meta">
        <span><strong>${escapeHtml(copy.source)}</strong> ${escapeHtml(report.snapshot.target)}</span>
        <span><strong>${escapeHtml(copy.revision)}</strong> <code>${escapeHtml(report.snapshot.revision)}</code></span>
        <span><strong>${escapeHtml(copy.branch)}</strong> ${escapeHtml(report.snapshot.branch ?? "—")}</span>
        <span><strong>${escapeHtml(copy.generatedAt)}</strong> ${escapeHtml(report.generatedAt)}</span>
        <span><strong>${escapeHtml(copy.model)}</strong> ${escapeHtml(report.modelName)}</span>
      </div></details>
    </div>
  </header>
  <nav class="snapshot-nav" aria-label="${escapeHtml(copy.navLabel)}"><div class="container">
    <a href="#overview">${escapeHtml(copy.overview)}</a>
    <a href="#core-capabilities">${escapeHtml(copy.coreCapabilities)}</a>
    <a href="#journeys">${escapeHtml(copy.journeys)}</a>
    <a href="#specification">${escapeHtml(copy.specifications)}</a>
    <a href="#evidence">${escapeHtml(copy.evidence)}</a>
    <a href="#boundaries">${escapeHtml(copy.boundaries)}</a>
  </div></nav>
  <noscript><div class="noscript">${escapeHtml(copy.noScript)}</div></noscript>
  <main class="container">
    <section class="report-section" id="core-capabilities" aria-labelledby="core-heading">
      <div class="section-heading"><h2 id="core-heading">${escapeHtml(copy.coreCapabilities)}</h2><span>${presentation.coreCapabilities.length}</span></div>
      <div class="capability-grid">${presentation.coreCapabilities.map((capability) => renderCapability(capability, report, copy)).join("")}</div>
    </section>
    <section class="report-section" id="journeys" aria-labelledby="journeys-heading">
      <div class="section-heading"><h2 id="journeys-heading">${escapeHtml(copy.journeys)}</h2></div>
      <div class="journey-list">${renderJourneys(presentation.coreCapabilities, report)}</div>
    </section>
    <section class="report-section" id="specification" aria-labelledby="specification-heading">
      <div class="section-heading"><h2 id="specification-heading">${escapeHtml(copy.specifications)}</h2><span>${report.features.length}</span></div>
      <div class="controls">
        <div class="control"><label for="snapshot-search">${escapeHtml(copy.searchLabel)}</label><input id="snapshot-search" type="search" placeholder="${escapeHtml(copy.searchPlaceholder)}" autocomplete="off"></div>
        <div class="control"><label for="snapshot-category">${escapeHtml(copy.categoryLabel)}</label><select id="snapshot-category"><option value="all">${escapeHtml(copy.allCategories)}</option><option value="happy">${escapeHtml(copy.happy)}</option><option value="edge">${escapeHtml(copy.edge)}</option><option value="error">${escapeHtml(copy.error)}</option></select></div>
      </div>
      <div class="feature-list">${features}</div>
      <div class="empty-state" id="snapshot-no-results" hidden>${escapeHtml(copy.noResults)}</div>
    </section>
    <details class="evidence-drawer report-section" id="evidence">
      <summary><span>${escapeHtml(copy.expandEvidence)}</span><span>${report.evidenceSnippets.length}</span></summary>
      <div class="evidence-list">${report.evidenceSnippets.map((snippet) => renderSnippet(snippet, copy)).join("")}</div>
    </details>
    <section class="report-section" id="boundaries" aria-labelledby="boundaries-heading">
      <div class="section-heading"><h2 id="boundaries-heading">${escapeHtml(copy.boundaries)}</h2></div>
      <div class="summary-grid">
        <div class="summary-card"><span>${escapeHtml(copy.coverage)}</span><strong>${coveragePercent}</strong><small>${number(effectiveCoverage.filesAssembled, language)}/${number(effectiveCoverage.filesTotal, language)}</small></div>
        <div class="summary-card"><span>${escapeHtml(copy.assembledBytes)}</span><strong>${number(effectiveCoverage.excludedDataFiles, language)}</strong><small>${escapeHtml(copy.notInDenominator)}</small></div>
        <div class="summary-card"><span>${escapeHtml(copy.partitions)}</span><strong>${number(report.analysis.partitions, language)}</strong><small>${number(report.analysis.retries, language)}</small></div>
      </div>
      ${warnings}
      <div class="boundary-card"><h3>${escapeHtml(copy.trustTitle)}</h3><p>${escapeHtml(copy.trustBody)}</p><p>${escapeHtml(copy.coverageNote)}</p></div>
    </section>
    <article class="cta-card" id="codelphi-cta" aria-labelledby="codelphi-cta-heading">
      <h2 id="codelphi-cta-heading">${escapeHtml(copy.ctaTitle)}</h2>
      <p>${escapeHtml(copy.ctaBody)}</p>
      <footer class="cta-actions">
        <a href="https://github.com/gzhanlei/codelphi" target="_blank" rel="noopener noreferrer">${escapeHtml(copy.ctaGithub)}</a>
        <a class="secondary" href="https://codelphi.com" target="_blank" rel="noopener noreferrer">${escapeHtml(copy.ctaCloud)}</a>
      </footer>
    </article>
  </main>
  <footer class="container footer"><span>CoDelphi</span><a class="back-to-top" href="#top">${escapeHtml(copy.backToTop)}</a></footer>
  <script id="snapshot-data" type="application/json">${safeJson({ ...report, presentation })}</script>
  <script>${REPORT_SCRIPT}</script>
</body>
</html>`;
}
