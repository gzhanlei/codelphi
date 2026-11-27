import type { OpenedRemoteSourceRevision, SourceLineSlice, SourceRevisionSha, SourceScopeRoot, SourceSignal } from "../remote-source-index/types";

export type SlicePlannerVersion = string;
export type SliceProfileVersion = string;

export type SliceRunStatus = "completed" | "underdetermined" | "scope_ambiguous" | "failed";
export type SliceConfidence = "high" | "medium" | "low";

export type SlicePhase =
  | "scope_resolution"
  | "manifest_scan"
  | "entrypoint_scan"
  | "connected_expansion"
  | "profile_matching"
  | "targeted_exploration"
  | "done";

export type StackProfileId =
  | "next-web"
  | "react-web"
  | "node-api"
  | "go-api"
  | "fastapi-api"
  | "fastapi-python"
  | "django-app"
  | "spring-java"
  | "spring-service"
  | "android-kotlin"
  | "android-native"
  | "ios-native"
  | "rust-service"
  | "laravel-app"
  | "dotnet-services"
  | "unknown";

export interface ProductSliceInput {
  product: { id: number; slug: string; name: string };
  repository: { owner: string; repo: string; revision: SourceRevisionSha };
  scopeRoots: SourceScopeRoot[];
  budgets: SliceBudgets;
  plannerVersion: SlicePlannerVersion;
  profileVersion: SliceProfileVersion;
  previousSlice?: SourceSlice;
  /** 多趟提取：本趟排除此前分区已选的路径（在同一种子索引上重复规划即得下一分区）。 */
  excludePaths?: ReadonlySet<string>;
  /** 此前分区已经分析过的内容（git blob → 那份的路径）：内容相同的文件只分析一次，跨趟也算。 */
  excludeBlobs?: ReadonlyMap<string, string>;
  /** W0-7：窗口 diff 文件路径（行为证据的一手面）——分区装配必选，优先于遍历选择。 */
  diffPaths?: readonly string[];
  discovery?: "full" | "required_only";
  requiredPaths?: readonly string[];
}

export interface SliceBudgets {
  maxSelectedFiles: number;
  maxSelectedLineRanges: number;
  maxPlannerContentBytes: number;
  maxAiContextSourceBytes: number;
  maxAiReadCalls: number;
  maxComponents: number;
  maxConnections: number;
  maxRepairRounds: number;
}

export interface DetectedPackage {
  path: string;
  name?: string;
  kind: "web" | "api" | "worker" | "mobile" | "desktop" | "library" | "deployment" | "unknown";
  signals: SourceSignal[];
  manifestPaths: string[];
  confidence: number;
}

export interface WorkspaceMap {
  repository: string;
  revision: SourceRevisionSha;
  packages: DetectedPackage[];
  ambiguous: boolean;
  reason?: string;
}

export type ScopeResolutionStatus = "resolved" | "ambiguous" | "not_found";

export interface ScopeResolution {
  status: ScopeResolutionStatus;
  scopeRoots: SourceScopeRoot[];
  workspaceMap?: WorkspaceMap;
  unresolved: string[];
}

export interface StackProfileMatch {
  profileId: StackProfileId;
  confidence: number;
  matchedSignals: Array<{
    path: string;
    signal: SourceSignal;
    startLine?: number;
    endLine?: number;
  }>;
}

export interface SelectedLineRange {
  startLine: number;
  endLine: number;
  purpose: string;
}

export type SelectedSourceReason =
  | "scope_root"
  | "manifest"
  | "entrypoint"
  | "route"
  | "service"
  | "database"
  | "queue"
  | "auth"
  | "deployment"
  | "ai_targeted"
  | "window_diff"
  | "previous_slice_reuse";

export interface SelectedSourceFile {
  path: string;
  blobSha: string;
  treeEntrySha: string;
  reason: SelectedSourceReason;
  byteSize: number;
  lineRanges: SelectedLineRange[];
  signals: SourceSignal[];
}

export type EvidenceClaimKind = "component" | "relationship" | "scope" | "external_dependency" | "deployment_boundary";

export interface EvidenceClaim {
  kind: EvidenceClaimKind;
  ownerComponentId?: string;
  claim: string;
  path: string;
  startLine: number;
  endLine: number;
  quoteSha256: string;
  confidence: SliceConfidence;
}

export interface SliceMetrics {
  treeExpansions: number;
  blobFetches: number;
  selectedFiles: number;
  selectedLineRanges: number;
  selectedContentBytes: number;
  aiReadCalls: number;
  prunedPathCount: number;
  wallClockMs: number;
  profileMatches: StackProfileMatch[];
  budgetsRemaining: {
    selectedFiles: number;
    selectedLineRanges: number;
    plannerContentBytes: number;
    aiReadCalls: number;
  };
}

