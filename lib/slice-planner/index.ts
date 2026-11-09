import { createHash } from "node:crypto";
import { basename } from "node:path";
import { normalizeSourcePath } from "../remote-source-index/index";
import { SourceIndexError, type SourceLineSlice, type SourceSignal, type SourceTreeEntry } from "../remote-source-index/types";
import type { EvidenceClaim, PlannerDiagnostic, ProductSliceInput, ScopeResolution, SelectedSourceFile, SelectedSourceReason, SliceConfidence, SlicePlanResult, SlicePlanningState, SlicePlanner, StackProfileId, StackProfileMatch, TargetedReadApproval, TargetedReadDecision, TargetedReadRequest } from "./types";
import type { OpenedRemoteSourceRevision } from "../remote-source-index/types";
import { isWalkNoiseDirectory, selectionNoiseKind } from "./selection-policy";

const interestingSignals = new Set<SourceSignal>(["manifest", "entrypoint", "route", "service", "database", "migration", "queue", "worker", "auth", "deployment", "frontend", "native"]);

/**
 * 子树份额上限（占 maxSelectedFiles 比例）：防止单个顶层子树（如 hono 的 adapters/）
 * 烧光预算饿死 src/。只在确有多个子树竞争时生效（记账表 size > 1）——单子树仓库或
 * 噪声剔除后只剩一个源码根的仓库（flask）不受约束，预算可用满。噪声目录已在遍历层剔除。
 */
const MAX_SUBTREE_SHARE = 0.5;

function subtreeKeyOf(rootPath: string, path: string) {
  const prefix = rootPath === "" ? "" : `${rootPath}/`;
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const index = relative.indexOf("/");
  return index === -1 ? "" : relative.slice(0, index);
}

function subtreeCap(state: SlicePlanningState, subtreeKey: string) {
  if (state.subtreeSelections.size <= 1) return Number.POSITIVE_INFINITY;
  const used = state.subtreeSelections.get(subtreeKey) ?? 0;
  return used >= Math.ceil(state.input.budgets.maxSelectedFiles * MAX_SUBTREE_SHARE) ? 0 : Number.POSITIVE_INFINITY;
}

// The planner never needs more than the index default read window for profile matching.
const maxPlannerLinesPerFile = 600;

