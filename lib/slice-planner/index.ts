import { createHash } from "node:crypto";
import { basename } from "node:path";
import { normalizeSourcePath } from "../remote-source-index/index";
import { SourceIndexError, type SourceLineSlice, type SourceSignal, type SourceTreeEntry } from "../remote-source-index/types";
import type { EvidenceClaim, PlannerDiagnostic, ProductSliceInput, ScopeResolution, SelectedSourceFile, SelectedSourceReason, SliceConfidence, SlicePlanResult, SlicePlanningState, SlicePlanner, StackProfileId, StackProfileMatch, TargetedReadApproval, TargetedReadDecision, TargetedReadRequest } from "./types";
import type { OpenedRemoteSourceRevision } from "../remote-source-index/types";

const sourceDirectoryNames = new Set(["app", "apps", "src", "lib", "internal", "routes", "services", "cmd", "pages", "java", "cpp"]);
const interestingSignals = new Set<SourceSignal>(["manifest", "entrypoint", "route", "service", "database", "migration", "queue", "worker", "auth", "deployment", "frontend", "native"]);

function contentSha(lines: string[]) {
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

export function reasonFor(signals: SourceSignal[]): SelectedSourceReason {
  const reasons: Array<[SourceSignal, SelectedSourceReason]> = [
    ["manifest", "manifest"],
    ["entrypoint", "entrypoint"],
    ["route", "route"],
    ["database", "database"],
    ["queue", "queue"],
    ["auth", "auth"],
    ["deployment", "deployment"],
    ["frontend", "service"],
    ["native", "service"],
  ];
  return reasons.find(([signal]) => signals.includes(signal))?.[1] ?? "service";
}

export function confidenceLabel(confidence: number): SliceConfidence {
  return confidence >= 0.72 ? "high" : confidence >= 0.5 ? "medium" : "low";
}

export function scopeErrorMessage(error: unknown, path: string) {
  if (error instanceof SourceIndexError && ["path_outside_product_scope", "tree_not_found", "path_not_found"].includes(error.code)) {
    return `scope root does not exist: ${path}`;
  }
  return `scope root could not be indexed: ${path}`;
}

function matchCandidate(candidate: { paths: string[] }, files: SelectedSourceFile[]) {
  return files.filter((file) => candidate.paths.some((suffix) => file.path.endsWith(suffix)));
}

function matchedSignals(candidate: { paths: string[] }, files: SelectedSourceFile[]) {
  return matchCandidate(candidate, files).flatMap((file) => file.signals.map((signal) => ({ path: file.path, signal })));
}

export function hasNextWebProfile(files: SelectedSourceFile[], has: (fragment: string) => boolean) {
  return hasFileSuffix(files, "package.json") && (has("\"next\"") || hasFileSuffix(files, "app/page.tsx"));
}

export function hasNodeApiProfile(files: SelectedSourceFile[], has: (fragment: string) => boolean) {
  return hasFileSuffix(files, "package.json") && (has("fastify") || has("express") || has("hono"));
}

export function hasGoProfile(files: SelectedSourceFile[]) {
  return hasFileSuffix(files, "go.mod");
}

export function hasAndroidProfile(files: SelectedSourceFile[], has: (fragment: string) => boolean) {
  return hasFileSuffix(files, "AndroidManifest.xml") && (hasFileSuffix(files, "build.gradle") || has("activity") || has("service"));
}

function hasFileSuffix(files: SelectedSourceFile[], suffix: string) {
  return files.some((file) => file.path.endsWith(suffix));
}

function profileCandidates(files: SelectedSourceFile[], content: Map<string, string>) {
  const joined = [...content.entries()].map(([path, value]) => `${path}\n${value}`).join("\n");
  const has = (fragment: string) => joined.toLowerCase().includes(fragment);
  const candidates = [
    { profileId: "next-web" as const, confidence: 0.9, paths: ["package.json", "app/page.tsx"], matches: hasNextWebProfile(files, has) },
    { profileId: "node-api" as const, confidence: 0.82, paths: ["package.json"], matches: hasNodeApiProfile(files, has) },
    { profileId: "go-api" as const, confidence: 0.85, paths: ["go.mod"], matches: hasGoProfile(files) },
    { profileId: "android-native" as const, confidence: 0.88, paths: ["AndroidManifest.xml"], matches: hasAndroidProfile(files, has) },
  ];
  return candidates;
}

export function matchProfiles(files: SelectedSourceFile[], content: Map<string, string>): StackProfileMatch[] {
  return profileCandidates(files, content)
    .filter((candidate) => candidate.matches)
    .map((candidate) => ({
      profileId: candidate.profileId,
      confidence: candidate.confidence,
      matchedSignals: matchedSignals(candidate, files),
    }))
    .sort((a, b) => b.confidence - a.confidence || a.profileId.localeCompare(b.profileId));
}

const priorityPatterns = [
  /AndroidManifest\.xml$/,
  /(?:package\.json|go\.mod|Cargo\.toml|pom\.xml|build\.gradle)$/,
  /(?:page\.tsx|route\.ts|main\.go|server\.ts|index\.ts)$/,
  /(?:Activity|Service|NativeBridge)\.java$/,
  /(?:jni|raop|httpd).*\.c$/i,
];

export function candidatePriority(entry: SourceTreeEntry) {
  const priority = priorityPatterns.findIndex((pattern) => pattern.test(entry.path));
  return priority === -1 ? priorityPatterns.length : priority;
}

class DeterministicSlicePlanner implements SlicePlanner {
  constructor(private readonly now: () => number) {}

  async resolveScope(input: ProductSliceInput, index: OpenedRemoteSourceRevision): Promise<ScopeResolution> {
    if (input.scopeRoots.length === 0) {
      return { status: "ambiguous", scopeRoots: [], unresolved: ["product scope roots were not configured"] };
    }
    const unresolved: string[] = [];
    for (const scope of input.scopeRoots) {
      try {
        await index.listDir(scope.path);
      } catch (error) {
        if (error instanceof SourceIndexError && error.code === "budget_exhausted") throw error;
        unresolved.push(scopeErrorMessage(error, scope.path));
      }
    }
    return unresolved.length > 0
      ? { status: "not_found", scopeRoots: input.scopeRoots.filter((scope) => !unresolved.some((item) => item.endsWith(scope.path))), unresolved }
      : { status: "resolved", unresolved: [], scopeRoots: input.scopeRoots };
  }

  async plan(input: ProductSliceInput, index: OpenedRemoteSourceRevision): Promise<SlicePlanResult> {
    try {
      const scope = await this.resolveScope(input, index);
      if (scope.status === "ambiguous") return { status: "scope_ambiguous", workspaceMap: scope.workspaceMap, missing: scope.unresolved, diagnostics: [{ code: "scope_ambiguous", message: "product scope roots are ambiguous" }] };
      if (scope.status !== "resolved") return { status: "underdetermined", missing: scope.unresolved, diagnostics: [{ code: "scope_root_not_found", message: "one or more scope roots were not found" }] };

      const state: SlicePlanningState = {
        input,
        revision: index,
        phase: "manifest_scan",
        scope,
        selected: new Map(),
        fileContents: new Map(),
        evidenceClaims: [],
        questions: [],
        profileMatches: [],
        unresolved: [],
        diagnostics: [],
        budgetsRemaining: {
          selectedFiles: input.budgets.maxSelectedFiles,
          selectedLineRanges: input.budgets.maxSelectedLineRanges,
          plannerContentBytes: input.budgets.maxPlannerContentBytes,
          aiReadCalls: input.budgets.maxAiReadCalls,
          startedAt: this.now(),
        },
      };

      for (const scopeRoot of scope.scopeRoots) {
        await this.selectFromDirectory(index, state, scopeRoot.path, 0);
      }
      return this.completePlan(index, state);
    } catch (error) {
      const diagnostic = toDiagnostic(error);
      return { status: error instanceof SourceIndexError && error.code === "budget_exhausted" ? "underdetermined" : "failed", missing: [diagnostic.message], diagnostics: [diagnostic] };
    }
  }

  private completePlan(index: OpenedRemoteSourceRevision, state: SlicePlanningState): SlicePlanResult {
    state.phase = "profile_matching";
    state.profileMatches = matchProfiles([...state.selected.values()], state.fileContents);
    const topProfile = state.profileMatches[0];
    const confidence = topProfile ? topProfile.confidence : 0.2;
    if (!topProfile) {
      state.diagnostics.push({ code: "profile_confidence_low", subject: undefined, message: "selected source slice does not identify a supported stack profile" });
    } else if (confidence < 0.5) {
      state.diagnostics.push({ code: "profile_confidence_low", subject: topProfile.profileId, message: "selected source slice does not identify a supported stack profile" });
    }

    const sliceConfidence = confidenceLabel(confidence);
    const slice = this.createSourceSlice(state, sliceConfidence);
    state.phase = "done";
    return sliceConfidence === "low"
      ? { status: "underdetermined", slice, missing: ["supported stack profile was not identified"], diagnostics: state.diagnostics }
      : { status: "completed", slice, missing: [], diagnostics: state.diagnostics };
  }

  private createSourceSlice(state: SlicePlanningState, sliceConfidence: SliceConfidence) {
    const files = [...state.selected.values()];
    return {
      product: state.input.product,
      repository: `${state.input.repository.owner}/${state.input.repository.repo}`,
      revision: state.input.repository.revision,
      scopeRoots: state.scope.scopeRoots,
      files,
      evidenceClaims: state.evidenceClaims,
      plannerVersion: state.input.plannerVersion,
      profileVersion: state.input.profileVersion,
      confidence: sliceConfidence,
      unresolved: state.unresolved,
      metrics: {
        treeExpansions: state.revision.metrics.treeExpansions,
        blobFetches: state.revision.metrics.blobFetches,
        selectedFiles: files.length,
        selectedLineRanges: files.reduce((total, file) => total + file.lineRanges.length, 0),
        selectedContentBytes: files.reduce((total, file) => total + file.byteSize, 0),
        aiReadCalls: 0,
        prunedPathCount: 0,
        wallClockMs: this.now() - state.budgetsRemaining.startedAt,
        profileMatches: state.profileMatches,
        budgetsRemaining: {
          selectedFiles: state.budgetsRemaining.selectedFiles,
          selectedLineRanges: state.budgetsRemaining.selectedLineRanges,
          plannerContentBytes: state.budgetsRemaining.plannerContentBytes,
          aiReadCalls: state.budgetsRemaining.aiReadCalls,
        },
      },
    };
  }

  evaluateTargetedRead(state: SlicePlanningState, request: TargetedReadRequest): TargetedReadDecision {
    const path = normalizeSourcePath(request.path);
    const inScope = state.scope.scopeRoots.some((scope) => path === scope.path || path.startsWith(`${scope.path}/`));
    if (!inScope) return { allowed: false, code: "scope_root_not_found", message: `targeted read is outside product scope: ${path}` };
    if (request.startLine < 1 || request.endLine < request.startLine) return { allowed: false, code: "read_request_invalid", message: "line range is invalid" };
    if (state.budgetsRemaining.aiReadCalls <= 0) return { allowed: false, code: "budget_exhausted", message: "AI read budget was exhausted" };
    return {
      allowed: true,
      approval: {
        requestId: `${path}:${request.startLine}-${request.endLine}`,
        path,
        startLine: request.startLine,
        endLine: request.endLine,
        reason: request.reason,
        remainingReadCalls: state.budgetsRemaining.aiReadCalls - 1,
        remainingContentBytes: state.budgetsRemaining.plannerContentBytes,
      },
    };
  }

  applyTargetedRead(state: SlicePlanningState, approval: TargetedReadApproval, slice: SourceLineSlice): SlicePlanningState {
    state.budgetsRemaining.aiReadCalls = approval.remainingReadCalls;
    state.evidenceClaims.push({
      kind: "component",
      claim: approval.reason,
      path: slice.path,
      startLine: slice.startLine,
      endLine: slice.endLine,
      quoteSha256: contentSha(slice.lines),
      confidence: "medium",
    });
    state.selected.set(slice.path, {
      path: slice.path,
      blobSha: slice.blobSha,
      treeEntrySha: slice.treeEntrySha,
      reason: "ai_targeted",
      byteSize: slice.byteSize,
      lineRanges: [{ startLine: slice.startLine, endLine: slice.endLine, purpose: approval.reason }],
      signals: [],
    });
    return state;
  }

  async finalize(state: SlicePlanningState): Promise<SlicePlanResult> {
    const topProfile = state.profileMatches[0];
    if (!topProfile) return { status: "underdetermined", missing: ["supported stack profile was not identified"], diagnostics: [{ code: "profile_confidence_low", message: "no stack profile was identified" }] };
    return { status: "completed", missing: [], diagnostics: state.diagnostics };
  }

  private async selectFromDirectory(index: OpenedRemoteSourceRevision, state: SlicePlanningState, path: string, depth: number) {
    if (depth > 4 || state.budgetsRemaining.selectedFiles <= 0) return;
    const listing = await index.listDir(path);
    await this.selectListedFiles(index, state, listing.entries);
    if (depth >= 5) return;
    for (const entry of listing.entries) {
      if (entry.pruned || entry.type !== "tree") continue;
      await this.selectFromDirectory(index, state, entry.path, depth + 1);
    }
  }

  private async selectListedFiles(index: OpenedRemoteSourceRevision, state: SlicePlanningState, entries: SourceTreeEntry[]) {
    const candidates = entries
      .filter((entry) => !entry.pruned && entry.type === "blob" && entry.signals.some((signal) => interestingSignals.has(signal)))
      .sort((a, b) => candidatePriority(a) - candidatePriority(b) || basename(a.path).localeCompare(basename(b.path)));
    for (const entry of candidates) {
      await this.selectFile(index, state, entry.path, entry.signals, reasonFor(entry.signals));
    }
  }

  private async selectFile(index: OpenedRemoteSourceRevision, state: SlicePlanningState, path: string, signals: SourceSignal[], reason: SelectedSourceReason) {
    if (state.selected.has(path) || state.budgetsRemaining.selectedFiles <= 0 || state.budgetsRemaining.selectedLineRanges <= 0 || state.budgetsRemaining.plannerContentBytes <= 0) return;
    const lineEnd = Math.min(600, state.budgetsRemaining.selectedLineRanges);
    const read = await index.readLines({
      path,
      startLine: 1,
      endLine: lineEnd,
      requestedBy: "profile",
      reason: `deterministic slice: ${reason}`,
    });
    const selected: SelectedSourceFile = {
      path,
      blobSha: read.blobSha,
      treeEntrySha: read.treeEntrySha,
      reason,
      byteSize: read.byteSize,
      lineRanges: [{ startLine: read.startLine, endLine: read.endLine, purpose: reason }],
      signals,
    };
    state.fileContents.set(path, read.lines.join("\n"));
    state.selected.set(path, selected);
    state.budgetsRemaining.selectedFiles -= 1;
    state.budgetsRemaining.selectedLineRanges -= 1;
    state.budgetsRemaining.plannerContentBytes -= read.byteSize;
    state.evidenceClaims.push({
      kind: "component",
      claim: `${reason} source is available at the pinned revision`,
      path,
      startLine: read.startLine,
      endLine: read.endLine,
      quoteSha256: contentSha(read.lines),
      confidence: confidenceLabel(0.8),
    });
  }
}

export function toDiagnostic(error: unknown): PlannerDiagnostic {
  if (error instanceof SourceIndexError) {
    return { code: error.code as PlannerDiagnostic["code"], message: error.message };
  }
  return { code: "budget_exhausted", message: error instanceof Error ? error.message : "slice planning failed" };
}

export interface SlicePlannerOptions {
  now?: () => number;
}

export function createSlicePlanner(options: SlicePlannerOptions = {}): SlicePlanner {
  return new DeterministicSlicePlanner(options.now ?? Date.now);
}

export * from "./types";