export interface SourceSlice {
  product: { id: number; slug: string; name: string };
  repository: string;
  revision: SourceRevisionSha;
  scopeRoots: SourceScopeRoot[];
  files: SelectedSourceFile[];
  evidenceClaims: EvidenceClaim[];
  workspaceMap?: WorkspaceMap;
  plannerVersion: SlicePlannerVersion;
  profileVersion: SliceProfileVersion;
  confidence: SliceConfidence;
  unresolved: string[];
  metrics: SliceMetrics;
}

export type PlannerDiagnosticCode =
  | "revision_not_found"
  | "tree_truncated"
  | "scope_root_not_found"
  | "scope_ambiguous"
  | "budget_exhausted"
  | "blob_too_large"
  | "blob_sha_mismatch"
  | "path_pruned"
  | "profile_confidence_low"
  | "required_entrypoint_missing"
  | "database_boundary_unverified"
  | "queue_boundary_unverified"
  | "deployment_boundary_unverified";

export interface PlannerDiagnostic {
  code: PlannerDiagnosticCode;
  subject?: string;
  message: string;
  evidence?: { path: string; startLine?: number; endLine?: number };
}

/**
 * 只看路径认不出来、要看目录清单或文件内容才知道的排除。报告给人看，也让覆盖率不把它们算成遗漏。
 * 测试、文档、迁移脚本这些只看路径就认得的，在 lib/analysis-target.ts 里，不在这里。
 */
export type SliceExclusionKind = "vendored" | "tooling" | "duplicate" | "generated";
export interface SliceExclusion {
  kind: SliceExclusionKind;
  /** 被排除的文件；整棵跳过的第三方目录是目录本身。 */
  path: string;
  /** 成块排除时它所在的那个目录：第三方目录、工具目录；内容重复时是保留下来的那份；生成文件是生成工具。 */
  detail?: string;
  /** 第三方目录的判据：带着别人家的许可证，还是像一个完整的上游项目。 */
  reason?: string;
}

export interface SlicePlanResult {
  status: SliceRunStatus;
  slice?: SourceSlice;
  workspaceMap?: WorkspaceMap;
  missing: string[];
  diagnostics: PlannerDiagnostic[];
  /** 走到选文件那一步才有；scope 没解析、预算耗尽这些提前返回的结果没有。 */
  excluded?: SliceExclusion[];
}

export type TargetedReadRequestedBy = "planner" | "profile" | "ai_explorer";

export interface TargetedReadRequest {
  path: string;
  startLine: number;
  endLine: number;
  requestedBy: TargetedReadRequestedBy;
  reason: string;
  expectedClaim?: { componentId?: string; relationshipId?: string; question: string };
}

export interface TargetedReadApproval {
  requestId: string;
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  remainingReadCalls: number;
  remainingContentBytes: number;
}

export type TargetedReadDecision =
  | { allowed: true; approval: TargetedReadApproval }
  | { allowed: false; code: PlannerDiagnosticCode | "read_request_invalid"; message: string };

export interface PlannerQuestion {
  id: string;
  question: string;
  kind: "runtime_entrypoint" | "database_boundary" | "queue_boundary" | "external_service" | "auth_boundary" | "deployment_boundary" | "component_ownership";
  status: "open" | "answered" | "unresolvable";
  evidenceClaimId?: string;
}

export interface SlicePlanningState {
  input: ProductSliceInput;
  revision: OpenedRemoteSourceRevision;
  phase: SlicePhase;
  scope: ScopeResolution;
  selected: Map<string, SelectedSourceFile>;
  fileContents: Map<string, string>;
  /** 子树份额记账：scope root 下第一段 → 已选文件数（上限 = ceil(maxSelectedFiles × 0.5)）。 */
  subtreeSelections: Map<string, number>;
  evidenceClaims: EvidenceClaim[];
  questions: PlannerQuestion[];
  profileMatches: StackProfileMatch[];
  unresolved: string[];
  diagnostics: PlannerDiagnostic[];
  excluded: SliceExclusion[];
  budgetsRemaining: {
    selectedFiles: number;
    selectedLineRanges: number;
    plannerContentBytes: number;
    aiReadCalls: number;
    startedAt: number;
  };
}

export interface SlicePlanner {
  resolveScope(input: ProductSliceInput, index: OpenedRemoteSourceRevision): Promise<ScopeResolution>;
  plan(input: ProductSliceInput, index: OpenedRemoteSourceRevision): Promise<SlicePlanResult>;
  evaluateTargetedRead(state: SlicePlanningState, request: TargetedReadRequest): TargetedReadDecision;
  applyTargetedRead(state: SlicePlanningState, approval: TargetedReadApproval, slice: SourceLineSlice): SlicePlanningState;
  finalize(state: SlicePlanningState): Promise<SlicePlanResult>;
}
