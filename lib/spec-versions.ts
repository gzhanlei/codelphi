import type { PoolConnection } from "mysql2/promise";
import type { AnalysisResult, SpecAnchorFeature } from "./ai";
import type { RunContext } from "./analysis";
import { compareCodePoints } from "./behavior-inventory/identity";
import { defaultExecute, type Execute } from "./db";
import { evidenceItems } from "./evidence";
import { nextReference } from "./extraction-merge";
import type { ReleaseChangeFact } from "./release-change-projection";
import { dedupeExactScenarioProjections, diffSpec, featureScenarioPairMatch, featureVariantSimilar, mergeSpecSources, preserveExactScenarioIdentities, preserveUnchangedEvidence, scenarioBehaviorEqual, specFeatureKey, specScenarioKey, unionScenarioOriginKeys, type PatchHunk, type SpecChange, type SpecFeature, type SpecScenario, type SpecTombstones } from "./spec-diff";
import { classifySpecHighlight } from "./spec-highlights";
import { detectVisibilityConflicts } from "./spec-consistency";

interface FeatureRow {
  id: number;
  name: string;
  summary: string;
  parentId?: number | null;
  parentKey?: string | null;
  source: "generated" | "manual";
}

interface ScenarioRow {
  featureId: number;
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: SpecScenario["category"];
  step?: number | null;
  source: "generated" | "manual";
  evidence: unknown;
}

export function featureParentKey(feature: { parentId?: number | null; parentKey?: string | null }, parentNames: Map<number, string>) {
  if (feature.parentId) {
    const parentName = parentNames.get(feature.parentId);
    if (parentName !== undefined) return parentName;
  }
  return feature.parentKey === undefined ? null : feature.parentKey;
}

function featuresFromRows(featureRows: FeatureRow[], scenarioRows: ScenarioRow[]): SpecFeature[] {
  const parentNames = new Map(featureRows.map((feature) => [feature.id, feature.name]));
  return featureRows.map((feature) => ({
    ...feature,
    parentKey: featureParentKey(feature, parentNames),
    scenarios: scenarioRows.filter((scenario) => scenario.featureId === feature.id).map((scenario) => ({
      reference: scenario.reference,
      context: scenario.context,
      action: scenario.action,
      outcome: scenario.outcome,
      category: scenario.category,
      step: scenario.step === undefined || scenario.step === null ? null : Number(scenario.step),
      source: scenario.source,
      evidence: evidenceItems(scenario.evidence),
    })),
  }));
}

async function loadScenarioRows(connection: PoolConnection, features: FeatureRow[], kind: "manual" | "version") {
  if (features.length === 0) return [];
  const ids = features.map((feature) => feature.id);
  const placeholders = ids.map(() => "?").join(",");
  const config = kind === "manual"
    ? { table: "scenarios", column: "feature_id", condition: `source = 'manual' AND active = 1 AND feature_id IN (${placeholders})` }
    : { table: "spec_scenarios", column: "spec_feature_id", condition: `spec_feature_id IN (${placeholders})` };
  const [rows] = await connection.execute(
    `SELECT ${config.column} AS featureId, reference, context, action, outcome, category, step_order AS step, source, evidence
     FROM ${config.table} WHERE ${config.condition}`,
    ids,
  );
  return rows as ScenarioRow[];
}

async function loadFeatureSpec(connection: PoolConnection, kind: "manual" | "version", query: string, parameters: number[]) {
  const [featureRows] = await connection.execute(query, parameters);
  const features = featureRows as FeatureRow[];
  return featuresFromRows(features, await loadScenarioRows(connection, features, kind));
}

async function loadManualSpec(connection: PoolConnection, productId: number) {
  return loadFeatureSpec(
    connection,
    "manual",
    `SELECT features.id, features.name, features.summary, features.parent_id AS parentId, parents.name AS parentKey, features.source
     FROM features LEFT JOIN features parents ON parents.id = features.parent_id AND parents.active = 1
     WHERE features.product_id = ? AND features.active = 1 AND (
       features.source = 'manual' OR EXISTS (
         SELECT 1 FROM scenarios s WHERE s.feature_id = features.id AND s.source = 'manual' AND s.active = 1
       ) OR EXISTS (
         SELECT 1 FROM features child WHERE child.parent_id = features.id AND child.active = 1
       )
     )`,
    [productId],
  );
}

