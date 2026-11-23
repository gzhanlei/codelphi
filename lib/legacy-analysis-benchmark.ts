export type LegacyGroundTruthKind = "fact_recall" | "dependency_impact" | "evidence_reconciliation";
export type LegacyBehaviorState = "same" | "changed" | "unknown";

export interface LegacySourceFile {
  path: string;
  content: string;
}

export interface LegacyGroundTruthCase {
  id: string;
  kind: LegacyGroundTruthKind;
  before: LegacySourceFile[];
  after: LegacySourceFile[];
  expected: {
    behaviors: Array<{ id: string; state: LegacyBehaviorState; description: string }>;
    impacted: string[];
    unaffected: string[];
    unknown: Array<{ id: string; resolution: "unknown" }>;
  };
}

export interface LegacyPathMeasurement {
  llmCalls: number;
  totalTokens: number;
  correctedMisses: number;
  falseDeltaRate: number;
  factInterpretationErrors: number;
  dependencyHits: number;
  dependencyFalsePositives: number;
  staleHits: number;
  staleMisses: number;
  pricingVersion: string;
  cacheCondition: string;
}

export interface LegacyImprovementInput {
  cases: LegacyGroundTruthCase[];
  baseline: LegacyPathMeasurement;
  candidate: LegacyPathMeasurement;
}

export interface LegacyImprovementVerdict {
  status: "passed" | "failed" | "inconclusive";
  reasons: string[];
}

const integerFields = [
  "llmCalls",
  "totalTokens",
  "correctedMisses",
  "factInterpretationErrors",
  "dependencyHits",
  "dependencyFalsePositives",
  "staleHits",
  "staleMisses",
] as const;

