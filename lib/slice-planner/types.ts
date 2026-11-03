import type { OpenedRemoteSourceRevision, SourceLineSlice, SourceRevisionSha, SourceScopeRoot, SourceSignal, SourceTreeEntry } from "../remote-source-index/types";

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

export interface SlicePlanResult {
  status: SliceRunStatus;
  slice?: SourceSlice;
  workspaceMap?: WorkspaceMap;
  missing: string[];
  diagnostics: PlannerDiagnostic[];
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
  evidenceClaims: EvidenceClaim[];
  questions: PlannerQuestion[];
  profileMatches: StackProfileMatch[];
  unresolved: string[];
  diagnostics: PlannerDiagnostic[];
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

export interface SourceTreeCandidate extends SourceTreeEntry {}