async function loadManualTombstones(connection: PoolConnection, productId: number): Promise<SpecTombstones> {
  const [featureResult, scenarioResult] = await Promise.all([
    connection.execute("SELECT name FROM features WHERE product_id = ? AND active = 0 AND source = 'manual'", [productId]),
    connection.execute("SELECT f.name AS featureName, s.reference FROM scenarios s JOIN features f ON f.id = s.feature_id WHERE f.product_id = ? AND s.active = 0 AND s.source = 'manual'", [productId]),
  ]);
  const featureRows = featureResult[0] as Array<{ name: string }>;
  const scenarioRows = scenarioResult[0] as Array<{ featureName: string; reference: string }>;
  return {
    featureKeys: new Set(featureRows.map((feature) => specFeatureKey(feature.name))),
    scenarioKeys: new Set(scenarioRows.map((scenario) => specScenarioKey(scenario.featureName, scenario.reference))),
  };
}

async function loadVersionFeatures(connection: PoolConnection, versionId: number) {
  return loadFeatureSpec(connection, "version", "SELECT id, name, summary, parent_key AS parentKey, source FROM spec_features WHERE spec_version_id = ? ORDER BY position", [versionId]);
}

/** 批量读取多个 spec 版本的完整规格（发布变化视图的折叠明细重算用），key 为版本 id。 */
export async function loadVersionFeatureMap(execute: Execute, versionIds: number[]): Promise<Map<number, SpecFeature[]>> {
  const featureMap = new Map<number, SpecFeature[]>();
  if (versionIds.length === 0) return featureMap;
  const placeholders = versionIds.map(() => "?").join(",");
  const [featureResult, scenarioResult] = await Promise.all([
    execute(`SELECT id, spec_version_id AS versionId, name, summary, parent_key AS parentKey, source FROM spec_features WHERE spec_version_id IN (${placeholders}) ORDER BY position`, versionIds),
    execute(
      `SELECT sf.spec_version_id AS versionId, ss.spec_feature_id AS featureId, ss.reference, ss.context, ss.action, ss.outcome, ss.category, ss.step_order AS step, ss.source, ss.evidence
       FROM spec_scenarios ss JOIN spec_features sf ON sf.id = ss.spec_feature_id
       WHERE sf.spec_version_id IN (${placeholders})`,
      versionIds,
    ),
  ]);
  const featureRows = (Array.isArray(featureResult) ? featureResult[0] : []) as Array<FeatureRow & { versionId: number }>;
  const scenarioRows = (Array.isArray(scenarioResult) ? scenarioResult[0] : []) as Array<ScenarioRow & { versionId: number }>;

  const featuresByVersion = new Map<number, FeatureRow[]>();
  for (const row of featureRows) {
    const list = featuresByVersion.get(Number(row.versionId)) ?? [];
    list.push(row);
    featuresByVersion.set(Number(row.versionId), list);
  }
  for (const [versionId, rows] of featuresByVersion) {
    featureMap.set(versionId, featuresFromRows(rows, scenarioRows.filter((scenario) => scenario.versionId === versionId)));
  }
  return featureMap;
}

/** 读取每个 spec 版本在同仓库下的前一版本 id（diffSpec 的 base）；首个版本无 base 返回 null。 */
export async function loadBaseVersionMap(execute: Execute, versionIds: number[]): Promise<Map<number, number | null>> {
  const baseMap = new Map<number, number | null>();
  if (versionIds.length === 0) return baseMap;
  const placeholders = versionIds.map(() => "?").join(",");
  const result = await execute(
    `SELECT v.id AS versionId,
            COALESCE(v.base_spec_version_id, (SELECT prev.id FROM spec_versions prev WHERE prev.repository_id = v.repository_id AND prev.id < v.id ORDER BY prev.id DESC LIMIT 1)) AS baseVersionId
     FROM spec_versions v WHERE v.id IN (${placeholders})`,
    versionIds,
  );
  // mysql2 execute resolve 值是 [rows, fields] 元组；先取行数组再使用。
  const payload = Array.isArray(result) ? result[0] : [];
  for (const row of (Array.isArray(payload) ? payload : []) as Array<{ versionId: number; baseVersionId: number | null }>) {
    baseMap.set(Number(row.versionId), row.baseVersionId === null ? null : Number(row.baseVersionId));
  }
  return baseMap;
}

async function loadPreviousSpec(connection: PoolConnection, run: RunContext, base: "latest" | "beforeRun" = "latest", baseVersionId?: number | null) {
  if (baseVersionId === null) return null;
  const [versions] = await connection.execute(
    baseVersionId !== undefined
      ? "SELECT id FROM spec_versions WHERE repository_id = ? AND id = ?"
      : base === "beforeRun"
        ? "SELECT id FROM spec_versions WHERE repository_id = ? AND analysis_run_id < ? ORDER BY id DESC LIMIT 1"
        : "SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1",
    baseVersionId !== undefined ? [run.repositoryId, baseVersionId] : base === "beforeRun" ? [run.repositoryId, run.id] : [run.repositoryId],
  );
  const version = (versions as Array<{ id: number }>)[0];
  if (!version) return null;
  const features = await loadVersionFeatures(connection, version.id);
  return { id: version.id, features };
}

