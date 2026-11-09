/**
 * A2 Release notes 纯函数核心（docs/specsight-gap-improvement-plan.md §4.3 / §9 R1）。
 * 门禁：每个块必须锚定一个真实存在的 spec_changes.id，证据路径不得越出锚定变化的
 * 证据集；生成阶段（validateDraft）就做引用存在性校验——存在悬空锚点或越界证据的
 * 草稿不允许落库，类似 assertEvidence 的引用校验。人工 Publish 才发布；已发布只读。
 */

export interface ReleaseNoteChange {
  id: number;
  kind: string;
  entityType: string;
  featureName: string;
  scenarioReference: string;
  summary: string;
  highlightType: string | null;
  evidencePaths: string[];
}

export interface ReleaseNoteBlock {
  position: number;
  specChangeId: number;
  featureName: string;
  kind: string;
  entityType: string;
  scenarioReference: string;
  summary: string;
  highlightType: string | null;
  evidencePaths: string[];
  emphasis: string;
}

/** Highlight 排序：有 Highlight 的在前，类别间按九类固定顺序，无 Highlight 在后；同序按 id。 */
const HIGHLIGHT_ORDER = ["Heads-up", "Pricing", "Limits", "Privacy", "Security", "Access", "Integrations", "Beta", "News"];

export function publishOrder<T extends ReleaseNoteChange>(changes: T[]): T[] {
  return [...changes].sort((a, b) => {
    const rankA = a.highlightType ? HIGHLIGHT_ORDER.indexOf(a.highlightType) : HIGHLIGHT_ORDER.length;
    const rankB = b.highlightType ? HIGHLIGHT_ORDER.indexOf(b.highlightType) : HIGHLIGHT_ORDER.length;
    if (rankA !== rankB) return rankA - rankB;
    return a.id - b.id;
  });
}

/** 由勾选的变更构建草稿块（不自动全选；顺序按 Highlight 排序）。 */
export function buildDraftBlocks(changes: ReleaseNoteChange[], selectedIds?: number[]): ReleaseNoteBlock[] {
  const ordered = publishOrder(changes);
  const selected = selectedIds ? ordered.filter((item) => selectedIds.includes(item.id)) : ordered;
  return selected.map((item, index) => ({
    position: index + 1,
    specChangeId: item.id,
    featureName: item.featureName,
    kind: item.kind,
    entityType: item.entityType,
    scenarioReference: item.scenarioReference,
    summary: item.summary,
    highlightType: item.highlightType,
    evidencePaths: item.evidencePaths,
    emphasis: "",
  }));
}

export type DraftValidation = { ok: true } | { ok: false; error: string };

/**
 * 引用存在性校验：块锚定的 spec_change 必须存在于本次发布的行为变化集；
 * 块携带的证据路径不得越出锚定变化的证据集（防编辑引入不存在的引用）。
 */
export function validateDraft(blocks: ReleaseNoteBlock[], changes: ReleaseNoteChange[]): DraftValidation {
  const byId = new Map(changes.map((item) => [item.id, item]));
  for (const block of blocks) {
    const anchored = byId.get(block.specChangeId);
    if (!anchored) {
      return { ok: false, error: `块 ${block.position} 锚定的 spec_change #${block.specChangeId} 不存在于本次发布` };
    }
    const allowed = new Set(anchored.evidencePaths);
    for (const path of block.evidencePaths) {
      if (!allowed.has(path)) {
        return { ok: false, error: `块 ${block.position} 的证据路径 ${path} 不在锚定变化 #${block.specChangeId} 的证据集内` };
      }
    }
  }
  return { ok: true };
}

/** 人工发布门禁：空草稿不能发布；存在无锚定 spec_change 的块不能发布。 */
export function canPublish(blocks: Array<{ specChangeId: number }>, existingChangeIds: Set<number>): string | null {
  if (blocks.length === 0) return "empty draft: 勾选至少一条要宣布的变更";
  const unanchored = blocks.filter((block) => !existingChangeIds.has(block.specChangeId));
  if (unanchored.length > 0) {
    return `anchor missing: 块锚定的 spec_change 不存在（#${unanchored.map((block) => block.specChangeId).join(", #")}）`;
  }
  return null;
}
