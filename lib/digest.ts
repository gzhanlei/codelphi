import { publishOrder, type ReleaseNoteChange } from "./release-notes";

/**
 * A2 内部 Digest（docs/specsight-gap-improvement-plan.md §4.3）。
 * 内容结构：本期变了什么 → 对 support / sales / marketing 分别意味着什么 → 关键变更可点开。
 * 确定性组装（零生成文本，R1 的幻觉面为零）：每条宣布项可回溯到 spec_changes id 与证据路径。
 * 无变化的周返回 null（不生成、不发送，沿用现有通知规则）。
 */

export interface DigestChange extends ReleaseNoteChange {
  releaseTitle: string;
  releaseUrl: string;
  /** 锚定字段与 Release notes 块同名（R1：每条宣布项可回溯到 spec_changes）。 */
  specChangeId?: number;
}

export interface DigestContent {
  period: { start: string; end: string };
  /** specChangeId 与 Release notes 块的锚定同名：每条宣布项可回溯到 spec_changes。 */
  changes: Array<DigestChange & { specChangeId: number }>;
  audiences: {
    support: DigestChange[];
    sales: DigestChange[];
    marketing: DigestChange[];
  };
}

/** 确定性分桶：Highlight 类别决定受众段落；无 Highlight 的普通变更只进变更清单与 support。 */
function audienceBuckets(changes: DigestChange[]) {
  const support: DigestChange[] = [];
  const sales: DigestChange[] = [];
  const marketing: DigestChange[] = [];
  for (const change of changes) {
    // 行为变化对 QA / support 直接相关：都要进 support（回归视角）
    support.push(change);
    if (change.highlightType === "Security" || change.highlightType === "Access" || change.highlightType === "Limits") {
      support.unshift(change); // 影响用户操作方式的变化，support 需优先知道
    }
    if (change.highlightType === "Pricing") sales.push(change);
    if (change.highlightType === "News" || change.highlightType === "Integrations" || change.highlightType === "Beta") {
      marketing.push(change);
    }
  }
  return { support, sales, marketing };
}

export function buildDigest(input: { periodStart: string; periodEnd: string; changes: DigestChange[] }): DigestContent | null {
  if (input.changes.length === 0) return null;
  // 分桶与变更清单共用同一富化形状（带 specChangeId）：每条宣布项在任何段落都可回溯
  const ordered = publishOrder(input.changes).map((change) => ({ ...change, specChangeId: change.id, releaseUrl: change.releaseUrl })) as Array<DigestChange & { specChangeId: number }>;
  return {
    period: { start: input.periodStart, end: input.periodEnd },
    changes: ordered,
    audiences: audienceBuckets(ordered),
  };
}
