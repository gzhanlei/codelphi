import { evidenceItems } from "./evidence";
import { changeGroupLabel } from "./product-overview";
import type { buildProductOverview } from "./product-overview";

type Input = Parameters<typeof buildProductOverview>[0];
const HIGH_RISK = /支付|权限|隐私|数据|组织|登录|安全|许可|许可证|计费|订单|退款|邀请|身份|隔离/i;

function evidenceFromSubject(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const evidence = (value as { evidence?: unknown }).evidence;
  return evidenceItems(evidence).map((item) => item.path);
}

export function buildProductFocus(input: Input) {
  const displayNames = new Map(input.features.map((feature) => [feature.name, feature.displayName || feature.name]));
  const displayName = (name: string) => displayNames.get(name) ?? name;
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
      featureName: displayName(group.featureName),
      kind: "changed" as const,
      summary: summaries[0] ?? "",
      summaries,
      evidencePaths: [...new Set(group.evidencePaths)],
      groupLabel: changeGroupLabel(group.counts),
    };
  });
  const manualFeatures = latestRelease ? input.features.filter((feature) => feature.lastEditedAt && new Date(feature.lastEditedAt) >= latestRelease.committedAt) : [];
  const manualChanges = latestRelease && manualFeatures.length > 0 ? [{
    id: `manual-${latestRelease.id}`,
    releaseId: latestRelease.id,
    featureName: `${manualFeatures.length} 项产品知识维护`,
    kind: "changed" as const,
    summary: manualFeatures.map((feature) => `${displayName(feature.name)}：${feature.summary}`).join("；"),
    summaries: manualFeatures.map((feature) => `${displayName(feature.name)}：${feature.summary}`),
    evidencePaths: [...new Set(manualFeatures.flatMap((feature) => input.scenarios.filter((scenario) => scenario.featureId === feature.id).flatMap((scenario) => evidenceItems(scenario.evidence).map((item) => item.path))))],
    groupLabel: "人工维护",
  }] : [];
  const changes = [...manualChanges, ...releaseChanges].slice(0, 5);

  const attentionCandidates = [
    ...input.features.filter((feature) => feature.staleSince).map((feature) => ({ featureName: feature.name, label: displayName(feature.name), source: feature.source, reason: "相关功能或证据发生变化，需要重新评估" })),
    ...input.scenarios.filter((scenario) => scenario.staleSince).map((scenario) => ({ featureName: input.features.find((feature) => feature.id === scenario.featureId)?.name ?? "", label: displayName(input.features.find((feature) => feature.id === scenario.featureId)?.name ?? ""), source: scenario.source, reason: "相关场景或证据发生变化，需要重新评估" })),
  ];
  const attention = attentionCandidates.filter((item) => item.source === "manual" || HIGH_RISK.test(item.featureName)).slice(0, 3).map((item) => ({ featureName: item.label, reason: item.reason }));
  const confirmations = [...input.features.filter((feature) => !feature.verifiedAt).map((feature) => ({ featureName: displayName(feature.name), reason: "尚未人工确认" })), ...input.scenarios.filter((scenario) => !scenario.verifiedAt).map((scenario) => ({ featureName: displayName(input.features.find((feature) => feature.id === scenario.featureId)?.name ?? ""), reason: "尚未人工确认" }))].filter((item) => item.featureName).slice(0, 3);

  return { changes, attention, confirmations, emptyAttention: attention.length === 0 };
}