/**
 * 写入版本快照并返回 Task 12 行为来源最终映射：Task 10 的 localScenarioKey（originKeys）
 * → 最终 spec_scenarios 行 id。originKeys 不落任何列，只用于同事务回填
 * analysis_behavior_anchor_scenarios.final_scenario_id。同一 origin 映射到两行是账本
 * 不变量违例（去重/折叠丢来源），直接抛错让上层回滚，绝不静默取其一。
 */
async function insertFeatures(connection: PoolConnection, versionId: number, features: SpecFeature[]): Promise<Map<string, number>> {
  const scenarioIdByLocalKey = new Map<string, number>();
  for (const [position, feature] of features.entries()) {
    const [featureResult] = await connection.execute(
      `INSERT INTO spec_features (spec_version_id, stable_key, name, summary, parent_key, source, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [versionId, specFeatureKey(feature.name), feature.name, feature.summary, feature.parentKey === undefined ? null : feature.parentKey, feature.source === undefined ? "generated" : feature.source, position],
    );
    const featureId = Number((featureResult as { insertId: number }).insertId);
    for (const scenario of feature.scenarios) {
      const [scenarioResult] = await connection.execute(
        `INSERT INTO spec_scenarios
          (spec_feature_id, reference, context, action, outcome, category, step_order, source, evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [featureId, scenario.reference, scenario.context, scenario.action, scenario.outcome, scenario.category, scenario.step ?? null, scenario.source === undefined ? "generated" : scenario.source, JSON.stringify(scenario.evidence)],
      );
      if (!scenario.originKeys || scenario.originKeys.length === 0) continue;
      const scenarioId = Number((scenarioResult as { insertId: number }).insertId);
      for (const originKey of [...scenario.originKeys].sort(compareCodePoints)) {
        if (scenarioIdByLocalKey.has(originKey)) {
          throw new Error(`behavior_origin_duplicate:${originKey} would map to two final scenario rows`);
        }
        scenarioIdByLocalKey.set(originKey, scenarioId);
      }
    }
  }
  return scenarioIdByLocalKey;
}

