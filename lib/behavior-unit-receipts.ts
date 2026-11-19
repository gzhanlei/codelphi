import { DETECTOR_REGISTRY_VERSION, INVENTORY_SCHEMA_VERSION } from "./behavior-inventory/index";
import { canonicalManifest, manifestHash, normalizeManifest } from "./behavior-inventory/manifest";
import type { BehaviorManifest } from "./behavior-inventory/types";
import type { Execute } from "./db";

/** Task 5 契约（2026-11-19 行为清单全量分析）：analysis_behavior_manifests 的 insert-only
 *  持久化。manifest 一旦落库即不可变——同 run 同 hash 重入幂等，同 run 不同 manifest 抛
 *  inventory_version_conflict，绝不 UPDATE/REPLACE；恢复路径重算 hash 验证持久化内容，
 *  篡改或版本（inventory schema / detector registry）不一致一律拒绝。 */

export type InventoryPersistenceErrorCode = "inventory_version_conflict" | "inventory_manifest_tampered";

export class InventoryPersistenceError extends Error {
  code: InventoryPersistenceErrorCode;
  constructor(code: InventoryPersistenceErrorCode, message: string) {
    super(message);
    this.name = "InventoryPersistenceError";
    this.code = code;
  }
}

interface PersistedManifestRow {
  manifestJson: string;
  manifestHash: string;
}

async function selectManifestRow(execute: Execute, runId: number): Promise<PersistedManifestRow | null> {
  const [rows] = (await execute(
    "SELECT manifest_json, manifest_hash FROM analysis_behavior_manifests WHERE run_id = ?",
    [runId],
  )) as [Array<{ manifest_json: unknown; manifest_hash: unknown }>, unknown];
  if (rows.length === 0) return null;
  const raw = rows[0].manifest_json;
  return {
    manifestJson: typeof raw === "string" ? raw : JSON.stringify(raw),
    manifestHash: String(rows[0].manifest_hash),
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ER_DUP_ENTRY"
  );
}

function parseStoredManifest(manifestJson: string, runId: number): BehaviorManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    throw new InventoryPersistenceError(
      "inventory_manifest_tampered",
      `run ${runId} behavior manifest is not valid JSON; refusing to resume from unverifiable content`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InventoryPersistenceError(
      "inventory_manifest_tampered",
      `run ${runId} behavior manifest is not a JSON object; refusing to resume from unverifiable content`,
    );
  }
  return parsed as BehaviorManifest;
}

/** 持久化 manifest 校验：内容完整性（重算 canonical hash）先于版本协商，篡改永远优先暴露。
 *  规范化本身被拒绝（如非法区间）同样意味着内容不是本管线写出的，按篡改处理。 */
function verifyPersistedManifest(row: PersistedManifestRow, runId: number): BehaviorManifest {
  const manifest = parseStoredManifest(row.manifestJson, runId);
  let recomputed: string;
  try {
    recomputed = manifestHash(manifest);
  } catch {
    throw new InventoryPersistenceError(
      "inventory_manifest_tampered",
      `run ${runId} behavior manifest cannot be normalized; refusing to resume from unverifiable content`,
    );
  }
  if (recomputed !== row.manifestHash) {
    throw new InventoryPersistenceError(
      "inventory_manifest_tampered",
      `run ${runId} behavior manifest hash mismatch: persisted content was modified after insert; refusing to resume`,
    );
  }
  if (
    manifest.inventorySchemaVersion !== INVENTORY_SCHEMA_VERSION ||
    manifest.detectorRegistryVersion !== DETECTOR_REGISTRY_VERSION
  ) {
    throw new InventoryPersistenceError(
      "inventory_version_conflict",
      `run ${runId} behavior manifest was written by inventory schema ${String(manifest.inventorySchemaVersion)} ` +
        `/ detector registry ${String(manifest.detectorRegistryVersion)}, current code expects ` +
        `${INVENTORY_SCHEMA_VERSION} / ${DETECTOR_REGISTRY_VERSION}; create a new run instead of resuming`,
    );
  }
  return normalizeManifest(manifest);
}

/**
 * 首次写入 run 的不可变 manifest。同 run 同 hash 的重入（含并发唯一键冲突后的重试）幂等成功；
 * 同 run 不同 manifest 抛 inventory_version_conflict——调用方必须开新 run，本函数绝不改写已存行。
 */
export async function insertManifestIfAbsent(execute: Execute, runId: number, manifest: BehaviorManifest): Promise<void> {
  const canonical = canonicalManifest(manifest);
  const hash = manifestHash(manifest);
  try {
    await execute(
      `INSERT INTO analysis_behavior_manifests
         (run_id, after_sha, scope_fingerprint, inventory_schema_version, detector_registry_version, manifest_json, manifest_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        manifest.afterSha,
        manifest.scopeFingerprint,
        manifest.inventorySchemaVersion,
        manifest.detectorRegistryVersion,
        canonical,
        hash,
      ],
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const existing = await selectManifestRow(execute, runId);
    if (existing && existing.manifestHash === hash) return;
    throw new InventoryPersistenceError(
      "inventory_version_conflict",
      `run ${runId} already has a different behavior manifest; refusing to overwrite, create a new run instead`,
    );
  }
}

/** 恢复时读取并验证 run 的 manifest：缺失、JSON 损坏或 hash 不符 → tampered；版本不符 → conflict。 */
export async function loadVerifiedManifest(execute: Execute, runId: number): Promise<BehaviorManifest> {
  const row = await selectManifestRow(execute, runId);
  if (!row) {
    throw new InventoryPersistenceError(
      "inventory_manifest_tampered",
      `run ${runId} has no persisted behavior manifest; refusing to resume from missing content`,
    );
  }
  return verifyPersistedManifest(row, runId);
}