const unknownCaseIds = new Set(["dynamic_unknown", "critical_unknown", "split_unknown", "delete_stale"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateMeasurement(value: LegacyPathMeasurement, label: string): string[] {
  if (!isRecord(value)) return [`${label}: measurement is missing`];
  const reasons: string[] = [];
  for (const key of integerFields) {
    if (!Number.isInteger(value[key]) || value[key] < 0) reasons.push(`${label}: ${key} must be a non-negative integer`);
  }
  if (typeof value.falseDeltaRate !== "number" || !Number.isFinite(value.falseDeltaRate)
    || value.falseDeltaRate < 0 || value.falseDeltaRate > 1) {
    reasons.push(`${label}: falseDeltaRate must be between 0 and 1`);
  }
  if (typeof value.pricingVersion !== "string" || value.pricingVersion.length === 0) reasons.push(`${label}: pricingVersion is required`);
  if (typeof value.cacheCondition !== "string" || value.cacheCondition.length === 0) reasons.push(`${label}: cacheCondition is required`);
  return reasons;
}

function validSource(value: unknown): value is LegacySourceFile {
  return isRecord(value) && typeof value.path === "string" && value.path.length > 0 && typeof value.content === "string";
}

function validateCase(value: LegacyGroundTruthCase): string[] {
  if (!isRecord(value)) return ["ground truth case is missing"];
  const reasons: string[] = [];
  if (typeof value.id !== "string" || value.id.length === 0) reasons.push("ground truth case id is required");
  if (!["fact_recall", "dependency_impact", "evidence_reconciliation"].includes(value.kind)) reasons.push(`${value.id}: kind is invalid`);
  if (!Array.isArray(value.before) || !value.before.every(validSource)) reasons.push(`${value.id}: before must contain source files`);
  if (!Array.isArray(value.after) || !value.after.every(validSource)) reasons.push(`${value.id}: after must contain source files`);
  if (!isRecord(value.expected)) return [...reasons, `${value.id}: expected is required`];
  if (!Array.isArray(value.expected.behaviors) || value.expected.behaviors.length === 0) {
    reasons.push(`${value.id}: expected behaviors are required`);
  } else {
    for (const behavior of value.expected.behaviors) {
      if (!isRecord(behavior) || typeof behavior.id !== "string" || typeof behavior.description !== "string"
        || !["same", "changed", "unknown"].includes(behavior.state)) {
        reasons.push(`${value.id}: behavior expectation is invalid`);
      }
    }
  }
  if (!Array.isArray(value.expected.impacted) || !value.expected.impacted.every((item) => typeof item === "string")) {
    reasons.push(`${value.id}: impacted must be a string array`);
  }
  if (!Array.isArray(value.expected.unaffected) || !value.expected.unaffected.every((item) => typeof item === "string")) {
    reasons.push(`${value.id}: unaffected must be a string array`);
  }
  if (!Array.isArray(value.expected.unknown)) {
    reasons.push(`${value.id}: unknown must be an array`);
  } else {
    for (const unknown of value.expected.unknown) {
      if (!isRecord(unknown) || typeof unknown.id !== "string") {
        reasons.push(`${value.id}: unknown expectation is invalid`);
      } else if (unknown.resolution !== "unknown") {
        reasons.push(`${value.id}: ${String(unknown.resolution)} must not be written as unknown`);
      }
    }
    const requiresUnknown = unknownCaseIds.has(value.id)
      || value.expected.behaviors?.some((behavior) => behavior.state === "unknown");
    if (requiresUnknown && value.expected.unknown.length === 0) reasons.push(`${value.id}: explicit unknown expectation is required`);
  }
  return reasons;
}

export function evaluateLegacyImprovement(input: LegacyImprovementInput): LegacyImprovementVerdict {
  const failures: string[] = [];
  const inconclusive: string[] = [];
  if (!Array.isArray(input.cases) || input.cases.length === 0) {
    inconclusive.push("ground truth cases are required");
  } else {
    const ids = new Set<string>();
    for (const groundTruthCase of input.cases) {
      inconclusive.push(...validateCase(groundTruthCase));
      if (ids.has(groundTruthCase.id)) inconclusive.push(`${groundTruthCase.id}: duplicate case id`);
      ids.add(groundTruthCase.id);
    }
  }

  const baselineProblems = validateMeasurement(input.baseline, "baseline");
  const candidateProblems = validateMeasurement(input.candidate, "candidate");
  inconclusive.push(...baselineProblems, ...candidateProblems);
  if (baselineProblems.length === 0 && candidateProblems.length === 0) {
    const { baseline, candidate } = input;
    if (baseline.llmCalls === 0 || baseline.totalTokens === 0) inconclusive.push("baseline: empty cost receipt is not comparable");
    if (baseline.pricingVersion !== candidate.pricingVersion) inconclusive.push("pricing versions are not comparable");
    if (baseline.cacheCondition !== candidate.cacheCondition) inconclusive.push("cache conditions are not comparable");
    if (candidate.llmCalls > baseline.llmCalls) failures.push("candidate LLM calls increased");
    if (candidate.totalTokens > baseline.totalTokens * 1.05) failures.push("candidate tokens exceed 1.05 times baseline");
    if (candidate.falseDeltaRate > baseline.falseDeltaRate) failures.push("candidate falseDeltaRate increased");
    if (candidate.correctedMisses < baseline.correctedMisses) failures.push("candidate correctedMisses regressed");
    if (candidate.dependencyHits < baseline.dependencyHits) failures.push("candidate dependencyHits regressed");
    if (candidate.dependencyFalsePositives > 0) failures.push("candidate dependency false positives are not zero");
    if (candidate.staleHits < baseline.staleHits) failures.push("candidate staleHits regressed");
    if (candidate.staleMisses > 0) failures.push("candidate stale misses are not zero");

    const ids = new Set(input.cases.map((groundTruthCase) => groundTruthCase.id));
    if (ids.has("archive_limit") && candidate.correctedMisses <= baseline.correctedMisses) {
      failures.push("archive_limit: no pre-registered miss was corrected");
    }
    if (input.cases.some((groundTruthCase) => groundTruthCase.kind === "fact_recall")
      && candidate.factInterpretationErrors > 0) {
      failures.push("candidate fact interpretation errors are not zero");
    }
    if (ids.has("shared_permission") && candidate.dependencyHits <= baseline.dependencyHits) {
      failures.push("shared_permission: no dependency impact hit was measured");
    }
    if (["refactor_changed", "split_unknown", "delete_stale"].some((id) => ids.has(id))
      && candidate.staleHits <= baseline.staleHits) {
      failures.push("evidence reconciliation: no stale hit was measured");
    }
  }

  if (failures.length > 0) return { status: "failed", reasons: [...failures, ...inconclusive] };
  if (inconclusive.length > 0) return { status: "inconclusive", reasons: inconclusive };
  return { status: "passed", reasons: [] };
}
