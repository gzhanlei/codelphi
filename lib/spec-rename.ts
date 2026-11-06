import { evidenceItems } from "./evidence";
import type { BehaviorChangeRow } from "./types";

export interface SuspectedRename {
  removedId: number;
  addedId: number;
  removedName: string;
  addedName: string;
  sharedPaths: number;
}

function featureEvidencePaths(change: BehaviorChangeRow): Set<string> {
  const subject = change.kind === "removed" ? change.before : change.after;
  if (typeof subject !== "object" || subject === null || !("scenarios" in subject)) return new Set();
  const scenarios = (subject as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(scenarios)) return new Set();
  return new Set(scenarios.flatMap((scenario) => evidenceItems((scenario as { evidence?: unknown }).evidence).map((item) => item.path)).filter(Boolean));
}

function isFeatureLevel(change: BehaviorChangeRow) {
  return change.entityType === "feature" && (change.kind === "removed" || change.kind === "added");
}

/**
 * C-lite：在确定性行为 diff 上为「removed↔added 且共享足够多证据路径」的对子标注疑似改名。
 * 纯展示层信号——不修改 spec_changes 数据，不做合并；错误标注的代价远小于错误合并。
 */
export function matchSuspectedRenames(changes: BehaviorChangeRow[], minSharedPaths = 2): SuspectedRename[] {
  const removed = changes.filter((change) => isFeatureLevel(change) && change.kind === "removed");
  const added = changes.filter((change) => isFeatureLevel(change) && change.kind === "added");
  const candidates: Array<SuspectedRename & { score: number }> = [];
  for (const removedChange of removed) {
    const removedPaths = featureEvidencePaths(removedChange);
    for (const addedChange of added) {
      const sharedPaths = [...featureEvidencePaths(addedChange)].filter((path) => removedPaths.has(path)).length;
      if (sharedPaths >= minSharedPaths) {
        candidates.push({ removedId: removedChange.id, addedId: addedChange.id, removedName: removedChange.featureName, addedName: addedChange.featureName, sharedPaths, score: sharedPaths });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.removedId - b.removedId || a.addedId - b.addedId);
  const usedRemoved = new Set<number>();
  const usedAdded = new Set<number>();
  const pairs: SuspectedRename[] = [];
  for (const { score, ...pair } of candidates) {
    if (usedRemoved.has(pair.removedId) || usedAdded.has(pair.addedId)) continue;
    usedRemoved.add(pair.removedId);
    usedAdded.add(pair.addedId);
    pairs.push(pair);
  }
  return pairs;
}

/** 给行为变化行挂上疑似改名的对侧名称（仅展示用）。 */
export function annotateSuspectedRenames(changes: BehaviorChangeRow[]): BehaviorChangeRow[] {
  const pairs = matchSuspectedRenames(changes);
  const byId = new Map<number, string>();
  for (const pair of pairs) {
    byId.set(pair.removedId, pair.addedName);
    byId.set(pair.addedId, pair.removedName);
  }
  return changes.map((change) => (byId.has(change.id) ? { ...change, suspectedRenameWith: byId.get(change.id) } : change));
}