async function insertChanges(connection: PoolConnection, versionId: number, baseVersionId: number | null, changes: SpecChange[]): Promise<ReleaseChangeFact[]> {
  const persisted: ReleaseChangeFact[] = [];
  for (const change of changes) {
    // A3 Highlight：确定性规则打标（零 AI 成本），绝大多数 change 为 NULL 不强标
    const highlight = classifySpecHighlight(change);
    const [insertResult] = await connection.execute(
      `INSERT INTO spec_changes
        (spec_version_id, base_spec_version_id, entity_type, kind, feature_key, feature_name,
         scenario_reference, summary, highlight_type, highlight_reason, before_json, after_json, judgment, evidence_state, reason_codes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        versionId,
        baseVersionId,
        change.entityType,
        change.kind,
        specFeatureKey(change.featureName),
        change.featureName,
        change.scenarioReference === null ? "" : change.scenarioReference,
        change.summary,
        highlight?.type ?? null,
        highlight?.reason ?? null,
        change.before ? JSON.stringify(change.before) : null,
        change.after ? JSON.stringify(change.after) : null,
        change.judgment ?? null,
        change.evidenceState ?? null,
        change.reasonCodes ? JSON.stringify(change.reasonCodes) : null,
      ],
    );
    persisted.push({ ...change, id: Number((insertResult as { insertId: number }).insertId) });
  }
  return persisted;
}

/** BM-11 功能级折叠回执：变体名并入旧身份的审计记录（folded 不落库，走 mergeIntegrity + 日志）。 */
export interface FeatureFold {
  /** 被折叠的变体功能（本版合并输出中的名字）。 */
  fromName: string;
  fromKey: string;
  /** 折叠目标（上一版既有身份；并存型=当前版内的 carried 特征，改名型=上一版被改名替代的特征）。 */
  intoName: string;
  intoKey: string;
  /** renamed=旧键已从合并输出消失（AI 改名），变体特征重命名回旧名；merged=旧键仍在（carried），变体场景并入。 */
  mode: "renamed" | "merged";
}

/**
 * BM-11 功能级变体折叠（跨 run 装配）：功能 identity = specFeatureKey(name)，LLM 换一字
 * 命名（「无壳页面语言切换」↔「无外壳页面语言切换」，f7b2d60/38d3c7e 两 run 各立）即
 * 诞生新功能，旧功能并存永不收口——上一版功能 × 本版合并输出跑 featureVariantSimilar
 * （键不同才配对），命中即「变体并入旧身份」：
 * - 改名型（旧键已消失）：变体特征重命名回旧名——key 连续性保住，BM-4 门禁/锚/carry
 *   全部受益，diff 不再出 removed↔added 对；
 * - 并存型（旧键仍被 carry）：变体特征的非重复场景并入旧键特征（去重用
 *   featureScenarioPairMatch——被大段改写的同行为场景也须收口），变体条目丢弃。
 * 守卫（宁漏勿错合）：任一侧 manual 不折（AGENTS.md 红线：人工条目不得自动覆盖）；
 * 旧键在 tombstones 中不折（防止复活用户下线功能）；parentKey 不一致不折（父子结构
 * 冲突宁漏）。折叠不删历史 spec_changes（A4 审计口径），别名走 feature_aliases 显式登记。
 */
export function foldVariantFeatures(previousFeatures: SpecFeature[], features: SpecFeature[], tombstones: SpecTombstones): { features: SpecFeature[]; folds: FeatureFold[] } {
  const folds: FeatureFold[] = [];
  if (previousFeatures.length === 0 || features.length === 0) return { features, folds };
  const currentByKey = new Map(features.map((feature) => [specFeatureKey(feature.name), feature] as const));
  for (const previousFeature of previousFeatures) {
    const previousKey = specFeatureKey(previousFeature.name);
    if (tombstones.featureKeys.has(previousKey)) continue;
    for (const feature of features) {
      const key = specFeatureKey(feature.name);
      if (key === previousKey) continue;
      // 该变体条目已被此前折叠移除/重命名则跳过（对象同一性比对，Map 里的才是活条目）。
      if (currentByKey.get(key) !== feature) continue;
      if (previousFeature.source === "manual" || feature.source === "manual") continue;
      if ((previousFeature.parentKey ?? null) !== (feature.parentKey ?? null)) continue;
      if (!featureVariantSimilar(previousFeature, feature)) continue;
      const existingAtPreviousKey = currentByKey.get(previousKey);
      if (existingAtPreviousKey && existingAtPreviousKey !== feature) {
        // 并存型：变体场景并入旧键特征（featureScenarioPairMatch 口径 + 引用冲突重编号）。
        const references = existingAtPreviousKey.scenarios.map((scenario) => scenario.reference);
        for (const scenario of feature.scenarios) {
          const duplicate = existingAtPreviousKey.scenarios.find((existing) => featureScenarioPairMatch(existing, scenario));
          if (duplicate) {
            // Task 12：被折叠判定丢弃的重复场景，其行为来源必须并入存活行
            unionScenarioOriginKeys(duplicate, scenario);
            continue;
          }
          const reference = references.includes(scenario.reference) ? nextReference(references, scenario.reference) : scenario.reference;
          references.push(reference);
          existingAtPreviousKey.scenarios.push({ ...scenario, reference });
        }
        currentByKey.delete(key);
        folds.push({ fromName: feature.name, fromKey: key, intoName: existingAtPreviousKey.name, intoKey: previousKey, mode: "merged" });
      } else if (!existingAtPreviousKey) {
        // 改名型：变体特征重命名回旧名，key 连续性保住；后续变体经并存分支并入。
        const renamed: SpecFeature = { ...feature, name: previousFeature.name };
        currentByKey.delete(key);
        currentByKey.set(previousKey, renamed);
        folds.push({ fromName: feature.name, fromKey: key, intoName: previousFeature.name, intoKey: previousKey, mode: "renamed" });
      }
    }
  }
  // 保持原 features 相对顺序：被折叠条目按位置移除（改名型在其原位插回重命名条目，
  // 直接 filter 会把重命名条目一起丢掉——它已不在 foldedNames 名下）。
  const foldsByFromKey = new Map(folds.map((fold) => [fold.fromKey, fold] as const));
  const emittedKeys = new Set<string>();
  const result: SpecFeature[] = [];
  for (const feature of features) {
    const key = specFeatureKey(feature.name);
    const fold = foldsByFromKey.get(key);
    if (fold) {
      if (fold.mode === "renamed" && !emittedKeys.has(fold.intoKey)) {
        const renamed = currentByKey.get(fold.intoKey);
        if (renamed) {
          result.push(renamed);
          emittedKeys.add(fold.intoKey);
        }
      }
      continue;
    }
    if (emittedKeys.has(key)) continue;
    result.push(currentByKey.get(key) ?? feature);
    emittedKeys.add(key);
  }
  return { features: result, folds };
}

export async function insertSpecVersion(connection: PoolConnection, run: RunContext, result: AnalysisResult, options: { affectedKeys?: ReadonlySet<string>; behavioralChangePaths?: ReadonlySet<string>; changedHunksByPath?: ReadonlyMap<string, readonly PatchHunk[]>; base?: "latest" | "beforeRun"; baseVersionId?: number | null } = {}): Promise<{ specVersionId: number; specChanges: ReleaseChangeFact[]; baseline?: boolean; features: ReturnType<typeof mergeSpecSources>; collapse: SpecVersionCollapse | null; featureCollapses: FeatureCollapse[]; misplacedScenarios: MisplacedScenario[]; identityHijacksDropped: number; featureFolds: FeatureFold[]; scenarioIdByLocalKey: Map<string, number> }> {
  const [previous, manual, tombstones] = await Promise.all([loadPreviousSpec(connection, run, options.base, options.baseVersionId), loadManualSpec(connection, run.productId), loadManualTombstones(connection, run.productId)]);
  // M9 增量模式：受影响集之外的 generated 条目原样沿用上一版（三分合并：carried 种子 < AI < manual）。
  const affectedKeys = options.affectedKeys;
  const carried = affectedKeys && previous
    ? previous.features.filter((feature) => !affectedKeys.has(specFeatureKey(feature.name)))
    : [];
  // BM-4 身份门禁（benchmark bm1-incremental-blind-eval §3 F1，P0）：增量模式下 AI 输出
  // 不得覆盖 carried 键——W0-10 契约规定未受影响功能原样沿用、新行为走新键；违反即
  // 「同名键身份劫持」（run 64 实锤：`databricks sql lab` 的内容被整体置换为 SQL Lab RLS）。
  // 命中 carried 键的 AI 特征直接丢弃并计数（进完整性账本 mergeIntegrity），carried 内容保全；
  // 真实新行为仍可经 ② 通道以新键进入规格。
  let generated = result.features;
  let identityHijacksDropped = 0;
  if (affectedKeys && carried.length > 0) {
    const carriedKeys = new Set(carried.map((feature) => specFeatureKey(feature.name)));
    const hijackedNames: string[] = [];
    generated = generated.filter((feature) => {
      if (!carriedKeys.has(specFeatureKey(feature.name))) return true;
      hijackedNames.push(feature.name);
      return false;
    });
    identityHijacksDropped = hijackedNames.length;
    if (identityHijacksDropped > 0) {
      console.error("[spec] identity hijack dropped (BM-4 gate)", {
        runId: run.id,
        dropped: identityHijacksDropped,
        keys: hijackedNames.map((name) => specFeatureKey(name)),
      });
    }
  }
  // 锚点级保真（2026-11-19 第二次根治，release 284 实证）：全量重提取——含「受影响集为空→
  // 保持全量」回退分支（affectedKeys=null 使 carried=[]）——此前整批替换积累账本，一次
  // scripts/ 弱覆盖 push 流失 222 条跨功能场景。全模式生效：全量输出与上一版按锚点级
  // carry 合并，唯一丢弃依据=证据锚点与本次行为变更 hunk 相交（行为真变了）或证据无行号
  // （保守）。manual 保护与 AI 重发同引用去重不受影响；首分析 previous=null 时为 no-op。
  generated = preserveUnchangedEvidence(previous?.features ?? [], generated, options.behavioralChangePaths ?? new Set<string>(), { changedHunksByPath: options.changedHunksByPath });
  const features = mergeSpecSources(generated, manual, tombstones, carried);
  // BM-11 功能级变体折叠（跨 run）：变体命名并入上一版既有身份，改名型重命名回旧键、
  // 并存型场景并入 carried 特征——快照/diff/工作台三个面共用这份折叠结果。
  const { features: foldedFeatures, folds: featureFolds } = foldVariantFeatures(previous?.features ?? [], features, tombstones);
  if (featureFolds.length > 0) {
    console.error("[spec] feature variant folded (BM-11)", {
      runId: run.id,
      folds: featureFolds.map((fold) => `${fold.fromName}(${fold.mode}) -> ${fold.intoName}`),
    });
  }
  // 行为窗口只在增量/RC2-carry 模式下有语义：提取确实被窗口框定时，「证据全在窗口外」
  // 才能证伪一个新增功能（superset 盲评 #1009）。全量重建时整库重提取、窗口只覆盖本发布
  // 的几个文件——门禁会把所有新功能吞掉（生产 v201 实证：70 个新功能 0 条 added，
  // 118 个旧名记为移除）。语言与模式无关：确定性变化摘要按本版输出语言生成（072）。
  const previousCanonical = previous === null ? null : { ...previous, features: dedupeExactScenarioProjections(previous.features) };
  const finalFeatures = dedupeExactScenarioProjections(preserveExactScenarioIdentities(previous?.features ?? [], foldedFeatures, tombstones));
  const visibilityConflicts = detectVisibilityConflicts(finalFeatures);
  if (visibilityConflicts.length > 0) {
    console.error("[spec] visibility outcome conflicts rejected", { runId: run.id, conflicts: visibilityConflicts.map((conflict) => ({ feature: conflict.feature, token: conflict.token })) });
    throw new Error("spec_conflict_rejected");
  }
  const changes = diffSpec(previousCanonical?.features ?? null, finalFeatures, {
    behavioralChangePaths: affectedKeys ? options.behavioralChangePaths : undefined,
    language: run.outputLanguage === "en" ? "en" : "zh-CN",
  });
  const collapse = detectSpecCollapse(previousCanonical, finalFeatures);
  const featureCollapses = detectFeatureCollapses(previousCanonical, finalFeatures);
  const misplacedScenarios = detectMisplacedScenarios(previousCanonical, finalFeatures);
  const [versionResult] = await connection.execute(
    "INSERT INTO spec_versions (product_id, repository_id, analysis_run_id, base_spec_version_id, sha, output_language) VALUES (?, ?, ?, ?, ?, ?)",
    [run.productId, run.repositoryId, run.id, previous?.id ?? null, run.afterSha, run.outputLanguage === "en" ? "en" : "zh-CN"],
  );
  const versionId = Number((versionResult as { insertId: number }).insertId);
  const scenarioIdByLocalKey = await insertFeatures(connection, versionId, finalFeatures);
  const specChanges = await insertChanges(connection, versionId, previous === null ? null : previous.id, changes);
  // 合并后的完整 spec 一并返回：M9 影子对比必须以 carry-forward 之后的规格为对象。
  return { specVersionId: versionId, specChanges, baseline: previous === null, features: finalFeatures, collapse, featureCollapses, misplacedScenarios, identityHijacksDropped, featureFolds, scenarioIdByLocalKey };
}

/** 规格坍缩（护栏）：新版场景数较上一版骤降超过阈值。生产 v95（2026-11-08）178→83 即此形态。 */
export interface SpecVersionCollapse {
  previousScenarios: number;
  currentScenarios: number;
}

export const SPEC_COLLAPSE_RATIO = 0.7;
/** 低于该规模的新版不做坍缩判定，避免小规格的正常增删触发误报。 */
export const SPEC_COLLAPSE_MIN_PREVIOUS = 20;

/**
 * 单功能坍缩护栏（BM-7，benchmark bm1-incremental-blind-eval §3 F4）：总护栏只看全量
 * 场景数，增量模式下「受影响功能被窗口内容顶掉」会被新功能/新场景的增量掩盖
 * （语义视图批量删除三轮 13→5、-8/-10 条复现，总量却在涨）。按 stable key 逐功能
 * 对比上一版：场景数降幅过半程阈值、或无行为等价对应的场景删除数达阈值即告警
 * （只告警不阻断，append-only + 人工核实签发）。重写（同引用行为不等价）与位移
 * （引用消失但有行为等价对应）单独计数供排查，不单独触发告警。
 */
export interface FeatureCollapse {
  featureName: string;
  previousScenarios: number;
  currentScenarios: number;
  removed: number;
  rewritten: number;
}

/** 单功能护栏的最小上一版场景数：低于此值正常增删即可触发，误报率高。 */
export const FEATURE_COLLAPSE_MIN_PREVIOUS = 4;
/** 无行为等价对应的场景删除数达到该值即告警（与降幅条件独立）。 */
export const FEATURE_COLLAPSE_MIN_REMOVED = 3;

export function detectFeatureCollapses(previous: { features: SpecFeature[] } | null, current: SpecFeature[]): FeatureCollapse[] {
  if (!previous) return [];
  const currentByKey = new Map(current.map((feature) => [specFeatureKey(feature.name), feature]));
  const collapses: FeatureCollapse[] = [];
  for (const prev of previous.features) {
    const curr = currentByKey.get(specFeatureKey(prev.name));
    // 功能整体移除由 diffSpec 的 feature removed 记录，不属单功能坍缩
    if (!curr) continue;
    const currentScenarios = curr.scenarios;
    let removed = 0;
    let rewritten = 0;
    for (const prevScenario of prev.scenarios) {
      const sameReference = currentScenarios.find((scenario) => scenario.reference === prevScenario.reference);
      if (!sameReference) {
        // 引用消失：行为等价场景仍在（重编号位移）计 rewritten，行为真的没了计 removed
        if (currentScenarios.some((scenario) => scenarioBehaviorEqual(prevScenario, scenario))) rewritten += 1;
        else removed += 1;
        continue;
      }
      if (!scenarioBehaviorEqual(prevScenario, sameReference)) rewritten += 1;
    }
    const collapsed = prev.scenarios.length >= FEATURE_COLLAPSE_MIN_PREVIOUS
      && (curr.scenarios.length < prev.scenarios.length * SPEC_COLLAPSE_RATIO || removed >= FEATURE_COLLAPSE_MIN_REMOVED);
    if (collapsed) {
      collapses.push({ featureName: prev.name, previousScenarios: prev.scenarios.length, currentScenarios: curr.scenarios.length, removed, rewritten });
    }
  }
  return collapses;
}

/**
 * BM-6 跨域放置校验（benchmark bm1-incremental-blind-eval §3 F2）：restore_impact 场景
 * 落到 REST API、缩略图隔离落到嵌入式访客凭据回退——模型把窗口行为写进证据面无关的
 * 既有功能。确定性判定取最强信号（双档中的高档）：新场景的**全部**证据路径都在该功能
 * 上一版证据面之外，且被另一个既有功能的证据面主张 → 跨域放置违规，计数入完整性账本。
 * 低档（证据不属任何既有功能面 = 纯外扩）不可机械判定真假——合法的功能边界扩张
 * （如 SQL 编辑器新增 sql/rls.py 场景）同形，不告警、归人工核实签发。
 */
export interface MisplacedScenario {
  featureName: string;
  scenarioReference: string;
  evidencePaths: string[];
  ownedByKey: string;
  ownedByName: string;
}

export function detectMisplacedScenarios(previous: { features: SpecFeature[] } | null, current: SpecFeature[]): MisplacedScenario[] {
  if (!previous) return [];
  const surfaces = new Map<string, { name: string; paths: Set<string> }>();
  for (const feature of previous.features) {
    const paths = new Set<string>();
    for (const scenario of feature.scenarios) {
      for (const item of scenario.evidence) paths.add(item.path);
    }
    surfaces.set(specFeatureKey(feature.name), { name: feature.name, paths });
  }
  const misplaced: MisplacedScenario[] = [];
  for (const feature of current) {
    const key = specFeatureKey(feature.name);
    const own = surfaces.get(key);
    // 新键没有既有证据面可校验；沿用的 carried 场景证据与上一版相同，天然命中自身面
    if (!own) continue;
    for (const scenario of feature.scenarios) {
      const paths = [...new Set(scenario.evidence.map((item) => item.path))];
      if (paths.length === 0) continue;
      if (paths.some((path) => own.paths.has(path))) continue;
      const owner = [...surfaces.entries()].find(([otherKey, surface]) => otherKey !== key && paths.some((path) => surface.paths.has(path)));
      if (owner) {
        misplaced.push({
          featureName: feature.name,
          scenarioReference: scenario.reference,
          evidencePaths: paths,
          ownedByKey: owner[0],
          ownedByName: owner[1].name,
        });
      }
    }
  }
  return misplaced;
}

function countScenarios(features: SpecFeature[]) {
  return features.reduce((total, feature) => total + feature.scenarios.length, 0);
}

/** 坍缩纯判定，导出供测试复用；insertSpecVersion 落库前调用。 */
export function detectSpecCollapse(previous: { features: SpecFeature[] } | null, features: SpecFeature[]): SpecVersionCollapse | null {
  if (!previous) return null;
  const before = countScenarios(previous.features);
  const after = countScenarios(features);
  if (before < SPEC_COLLAPSE_MIN_PREVIOUS) return null;
  if (after >= before * SPEC_COLLAPSE_RATIO) return null;
  return { previousScenarios: before, currentScenarios: after };
}

/** B：读取最新 spec 版本的功能名清单（分析前调用，供 prompt 命名连续性约束）。 */
export async function loadPreviousFeatureNames(repositoryId: number, execute: Execute = defaultExecute) {
  const result = await execute(
    `SELECT sf.name FROM spec_features sf
     WHERE sf.spec_version_id = (SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1)
     ORDER BY sf.id`,
    [repositoryId],
  );
  // mysql2 execute resolve 值是 [rows, fields] 元组；先取行数组再使用。
  const payload = Array.isArray(result) ? result[0] : [];
  const rows = (Array.isArray(payload) ? payload : []) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export type { SpecAnchorFeature };

/** P0 措辞锚定：读取最新 spec 版本的场景级全文（分析前调用，未变行为要求 AI 逐字沿用）。加载失败由调用方降级处理。
 * 变体治理 A1：锚有 24k 字符上限，按 position 装入时受影响功能可能被截断在窗外（无锚可沿用 → 模型重推导、重编号）。
 * 传入 prioritize（受影响功能名）时把这些功能稳定排到最前，保证 24k 预算先覆盖它们。 */
/** 上一版规格的语言（072）：null = 无历史版本。语言切换检测据此强制全量重建。 */
export async function loadLatestSpecVersionLanguage(repositoryId: number, execute: Execute = defaultExecute): Promise<"zh-CN" | "en" | null> {
  const result = await execute(
    `SELECT sv.output_language AS outputLanguage FROM spec_versions sv
     JOIN analysis_runs r ON r.id = sv.analysis_run_id
     WHERE r.repository_id = ? ORDER BY sv.id DESC LIMIT 1`,
    [repositoryId],
  );
  const payload = Array.isArray(result) ? result[0] : [];
  const row = (Array.isArray(payload) ? payload : [])[0] as { outputLanguage?: string } | undefined;
  if (!row) return null;
  return row.outputLanguage === "en" ? "en" : "zh-CN";
}

/* 变体治理 A1：锚有 24k 字符上限，按 position 装入时受影响功能可能被截断在窗外（无锚可沿用 → 模型重推导、重编号）。
 * 传入 prioritize（受影响功能名）时把这些功能稳定排到最前，保证 24k 预算先覆盖它们。 */
export async function loadPreviousSpecText(repositoryId: number, execute: Execute = defaultExecute, prioritize: readonly string[] = []): Promise<SpecAnchorFeature[]> {
  const versionResult = await execute(
    "SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1",
    [repositoryId],
  );
  const versionPayload = Array.isArray(versionResult) ? versionResult[0] : [];
  const version = (Array.isArray(versionPayload) ? versionPayload : [])[0] as { id: number } | undefined;
  if (!version) return [];

  const featureResult = await execute(
    "SELECT id, name, summary FROM spec_features WHERE spec_version_id = ? ORDER BY position",
    [version.id],
  );
  const featurePayload = Array.isArray(featureResult) ? featureResult[0] : [];
  const featureRows = (Array.isArray(featurePayload) ? featurePayload : []) as Array<{ id: number; name: string; summary: string }>;
  if (featureRows.length === 0) return [];

  const ids = featureRows.map((feature) => feature.id);
  const placeholders = ids.map(() => "?").join(",");
  const scenarioResult = await execute(
    `SELECT spec_feature_id AS featureId, reference, context, action, outcome, category, step_order AS step
     FROM spec_scenarios WHERE spec_feature_id IN (${placeholders})`,
    ids,
  );
  const scenarioPayload = Array.isArray(scenarioResult) ? scenarioResult[0] : [];
  const scenarioRows = (Array.isArray(scenarioPayload) ? scenarioPayload : []) as Array<{ featureId: number; reference: string; context: string; action: string; outcome: string; category: string; step: number | null }>;

  const load = (feature: { id: number; name: string; summary: string }) => ({
    name: feature.name,
    summary: feature.summary,
    scenarios: scenarioRows
      .filter((scenario) => scenario.featureId === feature.id)
      .map((scenario) => ({ reference: scenario.reference, context: scenario.context, action: scenario.action, outcome: scenario.outcome, category: scenario.category, step: scenario.step })),
  });
  // 稳定定向：受影响功能（按 prioritize 顺序）排最前，其余保持 position 序。
  const prioritizedKeys = new Set(prioritize.map((name) => name.trim().toLowerCase()));
  const head = featureRows.filter((feature) => prioritizedKeys.has(feature.name.trim().toLowerCase()));
  const tail = featureRows.filter((feature) => !prioritizedKeys.has(feature.name.trim().toLowerCase()));
  return [...head, ...tail].map(load);
}

/** BM-10：读取最新 spec 版本的完整功能集（含场景与证据），供零行为变更窗口整体沿用。无版本返回 null。 */
export async function loadLatestSpecFeatures(repositoryId: number, execute: Execute = defaultExecute): Promise<{ specVersionId: number; features: SpecFeature[] } | null> {
  const versionResult = await execute("SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1", [repositoryId]);
  const versionPayload = Array.isArray(versionResult) ? versionResult[0] : versionResult;
  const version = (versionPayload as Array<{ id: number }> | undefined)?.[0];
  if (!version) return null;
  const featureResult = await execute(
    "SELECT id, name, summary, parent_key AS parentKey, source FROM spec_features WHERE spec_version_id = ? ORDER BY position",
    [version.id],
  );
  const featurePayload = Array.isArray(featureResult) ? featureResult[0] : featureResult;
  const featureRows = (featurePayload ?? []) as FeatureRow[];
  const scenarioResult = await execute(
    `SELECT spec_feature_id AS featureId, reference, context, action, outcome, category, step_order AS step, source, evidence
     FROM spec_scenarios WHERE spec_feature_id IN (${featureRows.map(() => "?").join(",") || "NULL"})`,
    featureRows.map((feature) => feature.id),
  );
  const scenarioPayload = Array.isArray(scenarioResult) ? scenarioResult[0] : scenarioResult;
  const scenarioRows = (scenarioPayload ?? []) as ScenarioRow[];
  if (featureRows.length === 0) return null;
  return { specVersionId: version.id, features: featuresFromRows(featureRows, scenarioRows) };
}
