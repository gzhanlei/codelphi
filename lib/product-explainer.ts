import type { ProductOverviewData } from "./product-overview";

function prose(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "\\<").replace(/>/g, "\\>").replace(/\*/g, "\\*").replace(/"/g, "\\\"");
}

function architecturePanel(data: ProductOverviewData, includeArchitecture: boolean) {
  if (includeArchitecture && data.architecture?.status === "accepted") return "@diagram architecture source=architecture.json";
  if (!data.architecture) return "尚未生成架构文档。";
  return `架构状态：${data.architecture.status}。${data.architecture.errorMessage ? `\n${prose(data.architecture.errorMessage)}` : ""}`;
}

function capabilityRows(data: ProductOverviewData) {
  return data.capabilities.map((feature) => `| ${prose(feature.name)} | ${feature.scenarioCount} | ${feature.source === "manual" ? "人工维护" : "代码生成"} |`).join("\n");
}

function changeRows(data: ProductOverviewData) {
  return data.changes.map((change) => `| ${change.kind} {#change-${change.id}} | ${prose(change.featureName)}${change.scenarioReference ? ` · ${prose(change.scenarioReference)}` : ""} | ${prose(change.summary)} |`).join("\n");
}

export function buildExplainerMarkdown(data: ProductOverviewData, options: { includeArchitecture: boolean; repositoryUrl?: string }) {
  const revision = data.architecture?.revision || data.latestRelease?.sha;
  const repository = options.repositoryUrl && revision ? ` repo_url=${options.repositoryUrl} repo_revision=${revision}` : "";
  return `# ${prose(data.headline)} {#summary}

当前规格包含 ${data.trust.featureCount} 个功能和 ${data.trust.scenarioCount} 个场景，${data.freshness}。

- ${data.analysisLabel}，${data.trust.evidencePathCount} 个源码文件提供证据。
- 人工维护 ${data.trust.manualFeatureCount} 个功能和 ${data.trust.manualScenarioCount} 个场景，自动分析不会覆盖人工内容。

@answer scope="${prose(data.freshness)} · ${prose(data.analysisLabel)}"
@meta locale=zh-CN${repository}

## 产品如何工作 {#architecture}

${architecturePanel(data, options.includeArchitecture)}

## 当前核心能力 {#capabilities}

| 功能 | 场景数 | 来源 |
| --- | --- | --- |
${capabilityRows(data)}

## 最近改变了什么 {#changes}

${data.changes.length > 0 ? `| 类型 | 功能 / 场景 | 行为变化 |\n| --- | --- | --- |\n${changeRows(data)}` : "本次分析未发现规格行为变化。"}

## 规格可信度与下一步 {#trust}

@facts id=spec-facts
| 规格版本 | ${data.trust.specVersionId === null ? "未生成" : data.trust.specVersionId} |
| 功能 / 场景 | ${data.trust.featureCount} / ${data.trust.scenarioCount} |
| 人工功能 / 场景 | ${data.trust.manualFeatureCount} / ${data.trust.manualScenarioCount} |
| 证据文件 | ${data.trust.evidencePathCount} |
`;
}
