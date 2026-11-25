import { createHash } from "node:crypto";
import { isImplementationSurfaceFile } from "../evidence";
import { genericDetector, findDynamicRegistrationLines, matchesGenericPath } from "./detectors/generic";
import { matchesNextPath, nextDetector } from "./detectors/next";
import type { BehaviorDetector, BehaviorUnitDraft, InventorySource } from "./detectors/types";
import { assertRangesWithin, subtractRanges } from "./ranges";
import { compareCodePoints, makeAnchorKey, makeUnitKey, normalizeCodeRanges, normalizeLineRanges } from "./identity";
import type {
  BehaviorAnchor,
  BehaviorAnchorLocator,
  BehaviorInventoryDiagnostics,
  BehaviorUnit,
  BehaviorUnitLocator,
  CodeRange,
  LineRange,
} from "./types";

export type { BehaviorInventoryDiagnostics } from "./types";

export type { BehaviorDetector, BehaviorUnitDraft, InventorySource } from "./detectors/types";

/** schema v2：manifest 持久化 diagnostics（detector 失败面 / unreadablePaths / eligibleRanges）。
 *  v1 manifest 不含该字段，hash 校验会拒绝旧 manifest（显式失败，不静默重用）。 */
export const INVENTORY_SCHEMA_VERSION = "2";

const RESIDUAL_DETECTOR: Pick<BehaviorDetector, "id" | "version"> = { id: "residual", version: "1" };

/** 剩余实现面兜底检测器 id（Task 14：编排层据此区分语义单元与兜底单元）。 */
export const RESIDUAL_DETECTOR_ID = RESIDUAL_DETECTOR.id;

export interface BehaviorDetectorRegistryEntry {
  detector: BehaviorDetector;
  matches: (path: string) => boolean;
}

const DETECTOR_REGISTRY: BehaviorDetectorRegistryEntry[] = [
  { detector: nextDetector, matches: matchesNextPath },
  { detector: genericDetector, matches: matchesGenericPath },
];

function registryVersionOf(registry: readonly BehaviorDetectorRegistryEntry[]): string {
  return [
    ...registry.map(({ detector }) => `${detector.id}@${detector.version}`),
    `${RESIDUAL_DETECTOR.id}@${RESIDUAL_DETECTOR.version}`,
  ]
    .sort(compareCodePoints)
    .join("+");
}

export const DETECTOR_REGISTRY_VERSION = registryVersionOf(DETECTOR_REGISTRY);

export interface BuildInventoryInput {
  afterSha: string;
  scopeRoots?: readonly string[];
  sources: readonly InventorySource[];
}

export interface BehaviorInventoryResult {
  inventorySchemaVersion: string;
  detectorRegistryVersion: string;
  afterSha: string;
  scopeFingerprint: string;
  units: BehaviorUnit[];
  diagnostics: BehaviorInventoryDiagnostics;
}

/**
 * 范围指纹（C）：eligible 实现面路径集合 + scopeRoots 的确定性哈希。扫描期与恢复期共用
 * 同一实现——恢复时只按目录枚举重算（不读文件内容），与持久化 manifest 的指纹比对，
 * 不一致即 inventory_version_conflict，绝不静默重扫自愈。
 */
export function computeScopeFingerprint(paths: readonly string[], scopeRoots: readonly string[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        paths: [...paths].sort(compareCodePoints),
        scopeRoots: [...scopeRoots].sort(compareCodePoints),
      }),
      "utf8",
    )
    .digest("hex");
}

/** 定位符空串统一归一为 null：空串与缺省在身份里同义，不允许两种形态并存。 */
function cleanText(value: string | null | undefined): string | null {
  return value == null || value === "" ? null : value;
}

