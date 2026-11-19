import { z } from "zod";
import { requestStructuredCompletion, systemPrompt, type LlmBillingContext } from "./ai";
import type { OutputLanguage } from "./analysis-language";
import { compareCodePoints } from "./behavior-inventory/identity";
import { PRODUCT_SUMMARY_ATTEMPT_ID, settleBehaviorBudget, type BudgetReservation } from "./behavior-run-budget";
import type { BehaviorUnitStatus } from "./behavior-unit-state";
import type { Evidence } from "./types";

/**
 * Task 12 · 最终映射与激活门禁（设计 D8/D10，§5.3/§7）：
 *
 * - evaluateBehaviorActivationGate：D8 激活公式的纯函数判定。七个独立检查各自成闸门，
 *   全部通过才允许激活；任一不通过即整体拒绝（fail closed）。entry 锚点只用于定位、
 *   不进入锚点核算；covered_elsewhere 的关联合并后必须仍可解析，丢失即该锚点回到
 *   unresolved、门禁失败。纯函数：不读数据库、不调 AI。
 * - resolveProductDescription：D10 产品摘要生成与降级。摘要成功 → generated；失败时
 *   仅在语言未切换时沿用旧简介（preserved），否则 unavailable（空描述，绝不留旧语种
 *   文本）。摘要证据只取合并面内的路径，面外证据一律剔除，全面外视同失败（不加新
 *   事实）。独立预留统一走 settleBehaviorBudget 结算：成功失败都结算一次，绝不调用
 *   releaseUnusedBehaviorBudget（summary_reserved 复位未实现，Task 7 review 结论）；
 *   结算抛出（含 behavior_budget_usage_unknown 硬阻断）直接透传。
 */

export interface ActivationGateAnchor {
  anchorKey: string;
  role: "entry" | "behavior" | "implicit_review";
  disposition: "extracted" | "reviewed_internal" | "unresolved";
  internalKind?: string;
  evidence: readonly unknown[];
  /** covered_elsewhere 的关联目标（合并后需仍可解析）。 */
  relatedUnitKeys?: readonly string[];
  relatedScenarioRefs?: readonly string[];
}

export interface ActivationGateInput {
  manifestValid: boolean;
  primaryCoverageComplete: boolean;
  anchorCoverageComplete: boolean;
  anchors: readonly ActivationGateAnchor[];
  unitStatuses: readonly BehaviorUnitStatus[];
  /** 合并后存活的单元/局部场景身份集合（covered_elsewhere 关联解析面）。 */
  survivingUnitKeys: ReadonlySet<string>;
  survivingScenarioRefs: ReadonlySet<string>;
  existingEvidenceChecksPassed: boolean;
  existingMergeChecksPassed: boolean;
}

export interface ActivationGateResult {
  activate: boolean;
  checks: {
    inventoryManifestValid: boolean;
    primaryCoverageComplete: boolean;
    anchorCoverageComplete: boolean;
    anchorAccountingComplete: boolean;
    allUnitsInAllowedTerminalStates: boolean;
    existingEvidenceChecksPassed: boolean;
    existingMergeChecksPassed: boolean;
  };
  unaccountedAnchorKeys: string[];
}

const ALLOWED_TERMINAL_STATUSES: ReadonlySet<BehaviorUnitStatus> = new Set(["extracted", "no_behavior"]);

/** 单个可归因锚点的核算判定；unaccounted 的原因只经返回 false 体现（明细由 unaccountedAnchorKeys 承载）。 */
function anchorAccounted(anchor: ActivationGateAnchor, input: ActivationGateInput): boolean {
  if (anchor.disposition === "extracted") return true;
  if (anchor.disposition !== "reviewed_internal") return false;
  if (!anchor.internalKind || anchor.evidence.length === 0) return false;
  if (anchor.internalKind === "covered_elsewhere") {
    const unitSurvives = (anchor.relatedUnitKeys ?? []).some((key) => input.survivingUnitKeys.has(key));
    const scenarioSurvives = (anchor.relatedScenarioRefs ?? []).some((ref) => input.survivingScenarioRefs.has(ref));
    return unitSurvives || scenarioSurvives;
  }
  return true;
}

export function evaluateBehaviorActivationGate(input: ActivationGateInput): ActivationGateResult {
  const unaccountedAnchorKeys = input.anchors
    .filter((anchor) => anchor.role !== "entry" && !anchorAccounted(anchor, input))
    .map((anchor) => anchor.anchorKey)
    .sort(compareCodePoints);
  const checks = {
    inventoryManifestValid: input.manifestValid,
    primaryCoverageComplete: input.primaryCoverageComplete,
    anchorCoverageComplete: input.anchorCoverageComplete,
    anchorAccountingComplete: unaccountedAnchorKeys.length === 0,
    // 空单元清单 fail closed：没有单元可核验时绝不激活
    allUnitsInAllowedTerminalStates: input.unitStatuses.length > 0 && input.unitStatuses.every((status) => ALLOWED_TERMINAL_STATUSES.has(status)),
    existingEvidenceChecksPassed: input.existingEvidenceChecksPassed,
    existingMergeChecksPassed: input.existingMergeChecksPassed,
  };
  return { activate: Object.values(checks).every(Boolean), checks, unaccountedAnchorKeys };
}

