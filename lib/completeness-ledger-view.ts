/**
 * R1 分析完整性账本的展示层（纯函数、零依赖）：客户端组件只能 import 本模块与
 * lib/completeness-ledger.ts 的类型——后者含 saveCompletenessLedger 等服务端函数，
 * 若未来引入 db import 会把 mysql2 拖进浏览器 bundle（regression-tasks 先例）。
 */
import { pick, type LocaleEntry, type UiLocale } from "./ui-locale";
import { LEDGER } from "./ui-strings/product";

export type LedgerStateView = "complete" | "partial" | "failed" | "not_applicable";

export interface LedgerDimensionView {
  state: LedgerStateView;
}

export interface LedgerDetailsView {
  sourceCoverage: LedgerDimensionView;
  behavioralEnumeration: LedgerDimensionView;
  extractionCompletion: LedgerDimensionView;
  evidenceIntegrity: LedgerDimensionView;
  mergeIntegrity: LedgerDimensionView;
  verification: LedgerDimensionView;
  overall: LedgerStateView;
}

const LEDGER_DIMENSION_ENTRIES: Record<keyof Omit<LedgerDetailsView, "overall">, LocaleEntry> = {
  sourceCoverage: LEDGER.dimSourceCoverage,
  behavioralEnumeration: LEDGER.dimBehavioralEnumeration,
  extractionCompletion: LEDGER.dimExtractionCompletion,
  evidenceIntegrity: LEDGER.dimEvidenceIntegrity,
  mergeIntegrity: LEDGER.dimMergeIntegrity,
  verification: LEDGER.dimVerification,
};

export const LEDGER_DIMENSION_LABELS: Record<keyof Omit<LedgerDetailsView, "overall">, string> = {
  sourceCoverage: "源码覆盖",
  behavioralEnumeration: "行为枚举",
  extractionCompletion: "提取完成度",
  evidenceIntegrity: "证据完整性",
  mergeIntegrity: "合并完整性",
  verification: "核验",
};

/** 按 locale 取维度标签（缺省 zh-CN 与 LEDGER_DIMENSION_LABELS 一致）。 */
function ledgerDimensionLabel(key: keyof Omit<LedgerDetailsView, "overall">, locale: UiLocale): string {
  return pick(locale, LEDGER_DIMENSION_ENTRIES[key]);
}

/** 各维度 partial/failed 时的短因（与 lib/completeness-ledger.ts 的推导输入对应，措辞按实际交付语义）。 */
const DIMENSION_REASON_ENTRIES: Record<keyof Omit<LedgerDetailsView, "overall">, LocaleEntry> = {
  sourceCoverage: LEDGER.reasonSourceCoverage,
  behavioralEnumeration: LEDGER.reasonBehavioralEnumeration,
  extractionCompletion: LEDGER.reasonExtractionCompletion,
  evidenceIntegrity: LEDGER.reasonEvidenceIntegrity,
  mergeIntegrity: LEDGER.reasonMergeIntegrity,
  verification: LEDGER.reasonVerification,
};

/** 六维度徽章顺序。 */
export const LEDGER_DIMENSION_ORDER = ["sourceCoverage", "behavioralEnumeration", "extractionCompletion", "evidenceIntegrity", "mergeIntegrity", "verification"] as const;

export type LedgerDimensionKey = (typeof LEDGER_DIMENSION_ORDER)[number];

/** overall 的展示文案：complete 不夸大（「完整」仅指账本六维度全绿），失败如实列维度。 */
export function describeLedgerOverall(overall: LedgerStateView, locale: UiLocale = "zh-CN"): { label: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (overall === "complete") return { label: pick(locale, LEDGER.overallComplete), tone: "ok" };
  if (overall === "partial") return { label: pick(locale, LEDGER.overallPartial), tone: "warn" };
  if (overall === "failed") return { label: pick(locale, LEDGER.overallFailed), tone: "bad" };
  return { label: pick(locale, LEDGER.overallNotApplicable), tone: "muted" };
}

/** 非 complete/not_applicable 维度的「标签：短因」清单，partial/failed 展示用；全绿返回空数组。
 * hideDimensions：已在别处给出事实的维度不重复内联（如源码覆盖——覆盖率披露行已给量化数字，维度状态仍在悬浮明细可见）。 */
export function summarizeLedgerIssues(details: LedgerDetailsView, hideDimensions?: ReadonlyArray<LedgerDimensionKey>, locale: UiLocale = "zh-CN"): Array<{ label: string; state: LedgerStateView; reason: string }> {
  const hidden = new Set(hideDimensions ?? []);
  return LEDGER_DIMENSION_ORDER
    .filter((key) => !hidden.has(key) && (details[key].state === "partial" || details[key].state === "failed"))
    .map((key) => ({ label: ledgerDimensionLabel(key, locale), state: details[key].state, reason: pick(locale, DIMENSION_REASON_ENTRIES[key]) }));
}

/** 六维度「标签 状态」行，title 悬浮明细用。 */
export function formatLedgerDimensions(details: LedgerDetailsView, locale: UiLocale = "zh-CN"): string {
  return LEDGER_DIMENSION_ORDER.map((key) => `${ledgerDimensionLabel(key, locale)} ${details[key].state === "complete" ? "✓" : details[key].state === "not_applicable" ? "—" : details[key].state === "partial" ? pick(locale, LEDGER.statePartial) : pick(locale, LEDGER.stateFailed)}`).join(" · ");
}

const LEDGER_STATES: readonly LedgerStateView[] = ["complete", "partial", "failed", "not_applicable"];

/** 解析账本 details JSON（saveCompletenessLedger 写入的完整账本对象）为视图形状；结构不符返回 null（防御历史/异常行）。 */
export function toLedgerDetailsView(details: unknown): LedgerDetailsView | null {
  if (typeof details !== "object" || details === null) return null;
  const raw = details as Record<string, unknown>;
  const view: Partial<LedgerDetailsView> = {};
  for (const key of [...LEDGER_DIMENSION_ORDER]) {
    const state = (raw[key] as { state?: unknown } | undefined)?.state;
    if (typeof state !== "string" || !LEDGER_STATES.includes(state as LedgerStateView)) return null;
    view[key] = { state: state as LedgerStateView };
  }
  if (typeof raw.overall !== "string" || !LEDGER_STATES.includes(raw.overall as LedgerStateView)) return null;
  view.overall = raw.overall as LedgerStateView;
  return view as LedgerDetailsView;
}