function cleanLocator(locator: BehaviorUnitLocator): BehaviorUnitLocator {
  return {
    ...locator,
    path: cleanText(locator.path) ?? undefined,
    route: cleanText(locator.route),
    method: cleanText(locator.method),
    registrationId: cleanText(locator.registrationId),
    registrationPath: cleanText(locator.registrationPath),
    exportPath: cleanText(locator.exportPath),
    symbol: cleanText(locator.symbol),
    signature: cleanText(locator.signature),
    anonymousAt: locator.anonymousAt ?? null,
    chunk: locator.chunk ?? null,
    occurrenceOrdinal: locator.occurrenceOrdinal ?? null,
    displayName: null,
  };
}

function codeRangesOf(path: string, ranges: readonly LineRange[]): CodeRange[] {
  return ranges.map((range) => ({ path, startLine: range.startLine, endLine: range.endLine }));
}

interface FinalizedUnit {
  unit: BehaviorUnit;
  locator: BehaviorUnitLocator;
  anchorLocators: BehaviorAnchorLocator[];
}

/**
 * 草稿转正式单元：规范化定位符与区间、生成 key、为未被 behavior/implicit_review
 * 覆盖的主区间自动补 coarse implicit_review（entry 不能替代内部审查）。
 */
function finalizeUnit(
  draft: BehaviorUnitDraft,
  detector: Pick<BehaviorDetector, "id" | "version">,
): FinalizedUnit {
  const locator = cleanLocator(draft.locator);
  const primaryRanges = draft.primaryRanges == null ? null : normalizeLineRanges(draft.primaryRanges);
  const anchors = draft.anchors.map((anchor) => ({ ...anchor, symbol: cleanText(anchor.symbol) }));

  if (primaryRanges != null) {
    const covered = anchors
      .filter((anchor) => anchor.role !== "entry")
      .flatMap((anchor) => codeRangesOf(draft.primaryPath, anchor.ranges));
    const remainder = subtractRanges(codeRangesOf(draft.primaryPath, primaryRanges), covered);
    for (const range of remainder) {
      anchors.push({
        role: "implicit_review",
        symbol: null,
        ranges: [{ startLine: range.startLine, endLine: range.endLine }],
        evidence: [{ path: draft.primaryPath, startLine: range.startLine }],
        coarse: true,
      });
    }
    const reviewRanges = anchors
      .filter((anchor) => anchor.role !== "entry")
      .flatMap((anchor) => codeRangesOf(draft.primaryPath, anchor.ranges));
    assertRangesWithin(reviewRanges, codeRangesOf(draft.primaryPath, primaryRanges));
  }

  const anchorLocators: BehaviorAnchorLocator[] = anchors.map((anchor) => ({
    role: anchor.role,
    path: draft.primaryPath,
    symbol: anchor.symbol ?? null,
    anonymousAt: anchor.anonymousAt ?? null,
    ranges: normalizeLineRanges(anchor.ranges),
  }));

  const finalizedAnchors: BehaviorAnchor[] = anchors.map((anchor, index) => ({
    anchorKey: makeAnchorKey(anchorLocators[index]),
    role: anchor.role,
    ranges: anchorLocators[index].ranges,
    evidence: anchor.evidence ?? [],
    coarse: anchor.coarse,
  }));
  const order = finalizedAnchors
    .map((anchor, index) => ({ anchor, index }))
    .sort((a, b) => compareCodePoints(a.anchor.anchorKey, b.anchor.anchorKey));

  return {
    unit: {
      unitKey: makeUnitKey(locator),
      kind: locator.kind,
      primaryPath: draft.primaryPath,
      primaryRanges,
      contextRanges: [],
      anchors: order.map(({ anchor }) => anchor),
      detector: detector.id,
      detectorVersion: detector.version,
    },
    locator,
    anchorLocators: order.map(({ index }) => anchorLocators[index]),
  };
}