export interface ProductDescriptionInput {
  runId: number;
  accountId: number | null;
  /** 最终合并面（规格功能 + 场景证据）；摘要只允许引用该面内的证据路径。 */
  mergedFeatures: readonly { name: string; summary: string; scenarios: readonly { evidence: readonly Evidence[] }[] }[];
  outputLanguage: OutputLanguage;
  /** Task 13 已挂号的独立摘要预留；本函数统一负责结算一次。 */
  reservation: BudgetReservation;
  /** 旧简介（language 为 null 视为无可用语种，语言切换判定按不通过处理）。 */
  previous: { description: string; evidence: Evidence[]; language: OutputLanguage | null } | null;
  /** 可注入的补全通道（测试替身）；默认走结构化补全。 */
  requestCompletion?: (messages: Array<{ role: string; content: string }>, billing?: LlmBillingContext) => Promise<string>;
}

export interface ProductDescriptionOutcome {
  product: { description: string; evidence: Evidence[] };
  status: "generated" | "preserved" | "unavailable";
}

const summarySchema = z.object({
  description: z.string(),
  evidence: z.array(z.object({ path: z.string(), startLine: z.number().optional(), endLine: z.number().optional() })),
});

/** 合并面证据路径集合（面外证据一律剔除——摘要不加新事实）。 */
function mergedSurfacePaths(features: ProductDescriptionInput["mergedFeatures"]): Set<string> {
  const paths = new Set<string>();
  for (const feature of features) {
    for (const scenario of feature.scenarios) {
      for (const item of scenario.evidence) paths.add(item.path);
    }
  }
  return paths;
}

function extractJsonObject(content: string): unknown {
  const stripped = content.replace(/```(?:json)?/gi, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("product summary response is not a JSON object");
  return JSON.parse(stripped.slice(start, end + 1));
}

function summaryUserPrompt(input: ProductDescriptionInput, allowedPaths: ReadonlySet<string>): string {
  const featureLines = input.mergedFeatures.map((feature) => `- ${feature.name}: ${feature.summary}`).join("\n");
  const evidenceLines = [...allowedPaths].sort(compareCodePoints).map((path) => `- ${path}`).join("\n");
  if (input.outputLanguage === "en") {
    return [
      "Write one short product description (at most 200 characters) for this product's audience, based only on the features listed below.",
      "Do not invent capabilities or facts beyond this list.",
      "",
      "Features:",
      featureLines,
      "",
      "You must cite evidence only from these paths (no others):",
      evidenceLines,
      "",
      'Reply with a single JSON object: {"description":"...","evidence":[{"path":"...","startLine":1}]}. At least one evidence item.',
    ].join("\n");
  }
  return [
    "根据下面列出的功能，为这款产品写一段面向其用户群体的简短简介（不超过 200 字）。",
    "不得虚构清单之外的能力或事实。",
    "",
    "功能：",
    featureLines,
    "",
    "证据只能引用以下路径（不得使用其他路径）：",
    evidenceLines,
    "",
    '只回复一个 JSON 对象：{"description":"...","evidence":[{"path":"...","startLine":1}]}。至少一条证据。',
  ].join("\n");
}

export async function resolveProductDescription(input: ProductDescriptionInput): Promise<ProductDescriptionOutcome> {
  const request = input.requestCompletion ?? requestStructuredCompletion;
  const allowedPaths = mergedSurfacePaths(input.mergedFeatures);
  let outcome: ProductDescriptionOutcome;
  try {
    const billing: LlmBillingContext = {
      runId: input.runId,
      accountId: input.accountId,
      chargeComponent: "main",
      attemptId: PRODUCT_SUMMARY_ATTEMPT_ID,
      callStage: "product_summary",
    };
    const content = await request(
      [
        { role: "system", content: systemPrompt(input.outputLanguage) },
        { role: "user", content: summaryUserPrompt(input, allowedPaths) },
      ],
      billing,
    );
    const parsed = summarySchema.parse(extractJsonObject(content));
    const description = parsed.description.trim();
    if (description === "") throw new Error("product summary description is empty");
    const evidence = parsed.evidence.filter((item) => allowedPaths.has(item.path));
    if (evidence.length === 0) throw new Error("product summary evidence outside the merged surface");
    outcome = { product: { description, evidence }, status: "generated" };
  } catch (error) {
    if (input.previous !== null && input.previous.language === input.outputLanguage) {
      console.error("[analysis] product summary failed; preserving previous description", { runId: input.runId, message: error instanceof Error ? error.message : String(error) });
      outcome = { product: { description: input.previous.description, evidence: input.previous.evidence }, status: "preserved" };
    } else {
      // 语言切换（或无旧简介）时绝不保留旧语种文本（D10）
      console.error("[analysis] product_description_unavailable", { runId: input.runId, message: error instanceof Error ? error.message : String(error) });
      outcome = { product: { description: "", evidence: [] }, status: "unavailable" };
    }
  }
  // 摘要预留独立结算（D9/D10）：成功失败都结算一次；结算失败（含 usage 未知硬上限）
  // 直接透传阻断；绝不走 releaseUnused（summary_reserved 复位未实现）。
  await settleBehaviorBudget({ reservationId: input.reservation.reservationId });
  return outcome;
}