function contentSha(lines: string[]) {
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

const reasonPriority: Array<[SourceSignal, SelectedSourceReason]> = [
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

export function reasonFor(signals: SourceSignal[]): SelectedSourceReason {
  for (const [signal, reason] of reasonPriority) {
    if (signals.includes(signal)) return reason;
  }
  return "service";
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

export function compareProfiles(left: StackProfileMatch, right: StackProfileMatch) {
  const confidence = right.confidence - left.confidence;
  if (confidence !== 0) return confidence;
  return left.profileId.localeCompare(right.profileId);
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

export function hasSpringJavaProfile(files: SelectedSourceFile[], has: (fragment: string) => boolean) {
  const javaSource = files.some((file) => file.path.endsWith(".java"));
  return (hasFileSuffix(files, "pom.xml") || javaSource) && (has("spring-boot") || has("@SpringBootApplication") || has("@RestController"));
}

export function hasFastapiProfile(files: SelectedSourceFile[], has: (fragment: string) => boolean) {
  return files.some((file) => file.path.endsWith(".py")) && has("fastapi");
}

export function hasGoProfile(files: SelectedSourceFile[]) {
  return hasFileSuffix(files, "go.mod");
}

function hasAndroidManifest(files: SelectedSourceFile[]) {
  return files.some((file) => file.path === "AndroidManifest.xml" || file.path.endsWith("/AndroidManifest.xml"));
}

export function hasAndroidKotlinProfile(files: SelectedSourceFile[]) {
  return hasAndroidManifest(files) && files.some((file) => file.path.endsWith(".kt"));
}

export function hasRustServiceProfile(files: SelectedSourceFile[]) {
  return hasFileSuffix(files, "Cargo.toml") || files.some((file) => file.path.endsWith(".rs"));
}

export function hasLaravelProfile(files: SelectedSourceFile[], has: (fragment: string) => boolean) {
  const phpSource = files.some((file) => file.path.endsWith(".php"));
  return (hasFileSuffix(files, "composer.json") || phpSource) && (has("laravel/framework") || has("illuminate") || hasFileSuffix(files, "artisan") || files.some((file) => file.path.startsWith("app/Providers/")));
}

export function hasDotnetServicesProfile(files: SelectedSourceFile[]) {
  const csharpSource = files.some((file) => file.path.endsWith(".cs"));
  return (files.some((file) => file.path.endsWith(".csproj") || file.path.endsWith(".sln")) || csharpSource) && csharpSource;
}

export function hasAndroidProfile(files: SelectedSourceFile[]) {
  return hasAndroidManifest(files) && files.some((file) => file.path.endsWith(".java"));
}

function hasFileSuffix(files: SelectedSourceFile[], suffix: string) {
  return files.some((file) => file.path.endsWith(suffix));
}

function profileCandidates(files: SelectedSourceFile[], content: Map<string, string>) {
  const joined = [...content.entries()].map(([path, value]) => `${path}\n${value}`).join("\n");
  const has = (fragment: string) => joined.toLowerCase().includes(fragment.toLowerCase());
  const candidates = [
    { profileId: "next-web" as const, confidence: 0.9, paths: ["package.json", "app/page.tsx"], matches: hasNextWebProfile(files, has) },
    { profileId: "node-api" as const, confidence: 0.82, paths: ["package.json"], matches: hasNodeApiProfile(files, has) },
    { profileId: "spring-java" as const, confidence: 0.92, paths: ["pom.xml"], matches: hasSpringJavaProfile(files, has) },
    { profileId: "fastapi-python" as const, confidence: 0.88, paths: ["requirements.txt", "pyproject.toml"], matches: hasFastapiProfile(files, has) },
    { profileId: "go-api" as const, confidence: 0.85, paths: ["go.mod"], matches: hasGoProfile(files) },
    { profileId: "android-kotlin" as const, confidence: 0.9, paths: ["build.gradle.kts", "libs.versions.toml", "AndroidManifest.xml"], matches: hasAndroidKotlinProfile(files) },
    { profileId: "rust-service" as const, confidence: 0.85, paths: ["Cargo.toml"], matches: hasRustServiceProfile(files) },
    { profileId: "laravel-app" as const, confidence: 0.86, paths: ["composer.json", "artisan"], matches: hasLaravelProfile(files, has) },
    { profileId: "dotnet-services" as const, confidence: 0.94, paths: ["*.csproj", "*.sln"], matches: hasDotnetServicesProfile(files) },
    { profileId: "android-native" as const, confidence: 0.88, paths: ["AndroidManifest.xml"], matches: hasAndroidProfile(files) },
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
    .sort((a, b) => compareProfiles(a, b));
}

const priorityPatterns = [
  /(?:^|\/)app\/src\/main\/AndroidManifest\.xml$/,
  /(?:package\.json|go\.mod|Cargo\.toml|pom\.xml|composer\.json|requirements\.txt|pyproject\.toml|build\.gradle(?:\.kts)?|libs\.versions\.toml|.*\.csproj|.*\.sln)$/,
  /(?:page\.tsx|route\.ts|main\.go|server\.ts|index\.ts|artisan)$/,
  /(?:^|\/)app\/src\/main\/(?:java|kotlin)\/.*(?:Activity|Service|NativeBridge)(?:\.java|\.kt)$/,
  /(?:jni|raop|httpd).*\.c$/i,
];

export function candidatePriority(entry: SourceTreeEntry) {
  const priority = priorityPatterns.findIndex((pattern) => pattern.test(entry.path));
  return priority === -1 ? priorityPatterns.length : priority;
}

interface SliceSelection {
  path: string;
  blobSha: string;
  treeEntrySha: string;
  byteSize: number;
  startLine: number;
  endLine: number;
  lines: string[];
  reason: SelectedSourceReason;
  purpose: string;
  signals: SourceSignal[];
  claim: string;
  confidence: SliceConfidence;
}

// One place records a selected file together with the evidence claim that pins it.
function recordSelection(state: SlicePlanningState, selection: SliceSelection) {
  state.selected.set(selection.path, {
    path: selection.path,
    blobSha: selection.blobSha,
    treeEntrySha: selection.treeEntrySha,
    reason: selection.reason,
    byteSize: selection.byteSize,
    lineRanges: [{ startLine: selection.startLine, endLine: selection.endLine, purpose: selection.purpose }],
    signals: selection.signals,
  });
  state.evidenceClaims.push({
    kind: "component",
    claim: selection.claim,
    path: selection.path,
    startLine: selection.startLine,
    endLine: selection.endLine,
    quoteSha256: contentSha(selection.lines),
    confidence: selection.confidence,
  });
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
        subtreeSelections: new Map(),
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
        await this.walkScopeDirectories(index, state, scopeRoot.path);
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
    const sliceConfidence = confidenceLabel(confidence);
    if (sliceConfidence === "low") {
      state.diagnostics.push({ code: "profile_confidence_low", subject: topProfile?.profileId, message: "selected source slice does not identify a supported stack profile" });
    }

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
    recordSelection(state, {
      path: slice.path,
      blobSha: slice.blobSha,
      treeEntrySha: slice.treeEntrySha,
      byteSize: slice.byteSize,
      startLine: slice.startLine,
      endLine: slice.endLine,
      lines: slice.lines,
      reason: "ai_targeted",
      purpose: approval.reason,
      signals: [],
      claim: approval.reason,
      confidence: "medium",
    });
    return state;
  }

  async finalize(state: SlicePlanningState): Promise<SlicePlanResult> {
    const topProfile = state.profileMatches[0];
    if (!topProfile) return { status: "underdetermined", missing: ["supported stack profile was not identified"], diagnostics: [{ code: "profile_confidence_low", message: "no stack profile was identified" }] };
    return { status: "completed", missing: [], diagnostics: state.diagnostics };
  }

  // Iterative breadth-first walk with no depth cap: on a seeded (recursive) index every directory
  // listing is local, and on the per-directory fallback path the index tree-expansion budget
  // still bounds API calls. BFS（替代原 DFS）让顶层目录公平地先于深层子树获得预算；
  // 噪声目录（tests/examples/bench/docs/隐藏目录）在入队前整树跳过。
  private async walkScopeDirectories(index: OpenedRemoteSourceRevision, state: SlicePlanningState, rootPath: string) {
    const pending = [rootPath];
    const visited = new Set<string>();
    while (pending.length > 0) {
      if (state.budgetsRemaining.selectedFiles <= 0) return;
      const path = pending.shift()!;
      if (visited.has(path)) continue;
      visited.add(path);
      const listing = await index.listDir(path);
      const subtreeKey = subtreeKeyOf(rootPath, path);
      // 记账表按首次见到登记子树（含 0），供份额上限判断「是否存在多子树竞争」
      if (!state.subtreeSelections.has(subtreeKey)) state.subtreeSelections.set(subtreeKey, 0);
      await this.selectListedFiles(index, state, listing.entries, subtreeKey);
      for (const entry of listing.entries) {
        if (entry.pruned || entry.type !== "tree") continue;
        if (isWalkNoiseDirectory(entry.path)) continue;
        if (!visited.has(entry.path)) pending.push(entry.path);
      }
    }
  }

  private async selectListedFiles(index: OpenedRemoteSourceRevision, state: SlicePlanningState, entries: SourceTreeEntry[], subtreeKey: string) {
    const candidates = entries
      .filter((entry) => !entry.pruned && entry.type === "blob")
      // 噪声过滤先于信号判定：tests/bench/examples 里的代码文件也带 service/entrypoint
      // 信号（express 的 test/app.route.js 撞 route、bench/*.ts 兜底 service），信号只回答
      // 「想看什么」，本策略回答「不看什么」。
      .filter((entry) => selectionNoiseKind(entry.path) === null)
      .filter((entry) => entry.signals.some((signal) => interestingSignals.has(signal)))
      .sort((a, b) => candidatePriority(a) - candidatePriority(b) || basename(a.path).localeCompare(basename(b.path)));
    for (const entry of candidates) {
      try {
        await this.selectFile(index, state, entry.path, entry.signals, reasonFor(entry.signals), subtreeKey);
      } catch (error) {
        if (error instanceof SourceIndexError && ["path_pruned", "binary_source", "blob_too_large"].includes(error.code)) continue;
        throw error;
      }
    }
  }

  private async selectFile(index: OpenedRemoteSourceRevision, state: SlicePlanningState, path: string, signals: SourceSignal[], reason: SelectedSourceReason, subtreeKey: string) {
    if (state.selected.has(path) || state.budgetsRemaining.selectedFiles <= 0 || state.budgetsRemaining.selectedLineRanges <= 0 || state.budgetsRemaining.plannerContentBytes <= 0) return;
    if ((state.subtreeSelections.get(subtreeKey) ?? 0) >= subtreeCap(state, subtreeKey)) return;
    const lineEnd = Math.min(maxPlannerLinesPerFile, state.budgetsRemaining.selectedLineRanges);
    const read = await index.readLines({
      path,
      startLine: 1,
      endLine: lineEnd,
      requestedBy: "profile",
      reason: `deterministic slice: ${reason}`,
    });
    state.fileContents.set(path, read.lines.join("\n"));
    state.budgetsRemaining.selectedFiles -= 1;
    state.budgetsRemaining.selectedLineRanges -= 1;
    state.budgetsRemaining.plannerContentBytes -= read.byteSize;
    state.subtreeSelections.set(subtreeKey, (state.subtreeSelections.get(subtreeKey) ?? 0) + 1);
    recordSelection(state, {
      path,
      blobSha: read.blobSha,
      treeEntrySha: read.treeEntrySha,
      byteSize: read.byteSize,
      startLine: read.startLine,
      endLine: read.endLine,
      lines: read.lines,
      reason,
      purpose: reason,
      signals,
      claim: `${reason} source is available at the pinned revision`,
      // Profile-driven reads are backed by SHA-verified slices, so the claim confidence is high.
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
  now: () => number;
}

export function createSlicePlanner(options: SlicePlannerOptions): SlicePlanner {
  return new DeterministicSlicePlanner(options.now);
}

export * from "./types";