/** 同 key 冲突按 (primaryPath, 首行, key) 确定性排序后追加 occurrence ordinal，禁止静默覆盖。 */
function resolveUnitKeyCollisions(units: FinalizedUnit[]): void {
  const groups = new Map<string, number[]>();
  units.forEach(({ unit }, index) => {
    const group = groups.get(unit.unitKey) ?? [];
    group.push(index);
    groups.set(unit.unitKey, group);
  });
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const unitA = units[a].unit;
      const unitB = units[b].unit;
      return (
        compareCodePoints(unitA.primaryPath, unitB.primaryPath) ||
        (unitA.primaryRanges?.[0]?.startLine ?? 0) - (unitB.primaryRanges?.[0]?.startLine ?? 0) ||
        compareCodePoints(unitA.unitKey, unitB.unitKey)
      );
    });
    group.forEach((unitIndex, ordinalIndex) => {
      const entry = units[unitIndex];
      entry.locator = { ...entry.locator, occurrenceOrdinal: ordinalIndex + 1 };
      entry.unit = { ...entry.unit, unitKey: makeUnitKey(entry.locator) };
    });
  }
}

/** 跨单元锚点 key 冲突同样按序追加 occurrence ordinal（如重复注册的同一 handler）。 */
function resolveAnchorKeyCollisions(units: FinalizedUnit[]): void {
  const groups = new Map<string, Array<{ unitIndex: number; anchorIndex: number }>>();
  units.forEach(({ unit }, unitIndex) => {
    unit.anchors.forEach((anchor, anchorIndex) => {
      const group = groups.get(anchor.anchorKey) ?? [];
      group.push({ unitIndex, anchorIndex });
      groups.set(anchor.anchorKey, group);
    });
  });
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort(
      (a, b) =>
        compareCodePoints(units[a.unitIndex].unit.unitKey, units[b.unitIndex].unit.unitKey) ||
        compareCodePoints(
          units[a.unitIndex].unit.anchors[a.anchorIndex].anchorKey,
          units[b.unitIndex].unit.anchors[b.anchorIndex].anchorKey,
        ),
    );
    group.forEach(({ unitIndex, anchorIndex }, ordinalIndex) => {
      const entry = units[unitIndex];
      const anchor = entry.unit.anchors[anchorIndex];
      const locator: BehaviorAnchorLocator = {
        ...entry.anchorLocators[anchorIndex],
        occurrenceOrdinal: ordinalIndex + 1,
      };
      const anchors = [...entry.unit.anchors];
      anchors[anchorIndex] = { ...anchor, anchorKey: makeAnchorKey(locator) };
      const anchorLocators = [...entry.anchorLocators];
      anchorLocators[anchorIndex] = locator;
      entry.unit = { ...entry.unit, anchors };
      entry.anchorLocators = anchorLocators;
    });
  }
}

function assertUniqueKeys(units: readonly FinalizedUnit[]): void {
  const unitKeys = new Set<string>();
  const anchorKeys = new Set<string>();
  for (const { unit } of units) {
    if (unitKeys.has(unit.unitKey)) throw new Error(`behavior inventory key collision: ${unit.unitKey}`);
    unitKeys.add(unit.unitKey);
    for (const anchor of unit.anchors) {
      if (anchorKeys.has(anchor.anchorKey)) throw new Error(`behavior inventory key collision: ${anchor.anchorKey}`);
      anchorKeys.add(anchor.anchorKey);
    }
  }
}

function lineCountOf(content: string): number {
  return content.split("\n").length;
}

