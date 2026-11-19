import { createHash } from "node:crypto";
import { evidenceKind } from "../evidence";
import { genericDetector, findDynamicRegistrationLines, matchesGenericPath } from "./detectors/generic";
import { matchesNextPath, nextDetector } from "./detectors/next";
import type { BehaviorDetector, BehaviorUnitDraft, InventorySource } from "./detectors/types";
import { assertRangesWithin, subtractRanges } from "./ranges";
import { compareCodePoints, makeAnchorKey, makeUnitKey, normalizeLineRanges } from "./identity";
import type {
  BehaviorAnchor,
  BehaviorAnchorLocator,
  BehaviorUnit,
  BehaviorUnitLocator,
  CodeRange,
  LineRange,
} from "./types";

export type { BehaviorDetector, BehaviorUnitDraft, InventorySource } from "./detectors/types";

export const INVENTORY_SCHEMA_VERSION = "1";

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

export interface BehaviorInventoryDiagnostics {
  detectorUnsupported: string[];
  detectorParseFailure: string[];
  dynamicRegistrationFallback: string[];
  excludedNonImplementation: string[];
  fallbackInventorySuccess: boolean;
  semanticUnits: number;
  residualUnits: number;
}

export interface BehaviorInventoryResult {
  inventorySchemaVersion: string;
  detectorRegistryVersion: string;
  afterSha: string;
  scopeFingerprint: string;
  units: BehaviorUnit[];
  diagnostics: BehaviorInventoryDiagnostics;
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
  for (const source of input.sources) {
    if (evidenceKind(source.path) === "implementation") eligible.push(source);
    else excludedNonImplementation.push(source.path);
  }

  const detectorUnsupported = new Set<string>();
  const detectorParseFailure = new Set<string>();
  const dynamicRegistrationFallback = new Set<string>();
  const semanticUnits: FinalizedUnit[] = [];

  for (const source of eligible) {
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
    ...buildResidualUnits(eligible, semanticUnits.map(({ unit }) => unit)),
  ];

  resolveUnitKeyCollisions(finalized);
  resolveAnchorKeyCollisions(finalized);
  assertUniqueKeys(finalized);
  const units = finalized.map(({ unit }) => unit).sort((a, b) => compareCodePoints(a.unitKey, b.unitKey));

  const eligibleRanges = eligible.map((source) => ({
    path: source.path,
    startLine: 1,
    endLine: lineCountOf(source.content),
  }));
  const allPrimary = units.flatMap((unit) => codeRangesOf(unit.primaryPath, unit.primaryRanges ?? []));
  const omitted = subtractRanges(eligibleRanges, allPrimary);

  const scopeRoots = [...(input.scopeRoots ?? ["."])].sort(compareCodePoints);
  const scopeFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        paths: eligible.map((source) => source.path).sort(compareCodePoints),
        scopeRoots,
      }),
      "utf8",
    )
    .digest("hex");

  const sortStrings = (values: Iterable<string>): string[] => [...values].sort(compareCodePoints);
  const residualCount = units.filter((unit) => unit.detector === RESIDUAL_DETECTOR.id).length;
  const diagnostics: BehaviorInventoryDiagnostics = {
    detectorUnsupported: sortStrings(detectorUnsupported),
    detectorParseFailure: sortStrings(detectorParseFailure),
    dynamicRegistrationFallback: sortStrings(dynamicRegistrationFallback),
    excludedNonImplementation: sortStrings(excludedNonImplementation),
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
