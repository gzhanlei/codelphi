import { createHash } from "node:crypto";
import { compareCodePoints, normalizeCodeRanges, normalizeLineRanges } from "./identity";
import type {
  BehaviorAnchor,
  BehaviorAnchorFragment,
  BehaviorEvidence,
  BehaviorExecutionTask,
  BehaviorManifest,
  BehaviorUnit,
} from "./types";

function normalizeEvidence(evidence: readonly BehaviorEvidence[]): Array<{ path: string; startLine: number | null }> {
  const normalized = evidence.map((entry) => {
    if (entry.startLine != null && (!Number.isInteger(entry.startLine) || entry.startLine < 1)) {
      throw new Error(`invalid range: evidence startLine must be a positive integer, got ${entry.startLine}`);
    }
    return { path: entry.path, startLine: entry.startLine ?? null };
  });
  normalized.sort(
    (a, b) => compareCodePoints(a.path, b.path) || (a.startLine ?? 0) - (b.startLine ?? 0),
  );
  return normalized;
}

function normalizeAnchor(anchor: BehaviorAnchor): BehaviorAnchor {
  return {
    anchorKey: anchor.anchorKey,
    role: anchor.role,
    ranges: normalizeLineRanges(anchor.ranges),
    evidence: normalizeEvidence(anchor.evidence),
    coarse: anchor.coarse,
  };
}

function normalizeUnit(unit: BehaviorUnit): BehaviorUnit {
  const anchors = unit.anchors.map(normalizeAnchor);
  anchors.sort((a, b) => compareCodePoints(a.anchorKey, b.anchorKey));
  return {
    unitKey: unit.unitKey,
    kind: unit.kind,
    primaryPath: unit.primaryPath,
    primaryRanges: unit.primaryRanges == null ? null : normalizeLineRanges(unit.primaryRanges),
    contextRanges: normalizeCodeRanges(unit.contextRanges),
    anchors,
    detector: unit.detector,
    detectorVersion: unit.detectorVersion,
  };
}

function normalizeFragment(fragment: BehaviorAnchorFragment): BehaviorAnchorFragment {
  return {
    anchorKey: fragment.anchorKey,
    anchorFragmentKey: fragment.anchorFragmentKey,
    ranges: normalizeLineRanges(fragment.ranges),
  };
}

function normalizeTask(task: BehaviorExecutionTask): BehaviorExecutionTask {
  const anchorFragments = task.anchorFragments.map(normalizeFragment);
  anchorFragments.sort((a, b) => compareCodePoints(a.anchorFragmentKey, b.anchorFragmentKey));
  return { taskKey: task.taskKey, unitKey: task.unitKey, anchorFragments };
}

/** 规范化 manifest：对象 key 与数组顺序固定、区间先规范化、可选字段统一物化为 null。 */
export function normalizeManifest(manifest: BehaviorManifest): BehaviorManifest {
  const units = manifest.units.map(normalizeUnit);
  units.sort((a, b) => compareCodePoints(a.unitKey, b.unitKey));
  const tasks = manifest.tasks.map(normalizeTask);
  tasks.sort((a, b) => compareCodePoints(a.taskKey, b.taskKey));
  return {
    inventorySchemaVersion: manifest.inventorySchemaVersion,
    detectorRegistryVersion: manifest.detectorRegistryVersion,
    afterSha: manifest.afterSha,
    scopeFingerprint: manifest.scopeFingerprint,
    units,
    tasks,
  };
}

/** Canonical JSON：对象 key 按码点排序；undefined 与显式 null 统一序列化为 null。 */
function canonicalStringify(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodePoints);
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

export function canonicalManifest(manifest: BehaviorManifest): string {
  return canonicalStringify(normalizeManifest(manifest));
}

/** SHA-256 只用于 manifest 完整性与数据库索引，不作为跨 revision 语义身份。 */
export function manifestHash(manifest: BehaviorManifest): string {
  return createHash("sha256").update(canonicalManifest(manifest), "utf8").digest("hex");
}
