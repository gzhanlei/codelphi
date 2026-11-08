import type { ProductOverviewData } from "./product-overview";

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const changeKindLabels: Record<string, string> = { added: "新增", changed: "更新", removed: "移除" };

function capabilityRows(data: ProductOverviewData) {
  return data.capabilities.map((capability) => `<tr><td><a href="${escapeHtml(capability.href)}">${escapeHtml(capability.name)}</a></td><td>${capability.scenarioCount}</td><td>${capability.source === "manual" ? "人工维护" : "代码生成"}</td></tr>`).join("");
}

function changeRows(data: ProductOverviewData) {
  return data.changes.map((change) => `<tr><td>${changeKindLabels[change.kind] ?? escapeHtml(change.kind)}</td><td>${escapeHtml(change.featureName)}${change.scenarioReference ? ` · ${escapeHtml(change.scenarioReference)}` : ""}</td><td>${escapeHtml(change.summary)}</td></tr>`).join("");
}

function trustRows(data: ProductOverviewData) {
  const facts: Array<[string, string]> = [
    ["规格版本", data.trust.specVersionId === null ? "未生成" : `v${data.trust.specVersionId}`],
    ["功能 / 场景", `${data.trust.featureCount} / ${data.trust.scenarioCount}`],
    ["人工功能 / 场景", `${data.trust.manualFeatureCount} / ${data.trust.manualScenarioCount}`],
    ["证据文件", String(data.trust.evidencePathCount)],
  ];
  return facts.map(([label, value]) => `<tr><td>${label}</td><td>${escapeHtml(value)}</td></tr>`).join("");
}

const styles = `
:root { --ink: #1d2b25; --muted: #5d6f66; --line: #d9e2dc; --surface: #ffffff; --soft: #f4f8f5; --accent: #1f7a4d; }
:root[data-theme="dark"] { --ink: #e6efe9; --muted: #9db3a8; --line: #31473d; --surface: #14201b; --soft: #1a2a23; --accent: #6fd0a0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { --ink: #e6efe9; --muted: #9db3a8; --line: #31473d; --surface: #14201b; --soft: #1a2a23; --accent: #6fd0a0; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--soft); color: var(--ink); font: 16px/1.7 "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
.shell { max-width: 860px; margin: 0 auto; padding: 0 24px 40px; }
.masthead { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px 0; border-bottom: 1px solid var(--line); }
.brand strong { font-size: 17px; letter-spacing: .5px; }
.brand span { margin-left: 10px; color: var(--muted); font-size: 12px; }
.theme-controls { display: flex; gap: 6px; }
.theme-controls button { border: 1px solid var(--line); background: var(--surface); color: var(--muted); border-radius: 7px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
.theme-controls button[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }
.answer { padding: 34px 0 8px; }
.answer-mark { display: inline-block; border: 1px solid var(--accent); color: var(--accent); border-radius: 999px; padding: 2px 12px; font-size: 12px; margin: 0 0 14px; }
.answer h1 { font-size: clamp(26px, 4vw, 38px); font-weight: 600; line-height: 1.3; margin: 0 0 10px; }
.answer-scope { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
.answer ul { margin: 0; padding-left: 20px; }
.answer li { margin: 6px 0; }
.trust-note { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
section.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 22px 24px; margin-top: 22px; }
section.panel h2 { font-size: 17px; margin: 0 0 14px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-size: 12px; font-weight: 600; }
td a { color: var(--accent); text-decoration: none; }
td a:hover { text-decoration: underline; }
.empty { color: var(--muted); font-size: 14px; margin: 0; }
.colophon { margin-top: 34px; padding-top: 18px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: baseline; }
.colophon a { display: inline-flex; align-items: baseline; gap: 10px; color: var(--ink); text-decoration: none; }
.colophon-name { font-weight: 700; }
.colophon-tagline { color: var(--muted); font-size: 13px; }
.colophon-facts { margin: 0; color: var(--muted); font-size: 12px; }
@media print {
  body { background: #fff; color: #111; }
  .theme-controls { display: none; }
  section.panel { border: 1px solid #ccc; }
}
`.trim();

const themeScript = `
(function () {
  var root = document.documentElement;
  var buttons = document.querySelectorAll("[data-theme-choice]");
  function apply(theme) {
    if (theme === "auto") delete root.dataset.theme; else root.dataset.theme = theme;
    buttons.forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme)); });
  }
  buttons.forEach(function (button) { button.addEventListener("click", function () { apply(button.dataset.themeChoice); }); });
  apply("auto");
})();
`.trim();

/** CoDelphi 自有的 Explainer 单页渲染：纯文本产品说明（能力/变化/可信度），自带主题与打印样式，无外部引擎。 */
export function renderProductExplainerHtml(data: ProductOverviewData) {
  const title = escapeHtml(data.headline);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="${title}">
<title>${title} · CoDelphi</title>
<style>${styles}</style>
</head>
<body>
<div class="shell">
<header class="masthead">
<div class="brand"><strong>CoDelphi</strong><span>产品说明</span></div>
<div class="theme-controls" role="group" aria-label="主题">
<button type="button" data-theme-choice="auto" aria-pressed="true">系统</button>
<button type="button" data-theme-choice="light" aria-pressed="false">浅色</button>
<button type="button" data-theme-choice="dark" aria-pressed="false">深色</button>
</div>
</header>
<main>
<section class="answer">
<p class="answer-mark">答</p>
<h1>${title}</h1>
<p class="answer-scope">${escapeHtml(data.freshness)} · ${escapeHtml(data.analysisLabel)}</p>
<ul>
<li>当前规格包含 ${data.trust.featureCount} 个功能和 ${data.trust.scenarioCount} 个场景，${escapeHtml(data.freshness)}。</li>
<li>${escapeHtml(data.analysisLabel)}，${data.trust.evidencePathCount} 个源码文件提供证据。</li>
<li>人工维护 ${data.trust.manualFeatureCount} 个功能和 ${data.trust.manualScenarioCount} 个场景，自动分析不会覆盖人工内容。</li>
</ul>
</section>
<section class="panel" id="capabilities">
<h2>当前核心能力</h2>
<table><thead><tr><th>功能</th><th>场景数</th><th>来源</th></tr></thead><tbody>${capabilityRows(data)}</tbody></table>
</section>
<section class="panel" id="changes">
<h2>最近改变了什么</h2>
${data.changes.length > 0 ? `<table><thead><tr><th>类型</th><th>功能 / 场景</th><th>行为变化</th></tr></thead><tbody>${changeRows(data)}</tbody></table>` : `<p class="empty">本次分析未发现规格行为变化。</p>`}
</section>
<section class="panel" id="trust">
<h2>证据覆盖率</h2>
<table><tbody>${trustRows(data)}</tbody></table>
<p class="trust-note">证据覆盖率描述证据范围，不表示结论正确；采纳前应经人工核实。</p>
</section>
</main>
<footer class="colophon">
<a href="/products/${escapeHtml(data.slug)}"><span class="colophon-name">CoDelphi</span><span class="colophon-tagline">读懂每一次产品变化。</span></a>
<p class="colophon-facts">${data.trust.specVersionId === null ? "规格未生成" : `规格版本 v${data.trust.specVersionId}`} · 生成于 ${new Date().toISOString().slice(0, 10)}</p>
</footer>
</div>
<script>${themeScript}</script>
</body>
</html>`;
}