/** 未被语义单元主覆盖的实现区间生成剩余单元；整文件未认领用 file，部分区间用 symbol_range chunk。 */
function buildResidualUnits(
  eligible: readonly InventorySource[],
  semanticUnits: readonly BehaviorUnit[],
): FinalizedUnit[] {
  const eligibleRanges = eligible.map((source) => ({
    path: source.path,
    startLine: 1,
    endLine: lineCountOf(source.content),
  }));
  const semanticPrimary = semanticUnits.flatMap((unit) => codeRangesOf(unit.primaryPath, unit.primaryRanges ?? []));
  const residualRanges = subtractRanges(eligibleRanges, semanticPrimary);
  const claimedPaths = new Set(semanticUnits.map((unit) => unit.primaryPath));

  return residualRanges.map((range) => {
    const wholeFile = !claimedPaths.has(range.path);
    const locator: BehaviorUnitLocator = wholeFile
      ? { kind: "file", path: range.path }
      : { kind: "symbol_range", path: range.path, chunk: { startLine: range.startLine, endLine: range.endLine } };
    return finalizeUnit(
      {
        locator,
        primaryPath: range.path,
        primaryRanges: [{ startLine: range.startLine, endLine: range.endLine }],
        anchors: [
          {
            role: "implicit_review",
            ranges: [{ startLine: range.startLine, endLine: range.endLine }],
            evidence: [{ path: range.path, startLine: range.startLine }],
            coarse: true,
          },
        ],
      },
      RESIDUAL_DETECTOR,
    );
  });
}

/**
 * 不可读文件的占位单元（L）：primaryRanges=null、零区间 coarse implicit_review 锚点。
 * 占位单元不生成执行任务（planner 对 null primaryRanges 返回空），由覆盖/激活门禁
 * fail closed——文件恢复可读后新 run 重扫自动消除，绝不伪造区间或静默跳过。
 */
function buildUnreadablePlaceholder(source: InventorySource): FinalizedUnit {
  return finalizeUnit(
    {
      locator: { kind: "file", path: source.path },
      primaryPath: source.path,
      primaryRanges: null,
      anchors: [
        {
          role: "implicit_review",
          ranges: [],
          evidence: [{ path: source.path }],
          coarse: true,
        },
      ],
    },
    RESIDUAL_DETECTOR,
  );
}

/**
 * 结构不变量（A）：同文件内各单元的主区间两两不相交。单元是执行与归因的身份单元，
 * 同一行被两个单元认领会让结算与覆盖核销双计；任何重叠都是检测器缺陷，直接显式失败。
 */
function assertPrimaryRangesDisjoint(units: readonly BehaviorUnit[]): void {
  const byPath = new Map<string, Array<{ startLine: number; endLine: number; unitKey: string }>>();
  for (const unit of units) {
    for (const range of unit.primaryRanges ?? []) {
      const list = byPath.get(unit.primaryPath) ?? [];
      list.push({ startLine: range.startLine, endLine: range.endLine, unitKey: unit.unitKey });
      byPath.set(unit.primaryPath, list);
    }
  }
  for (const [path, ranges] of byPath) {
    ranges.sort(
      (a, b) => a.startLine - b.startLine || a.endLine - b.endLine || compareCodePoints(a.unitKey, b.unitKey),
    );
    for (let index = 1; index < ranges.length; index += 1) {
      const previous = ranges[index - 1];
      const current = ranges[index];
      if (current.startLine <= previous.endLine) {
        throw new Error(
          `behavior inventory primary range overlap in ${path}: ${previous.unitKey} ` +
            `[${previous.startLine},${previous.endLine}] vs ${current.unitKey} [${current.startLine},${current.endLine}]`,
        );
      }
    }
  }
}

export function buildBehaviorInventory(input: BuildInventoryInput): BehaviorInventoryResult {
  return buildBehaviorInventoryWithRegistry(input, DETECTOR_REGISTRY);
}

