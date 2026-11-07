import type { BehaviorChangeRow, ReleaseRow } from "./types";

export type RegressionStatus = "pending" | "verified" | "skipped";

export const regressionStatusLabels: Record<RegressionStatus, string> = { pending: "待测", verified: "已验证", skipped: "不适用" };

export interface RegressionItemView {
  status: RegressionStatus;
  checkedBy: string | null;
}

/** 以 `${releaseId}:${specChangeId}` 为键的勾选状态表。 */
export type RegressionStatusMap = Record<string, RegressionItemView>;

export function regressionStatusKey(releaseId: number, specChangeId: number) {
  return `${releaseId}:${specChangeId}`;
}

const kindLabels: Record<string, string> = { added: "新增", changed: "变化", removed: "移除" };

function flatten(text: string) {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** 发布回归清单的 Markdown 导出：按功能分组、复选框形式，可贴进测试计划或工单。 */
export function renderRegressionMarkdown(input: { productName: string; release: ReleaseRow; changes: BehaviorChangeRow[]; statuses: RegressionStatusMap }) {
  const { productName, release, changes, statuses } = input;
  const lines = [
    `# 回归清单 · ${release.title}`,
    "",
    `- 产品：${productName}`,
    `- 提交：[${release.sha.slice(0, 7)}](${release.url})`,
    `- 生成时间：${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
  ];
  if (changes.length === 0) {
    lines.push("", "本次分析未发现规格行为变化，无需全量回归。建议做瘦身回归：按近期风险抽查核心路径与既有冒烟用例即可。");
    return lines.join("\n");
  }
  lines.push("");
  const byFeature = new Map<string, BehaviorChangeRow[]>();
  for (const change of changes) {
    const list = byFeature.get(change.featureName) ?? [];
    list.push(change);
    byFeature.set(change.featureName, list);
  }
  for (const [featureName, featureChanges] of byFeature) {
    lines.push(`## ${featureName}`);
    for (const change of featureChanges) {
      const status = statuses[regressionStatusKey(release.id, change.id)]?.status ?? "pending";
      const label = regressionStatusLabels[status];
      const checked = status === "verified" ? "x" : " ";
      const kind = kindLabels[change.kind] ?? change.kind;
      const subject = change.entityType === "scenario" && change.scenarioReference ? `${change.scenarioReference} — ${flatten(change.summary)}` : flatten(change.summary);
      const checkedBy = statuses[regressionStatusKey(release.id, change.id)]?.checkedBy;
      const suffix = status === "pending" ? "（待测）" : `（${label}${checkedBy ? ` @ ${checkedBy}` : ""}）`;
      lines.push(`- [${checked}] [${kind}] ${subject}${suffix}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
