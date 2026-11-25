import { z } from "zod";
import type { OutputLanguage } from "./analysis-language";
import type { Execute } from "./db";
import type { CopyCompletion } from "./release-notes-enhance";
import { specFeatureKey, type SpecChange, type SpecFeature, type SpecScenario } from "./spec-diff";
import type { Evidence } from "./types";

export interface ReleaseChangeFact extends SpecChange {
  id: number;
}

export interface ReleaseChangeProjection {
  changeId: number | null;
  featureKey: string;
  featureName: string;
  kind: "added" | "changed" | "removed" | "uncertain";
  description: string;
  userImpact: string;
  evidence: Evidence[];
  sourceSpecChangeIds: number[];
  facts: ReleaseChangeFact[];
}

function isScenario(value: SpecFeature | SpecScenario): value is SpecScenario {
  return "context" in value;
}

function factEvidence(fact: ReleaseChangeFact): Evidence[] {
  const subjects = [fact.before, fact.after].filter((subject) => subject !== null);
  return subjects.flatMap((subject) => isScenario(subject) ? subject.evidence : subject.scenarios.flatMap((scenario) => scenario.evidence));
}

function projectionCopy(facts: ReleaseChangeFact[]): string {
  const copy = [...new Set(facts.map((fact) => fact.summary.trim()).filter(Boolean))].join("；");
  if (copy.length <= 4_000) return copy;
  const prefix = copy.slice(0, 4_000);
  const sentenceBoundary = Math.max(...["。", ".", "!", "?"].map((mark) => prefix.lastIndexOf(mark)));
  if (sentenceBoundary >= 0) return prefix.slice(0, sentenceBoundary + 1);
  const clauseBoundary = prefix.lastIndexOf("；");
  if (clauseBoundary >= 0) return prefix.slice(0, clauseBoundary);
  const wordBoundary = prefix.lastIndexOf(" ");
  return wordBoundary > 0 ? prefix.slice(0, wordBoundary) : prefix;
}

export function baselineReleaseChangeFacts(features: SpecFeature[]): ReleaseChangeFact[] {
  return features.map((feature) => ({
    id: 0,
    kind: "added",
    entityType: "feature",
    featureName: feature.name,
    scenarioReference: null,
    summary: feature.summary,
    before: null,
    after: feature,
  }));
}

export function buildReleaseChangeProjections(facts: ReleaseChangeFact[]): ReleaseChangeProjection[] {
  const groups = new Map<string, ReleaseChangeFact[]>();
  for (const fact of facts) {
    const key = specFeatureKey(fact.featureName);
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([featureKey, group]) => {
    const kinds = new Set(group.map((fact) => fact.kind));
    const evidence = new Map<string, Evidence>();
    for (const item of group.flatMap(factEvidence)) {
      const key = JSON.stringify([item.path, item.startLine ?? null, item.endLine ?? null, item.url ?? null, item.note ?? null]);
      if (!evidence.has(key)) evidence.set(key, item);
    }
    const description = projectionCopy(group);
    return {
      changeId: null,
      featureKey,
      featureName: group[0].featureName,
      kind: kinds.size === 1 ? group[0].kind : "changed",
      description,
      userImpact: "",
      evidence: [...evidence.values()].slice(0, 5),
      sourceSpecChangeIds: group.map((fact) => fact.id).filter((id) => id > 0),
      facts: group,
    };
  });
}

const rewriteSchema = z.object({
  description: z.string().trim().min(1).max(4_000),
  userImpact: z.string().trim().min(1).max(4_000),
});

function rewritePrompt(projection: ReleaseChangeProjection, language: OutputLanguage): string {
  const facts = projection.facts.map((fact) => `- ${fact.id > 0 ? `spec_change #${fact.id}` : "baseline feature"} [${fact.kind}/${fact.entityType}] ${fact.featureName}${fact.scenarioReference ? ` · ${fact.scenarioReference}` : ""}: ${fact.summary}`).join("\n");
  if (language === "en") {
    return [
      "Rewrite one feature's canonical behavior changes into a concise engineering changelog entry. Write in English.",
      "The feature grouping and source IDs are fixed: merge all listed facts into one entry and do not invent facts, numbers, or additional entries.",
      'Return JSON only: {"description":"implementation-facing change","userImpact":"user-perceivable result"}',
      `Feature: ${projection.featureName}`,
      facts,
    ].join("\n");
  }
  return [
    "把一个功能的规范行为变化改写成一条简洁的工程变更说明。用简体中文。",
    "功能分组与来源 ID 已固定：合并下列全部事实为一条，不得编造事实、数字或新增条目。",
    '只返回 JSON：{"description":"面向实现的变更说明","userImpact":"用户可感知的结果"}',
    `功能：${projection.featureName}`,
    facts,
  ].join("\n");
}

function parseRewrite(content: string) {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 输出不含 JSON 对象");
  return rewriteSchema.parse(JSON.parse(stripped.slice(start, end + 1)));
}

export async function rewriteReleaseChangeProjections(
  execute: { execute: Execute },
  deps: { completion: CopyCompletion; runId: number; accountId: number | null },
  projections: ReleaseChangeProjection[],
  language: OutputLanguage = "zh-CN",
): Promise<{ rewritten: number; failed: number; skipped: number }> {
  let rewritten = 0;
  let failed = 0;
  let skipped = 0;
  let attempted = 0;
  for (const projection of projections) {
    if (projection.changeId === null) continue;
    if (attempted >= 12) {
      skipped += 1;
      continue;
    }
    attempted += 1;
    try {
      const content = await deps.completion(
        [
          { role: "system", content: language === "en" ? "You are a precise release editor; rewrite only the supplied facts." : "你是严谨的发布说明编辑，只改写给定事实。" },
          { role: "user", content: rewritePrompt(projection, language) },
        ],
        { runId: deps.runId, accountId: deps.accountId, chargeComponent: "main", callKind: "release_change_projection" },
      );
      const copy = parseRewrite(content);
      await execute.execute("UPDATE changes SET description = ?, user_impact = ? WHERE id = ?", [copy.description, copy.userImpact, projection.changeId]);
      rewritten += 1;
    } catch (error) {
      failed += 1;
      console.warn("[release-changes] projection rewrite failed; keeping canonical copy", {
        changeId: projection.changeId,
        feature: projection.featureName,
        error: error instanceof Error ? error.message.slice(0, 160) : String(error),
      });
    }
  }
  return { rewritten, failed, skipped };
}