/** registry 注入入口：默认走 DETECTOR_REGISTRY，测试可注入检测器以构造确定性失败。 */
export function buildBehaviorInventoryWithRegistry(
  input: BuildInventoryInput,
  registry: readonly BehaviorDetectorRegistryEntry[],
): BehaviorInventoryResult {
  const eligible: InventorySource[] = [];
  const excludedNonImplementation: string[] = [];
  // 迁移脚本已移出分析目标：首跑扫描按实现面枚举，本来就不会把它交进来；这里是第二道拦。
  // 它和测试、文档一样记进 excludedNonImplementation——这个字段的意思是「不在实现面里」。
  for (const source of input.sources) {
    if (isImplementationSurfaceFile(source.path)) eligible.push(source);
    else excludedNonImplementation.push(source.path);
  }

  // L：读取失败的文件不进入检测器与残余兜底——为其生成零区间占位单元并记入 unreadablePaths；
  // 残余清单与 eligibleRanges 只覆盖可读实现面，占位单元以零任务阻断激活直到文件可读。
  const readable = eligible.filter((source) => source.unreadable !== true);
  const unreadable = eligible.filter((source) => source.unreadable === true);

  const detectorUnsupported = new Set<string>();
  const detectorParseFailure = new Set<string>();
  const dynamicRegistrationFallback = new Set<string>();
  const semanticUnits: FinalizedUnit[] = [];

  for (const source of readable) {
    const entry = registry.find(({ matches }) => matches(source.path));
    try {
      // 动态扫描与 detect/finalize 同属每文件失败边界：区间解析抛错按 parse failure 整文件回退，不得逃逸。
      if (findDynamicRegistrationLines(source).length > 0) dynamicRegistrationFallback.add(source.path);
      if (entry == null) {
        if (!dynamicRegistrationFallback.has(source.path)) detectorUnsupported.add(source.path);
        continue;
      }
      // 每个文件原子提交：任一草稿 finalize 失败时整文件不保留语义单元，统一交剩余清单。
      const buffered = entry.detector.detect(source).map((draft) => finalizeUnit(draft, entry.detector));
      semanticUnits.push(...buffered);
    } catch {
      detectorParseFailure.add(source.path);
    }
  }

  // detect/finalize 要么整文件成功要么抛错，解析失败的文件不会留下半成品单元，整文件交给剩余清单。
  const finalized = [
    ...semanticUnits,
    ...buildResidualUnits(readable, semanticUnits.map(({ unit }) => unit)),
    ...unreadable.map(buildUnreadablePlaceholder),
  ];

  resolveUnitKeyCollisions(finalized);
  resolveAnchorKeyCollisions(finalized);
  assertUniqueKeys(finalized);
  const units = finalized.map(({ unit }) => unit).sort((a, b) => compareCodePoints(a.unitKey, b.unitKey));
  assertPrimaryRangesDisjoint(units);

  // eligibleRanges 由实现面枚举独立计算（K）：覆盖判定的真源不来自单元自身声明。
  const eligibleRanges = normalizeCodeRanges(
    readable.map((source) => ({
      path: source.path,
      startLine: 1,
      endLine: lineCountOf(source.content),
    })),
  );
  const allPrimary = units.flatMap((unit) => codeRangesOf(unit.primaryPath, unit.primaryRanges ?? []));
  const omitted = subtractRanges(eligibleRanges, allPrimary);

  const scopeRoots = [...(input.scopeRoots ?? ["."])].sort(compareCodePoints);
  const scopeFingerprint = computeScopeFingerprint(
    eligible.map((source) => source.path),
    scopeRoots,
  );

  const sortStrings = (values: Iterable<string>): string[] => [...values].sort(compareCodePoints);
  const residualCount = units.filter((unit) => unit.detector === RESIDUAL_DETECTOR.id).length;
  const diagnostics: BehaviorInventoryDiagnostics = {
    detectorUnsupported: sortStrings(detectorUnsupported),
    detectorParseFailure: sortStrings(detectorParseFailure),
    dynamicRegistrationFallback: sortStrings(dynamicRegistrationFallback),
    excludedNonImplementation: sortStrings(excludedNonImplementation),
    unreadablePaths: sortStrings(unreadable.map((source) => source.path)),
    eligibleRanges,
    fallbackInventorySuccess: omitted.length === 0,
    semanticUnits: units.length - residualCount,
    residualUnits: residualCount,
  };

  return {
    inventorySchemaVersion: INVENTORY_SCHEMA_VERSION,
    detectorRegistryVersion: registryVersionOf(registry),
    afterSha: input.afterSha,
    scopeFingerprint,
    units,
    diagnostics,
  };
}
