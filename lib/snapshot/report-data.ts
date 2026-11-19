import { createHash } from "node:crypto";
import type { AnalysisResult } from "../ai";
import type { SnapshotAnalysis, SnapshotCodebaseArea, SnapshotEvidenceSnippet, SnapshotReportData, SnapshotWarning } from "./types";
import { fallbackSnapshotPresentation } from "./presentation";

interface NumberedLine {
  number: number;
  text: string;
}

interface EvidenceReference {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface SnapshotEvidenceBudgets {
  maxEvidenceLinesPerSnippet: number;
  maxEvidenceBytes: number;
}

const defaultBudgets: SnapshotEvidenceBudgets = {
  maxEvidenceLinesPerSnippet: 80,
  maxEvidenceBytes: 2_000_000,
};

function citation(reference: EvidenceReference) {
  const start = reference.startLine ?? null;
  return { start, end: start === null ? null : reference.endLine ?? start };
}

export function snapshotEvidenceId(reference: EvidenceReference) {
  const { start, end } = citation(reference);
  const digest = createHash("sha256").update(`${reference.path}\0${start ?? ""}\0${end ?? ""}`).digest("hex").slice(0, 16);
  return `evidence-${digest}`;
}

function collectReferences(result: AnalysisResult): EvidenceReference[] {
  const references = [...result.product.evidence];
  for (const feature of result.features) {
    for (const scenario of feature.scenarios) references.push(...scenario.evidence);
  }
  const unique = new Map<string, EvidenceReference>();
  for (const reference of references) {
    const { start, end } = citation(reference);
    const key = `${reference.path}\0${start ?? ""}\0${end ?? ""}`;
    if (!unique.has(key)) unique.set(key, reference);
  }
  return [...unique.values()];
}

function numberedSources(analysis: SnapshotAnalysis) {
  const sources = new Map<string, NumberedLine[]>();
  for (const partition of analysis.partitions) {
    for (const source of partition.sources) {
      const lines: NumberedLine[] = [];
      for (const row of source.content.split("\n")) {
        const match = /^(\d+): ?([\s\S]*)$/.exec(row);
        if (match) lines.push({ number: Number(match[1]), text: match[2] });
      }
      const existing = sources.get(source.path) ?? [];
      const byLine = new Map(existing.map((line) => [line.number, line]));
      for (const line of lines) byLine.set(line.number, line);
      sources.set(source.path, [...byLine.values()].sort((a, b) => a.number - b.number));
    }
  }
  return sources;
}

function githubSourceUrl(analysis: SnapshotAnalysis, reference: EvidenceReference, lines: NumberedLine[]) {
  if (analysis.identity.source !== "github" || !analysis.identity.repositoryUrl) return undefined;
  const { start, end } = citation(reference);
  const first = start ?? lines[0]?.number;
  if (!first) return undefined;
  const last = start === null ? lines.at(-1)?.number ?? first : end ?? first;
  const path = reference.path.split("/").map(encodeURIComponent).join("/");
  return `${analysis.identity.repositoryUrl}/blob/${analysis.identity.revision}/${path}#L${first}${last === first ? "" : `-L${last}`}`;
}

function excerpt(lines: NumberedLine[], reference: EvidenceReference, maxLines: number) {
  const { start, end } = citation(reference);
  if (start === null) {
    const selected = lines.slice(0, maxLines);
    return { lines: selected, truncated: lines.length > selected.length, unavailable: lines.length === 0 };
  }
  const firstIndex = lines.findIndex((line) => line.number === start);
  if (firstIndex < 0) return { lines: [], truncated: false, unavailable: true };
  const lastIndex = lines.findIndex((line) => line.number === end);
  const citationMissing = lastIndex < 0;
  const contextEnd = Math.min(lines.length, (citationMissing ? firstIndex : lastIndex) + 5);
  let selected = lines.slice(firstIndex, contextEnd);
  let truncated = citationMissing;
  if (selected.length > maxLines) {
    selected = lines.slice(firstIndex, firstIndex + maxLines);
    truncated = true;
  }
  return { lines: selected, truncated, unavailable: false };
}

function codebaseNavigation(features: AnalysisResult["features"]): SnapshotCodebaseArea[] {
  const areas = new Map<string, { features: Set<string>; scenarios: Set<string>; evidencePaths: Set<string> }>();
  for (const feature of features) {
    for (const scenario of feature.scenarios) {
      for (const evidence of scenario.evidence) {
        const segments = evidence.path.split("/");
        segments.pop();
        const path = segments.join("/") || ".";
        const area = areas.get(path) ?? { features: new Set<string>(), scenarios: new Set<string>(), evidencePaths: new Set<string>() };
        area.features.add(feature.name);
        area.scenarios.add(`${feature.name}\0${scenario.reference}`);
        area.evidencePaths.add(evidence.path);
        areas.set(path, area);
      }
    }
  }
  return [...areas.entries()]
    .sort(([pathA, a], [pathB, b]) => b.features.size - a.features.size || b.scenarios.size - a.scenarios.size || pathA.localeCompare(pathB))
    .slice(0, 8)
    .map(([path, area]) => ({
      path,
      featureNames: features.map((feature) => feature.name).filter((name) => area.features.has(name)),
      scenarioCount: area.scenarios.size,
      evidencePathCount: area.evidencePaths.size,
    }));
}

export function buildSnapshotReportData(analysis: SnapshotAnalysis, budgets: Partial<SnapshotEvidenceBudgets> = {}): SnapshotReportData {
  const limits = { ...defaultBudgets, ...budgets };
  const sources = numberedSources(analysis);
  const warnings: SnapshotWarning[] = [...analysis.warnings];
  const snippets: SnapshotEvidenceSnippet[] = [];
  let evidenceBytes = 0;
  let budgetWarning = false;
  let truncationWarning = false;
  let unavailableWarning = false;

  for (const reference of collectReferences(analysis.result)) {
    const extracted = excerpt(sources.get(reference.path) ?? [], reference, limits.maxEvidenceLinesPerSnippet);
    const bytes = extracted.lines.reduce((total, line) => total + Buffer.byteLength(`${line.number}: ${line.text}\n`, "utf8"), 0);
    if (evidenceBytes + bytes > limits.maxEvidenceBytes) {
      budgetWarning = true;
      continue;
    }
    evidenceBytes += bytes;
    truncationWarning ||= extracted.truncated;
    unavailableWarning ||= extracted.unavailable;
    snippets.push({
      id: snapshotEvidenceId(reference),
      path: reference.path,
      citedStartLine: citation(reference).start,
      citedEndLine: citation(reference).end,
      lines: extracted.lines,
      truncated: extracted.truncated,
      unavailable: extracted.unavailable,
      ...(githubSourceUrl(analysis, reference, extracted.lines) ? { sourceUrl: githubSourceUrl(analysis, reference, extracted.lines) } : {}),
    });
  }
  if (budgetWarning) warnings.push({ code: "evidence_budget_exceeded", values: { limit: limits.maxEvidenceBytes } });
  if (truncationWarning) warnings.push({ code: "evidence_snippet_truncated", values: { limit: limits.maxEvidenceLinesPerSnippet } });
  if (unavailableWarning) warnings.push({ code: "evidence_lines_unavailable" });

  const productHasEvidence = analysis.result.product.evidence.length > 0;
  if (!productHasEvidence) warnings.push({ code: "product_description_unavailable" });
  // BYO 私有仓库披露（设计 §10 红线）：本地/非公网来源的报告含真实源码摘录，必须显式警告勿公开分发。
  if (analysis.identity.source !== "github") {
    warnings.push({ code: "local_source_excerpts_privacy" });
  }
  return {
    schemaVersion: 1,
    language: analysis.language,
    snapshot: { ...analysis.identity },
    generatedAt: analysis.generatedAt,
    modelName: analysis.modelName,
    product: {
      description: productHasEvidence ? analysis.result.product.description : null,
      evidence: productHasEvidence ? analysis.result.product.evidence : [],
    },
    features: analysis.result.features,
    presentation: analysis.presentation ?? fallbackSnapshotPresentation(analysis.result, analysis.language),
    codebaseNavigation: codebaseNavigation(analysis.result.features),
    evidenceSnippets: snippets,
    coverage: analysis.coverage,
    ...(analysis.effectiveCoverage ? { effectiveCoverage: analysis.effectiveCoverage } : {}),
    warnings,
    analysis: {
      partitions: analysis.partitions.length,
      retries: analysis.passes.reduce((total, pass) => total + pass.retries, 0),
      emptyPasses: analysis.passes.filter((pass) => pass.sanitize.empty).length,
      droppedScenarios: analysis.passes.reduce((total, pass) => total + pass.sanitize.droppedScenarios, 0),
      scenariosDeduped: analysis.mergeStats.scenariosDeduped,
      featuresFolded: analysis.mergeStats.featuresFolded,
    },
  };
}
