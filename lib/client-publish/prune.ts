/**
 * 隐私扫描命中后的处理（修订稿 §4.2）：命中的那一条场景（或那一个流程图）不上传，其余照常。
 * 落在账本必需的字段上（产品简介、发布信息）的命中没法剔除，只能拦住这次发布，让用户调整后重跑。
 * 命中的内容不会离开本机。
 */
import type { PrivacyHit } from "../privacy-scan";

export interface PruneResult {
  /** 剔除之后的内容。没有命中时和传入的内容逐项相同。 */
  fields: Record<string, unknown>;
  /** 被剔除的字段路径和命中的规则，回给用户看。一个字段一条，哪怕它同时命中了几条规则。 */
  dropped: Array<{ path: string; rules: PrivacyHit["rule"][] }>;
  /** 没法剔除的命中。非空时这次发布不能继续。 */
  blocked: Array<{ path: string; rule: PrivacyHit["rule"] }>;
}

interface Target {
  container: unknown[];
  index: number;
}

/** 把 `a.b[3].c` 这样的路径归到「删掉哪一项」上。 */
function targetOf(path: string, fields: Record<string, unknown>): { kind: "drop"; target: Target } | { kind: "presentation" } | { kind: "block" } {
  const proposal = fields.proposal as Record<string, unknown> | undefined;
  const inList = (list: unknown, listPath: string): Target | null => {
    const prefix = `${listPath}[`;
    if (!path.startsWith(prefix) || !Array.isArray(list)) return null;
    const closing = path.indexOf("]", prefix.length);
    const index = Number(path.slice(prefix.length, closing));
    return Number.isInteger(index) && index >= 0 && index < list.length ? { container: list, index } : null;
  };
  const features = proposal?.features;
  const featureTarget = inList(features, "proposal.features");
  if (featureTarget) {
    const feature = (featureTarget.container[featureTarget.index] as { scenarios?: unknown }).scenarios;
    // 场景上的命中只删那一条场景；功能名或摘要上的命中删整个功能。
    const scenarioTarget = path.startsWith(`proposal.features[${featureTarget.index}].scenarios[`) ? inList(feature, `proposal.features[${featureTarget.index}].scenarios`) : null;
    return { kind: "drop", target: scenarioTarget ?? featureTarget };
  }
  const changeTarget = inList(proposal?.changes, "proposal.changes");
  if (changeTarget) return { kind: "drop", target: changeTarget };
  const flowTarget = inList(fields.flows, "flows");
  if (flowTarget) return { kind: "drop", target: flowTarget };
  if (path === "presentation" || path.startsWith("presentation.") || path.startsWith("presentation[")) return { kind: "presentation" };
  return { kind: "block" };
}

export function prunePrivacyHits(fields: Record<string, unknown>, hits: readonly PrivacyHit[]): PruneResult {
  const result: PruneResult = { fields, dropped: [], blocked: [] };
  const removals = new Map<unknown[], Set<number>>();
  let dropPresentation = false;
  for (const hit of hits) {
    const target = targetOf(hit.path, fields);
    if (target.kind === "block") {
      result.blocked.push({ path: hit.path, rule: hit.rule });
      continue;
    }
    if (target.kind === "presentation") {
      dropPresentation = true;
    } else {
      const { container, index } = target.target;
      const indexes = removals.get(container) ?? new Set<number>();
      indexes.add(index);
      removals.set(container, indexes);
    }
    const entry = result.dropped.find((item) => item.path === hit.path);
    if (entry) {
      if (!entry.rules.includes(hit.rule)) entry.rules.push(hit.rule);
    } else {
      result.dropped.push({ path: hit.path, rules: [hit.rule] });
    }
  }
  if (result.blocked.length > 0 || result.dropped.length === 0) return result;
  // 从大到小删，前面的下标才不会错位。
  for (const [container, indexes] of removals) for (const index of [...indexes].sort((left, right) => right - left)) container.splice(index, 1);
  if (dropPresentation) fields.presentation = {};
  return result;
}
