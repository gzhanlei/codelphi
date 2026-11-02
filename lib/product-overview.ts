import { evidenceItems } from "./evidence";
import type { BehaviorChangeRow, FeatureRow, ReleaseRow, ScenarioRow } from "./types";

interface ProductOverviewInput {
  product: { id: number; slug: string; name: string; description: string };
  features: FeatureRow[];
  scenarios: ScenarioRow[];
  releases: ReleaseRow[];
  behaviorChanges: BehaviorChangeRow[];
  latestRun?: { status: string; errorMessage?: string };
  architecture?: { id: number; specVersionId: number; revision: string; status: string; errorMessage: string | null };
}

function analysisLabel(status?: string) {
  if (!status) return "尚无分析记录";
  const label = { succeeded: "最近分析成功", failed: "最近分析失败", running: "正在分析", queued: "等待分析" }[status];
  return label === undefined ? `分析状态：${status}` : label;
}

function specLabel(specVersionId: number | null, sha?: string) {
  if (specVersionId === null) return "尚未生成规格";
  return `Spec v${specVersionId}${sha ? ` · ${sha.slice(0, 7)}` : ""}`;
}

function overviewSpecVersion(input: ProductOverviewInput, latestRelease?: ReleaseRow) {
  if (input.architecture) return input.architecture.specVersionId;
  return latestRelease ? latestRelease.specVersionId : null;
}

function overviewRevision(input: ProductOverviewInput, latestRelease?: ReleaseRow) {
  return input.architecture ? input.architecture.revision : latestRelease?.sha;
}

function compareCapabilities(a: { scenarioCount: number; name: string }, b: { scenarioCount: number; name: string }) {
  if (a.scenarioCount !== b.scenarioCount) return Math.sign(b.scenarioCount - a.scenarioCount);
  return a.name.localeCompare(b.name);
}

export function buildProductOverview(input: ProductOverviewInput) {
  const latestRelease = input.releases[0];
  const specVersionId = overviewSpecVersion(input, latestRelease);
  const revision = overviewRevision(input, latestRelease);
  const evidencePaths = new Set(input.scenarios.flatMap((scenario) => evidenceItems(scenario.evidence).map((item) => item.path)));
  return {
    slug: input.product.slug,
    headline: input.product.description.trim() || "从 GitHub 代码维护可追溯的产品规格",
    freshness: specLabel(specVersionId, revision),
    analysisLabel: analysisLabel(input.latestRun ? input.latestRun.status : undefined),
    capabilities: input.features.map((feature) => ({
      id: feature.id,
      name: feature.name,
      summary: feature.summary,
      source: feature.source,
      scenarioCount: input.scenarios.filter((scenario) => scenario.featureId === feature.id).length,
      href: `/products/${input.product.slug}?view=spec&feature=${feature.id}`,
    })).sort(compareCapabilities).slice(0, 6),
    changes: latestRelease ? input.behaviorChanges.filter((change) => change.releaseId === latestRelease.id).slice(0, 3) : [],
    latestRelease,
    trust: {
      featureCount: input.features.length,
      scenarioCount: input.scenarios.length,
      manualFeatureCount: input.features.filter((feature) => feature.source === "manual").length,
      manualScenarioCount: input.scenarios.filter((scenario) => scenario.source === "manual").length,
      evidencePathCount: evidencePaths.size,
      specVersionId,
    },
    architecture: input.architecture ? {
      ...input.architecture,
      href: input.architecture.status === "accepted" ? `/api/architecture/${input.architecture.id}` : undefined,
    } : undefined,
  };
}

export type ProductOverviewData = ReturnType<typeof buildProductOverview>;
