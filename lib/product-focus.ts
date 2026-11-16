import { evidenceItems } from "./evidence";
import { featureHref } from "./spec-editor-ui";
import { changeGroupLabel } from "./product-overview";
import type { buildProductOverview } from "./product-overview";

type Input = Parameters<typeof buildProductOverview>[0];
type Feature = Input["features"][number];
type Scenario = Input["scenarios"][number];

const HIGH_RISK = /支付|权限|隐私|数据|组织|登录|安全|许可|许可证|计费|订单|退款|邀请|身份|隔离/i;

function verification(feature: Feature) {
  if (!feature.verifiedAt) return "unverified" as const;
  return feature.staleSince ? "stale-verified" as const : "verified" as const;
}

function scenariosOf(feature: Feature, scenarios: Scenario[]) {
  return scenarios.filter((scenario) => scenario.featureId === feature.id).slice(0, 3).map((scenario) => ({
    reference: scenario.reference,
    context: scenario.context,
    action: scenario.action,
    outcome: scenario.outcome,
    source: scenario.source,
  }));
}

function evidenceFromSubject(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const evidence = (value as { evidence?: unknown }).evidence;
  return evidenceItems(evidence).map((item) => item.path);
}

export function buildProductFocus(input: Input) {
  const map = input.features.map((feature) => ({
    id: feature.id,
    name: feature.name,
    summary: feature.summary,
    source: feature.source,
    verification: verification(feature),
    scenarioCount: input.scenarios.filter((scenario) => scenario.featureId === feature.id).length,
    scenarios: scenariosOf(feature, input.scenarios),
    href: `${input.productBase}${featureHref(feature.id)}`,
  })).sort((a, b) => Number(b.verification === "stale-verified") - Number(a.verification === "stale-verified")
    || Number(b.source === "manual") - Number(a.source === "manual")
    || a.name.localeCompare(b.name)).slice(0, 5);

  const latestRelease = input.releases[0];
  const behaviorChanges = latestRelease ? input.behaviorChanges.filter((change) => change.releaseId === latestRelease.id) : [];
  const changeGroups = new Map<string, {
    releaseId: number;
    featureName: string;
    counts: { added: number; removed: number; changed: number };
    userImpacts: string[];
    fallbackSummaries: string[];
    evidencePaths: string[];
  }>();
  for (const change of behaviorChanges) {
    const group = changeGroups.get(change.featureName) ?? {
      releaseId: change.releaseId,
      featureName: change.featureName,
      counts: { added: 0, removed: 0, changed: 0 },
      userImpacts: [],
      fallbackSummaries: [],
      evidencePaths: [],
    };
    group.counts[change.kind] += 1;
    const userImpact = (input.changes ?? []).find((item) => item.releaseId === change.releaseId && item.featureName === change.featureName && item.userImpact.trim())?.userImpact.trim();
    if (userImpact) group.userImpacts.push(userImpact);
    else if (change.summary.trim()) group.fallbackSummaries.push(change.summary);
    group.evidencePaths.push(...evidenceFromSubject(change.kind === "removed" ? change.before : change.after));
    changeGroups.set(change.featureName, group);
  }
  const releaseChanges = [...changeGroups.values()].map((group) => {
    const summaries = [...new Set(group.userImpacts.length > 0 ? group.userImpacts : group.fallbackSummaries)];
    return {
      id: `release-${group.releaseId}-${group.featureName}`,
      releaseId: group.releaseId,
      featureName: group.featureName,
      kind: "changed" as const,
      summary: summaries[0] ?? "",
      summaries,
      evidencePaths: [...new Set(group.evidencePaths)],
      groupLabel: changeGroupLabel(group.counts),
    };
  });
  const manualChanges = latestRelease ? input.features.filter((feature) => feature.lastEditedAt && new Date(feature.lastEditedAt) >= latestRelease.committedAt).map((feature) => ({
    id: `manual-${feature.id}`,
    releaseId: latestRelease.id,
    featureName: feature.name,
    kind: "changed" as const,
    summary: feature.summary,
    summaries: [feature.summary],
    evidencePaths: [...new Set(input.scenarios.filter((scenario) => scenario.featureId === feature.id).flatMap((scenario) => evidenceItems(scenario.evidence).map((item) => item.path)))],
    groupLabel: "人工维护",
  })) : [];
  const changes = [...manualChanges, ...releaseChanges].slice(0, 5);

  const attentionCandidates = [
    ...input.features.filter((feature) => feature.staleSince).map((feature) => ({ featureName: feature.name, source: feature.source, reason: "相关功能或证据发生变化，需要重新评估" })),
    ...input.scenarios.filter((scenario) => scenario.staleSince).map((scenario) => ({ featureName: input.features.find((feature) => feature.id === scenario.featureId)?.name ?? "", source: scenario.source, reason: "相关场景或证据发生变化，需要重新评估" })),
  ];
  const attention = attentionCandidates.filter((item) => item.source === "manual" || HIGH_RISK.test(item.featureName)).slice(0, 3);
  const confirmations = [...input.features.filter((feature) => !feature.verifiedAt).map((feature) => ({ featureName: feature.name, reason: "尚未人工确认" })), ...input.scenarios.filter((scenario) => !scenario.verifiedAt).map((scenario) => ({ featureName: input.features.find((feature) => feature.id === scenario.featureId)?.name ?? "", reason: "尚未人工确认" }))].filter((item) => item.featureName).slice(0, 3);

  return { map, changes, attention, confirmations, emptyAttention: attention.length === 0 };
}
