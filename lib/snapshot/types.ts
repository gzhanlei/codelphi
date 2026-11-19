import type { OutputLanguage } from "../analysis-language";
import type { AnalysisResult } from "../ai";
import type { AnalysisCoverageReceipt } from "../analysis-coverage";
import type { EvidenceSanitizeSummary } from "../completeness-ledger";
import type { AnalysisPartition } from "../remote-analysis";
import type { OpenedRemoteSourceRevision } from "../remote-source-index";
import type { SnapshotEffectiveCoverage } from "./effective-coverage";

export interface SnapshotIdentity {
  source: "local" | "github";
  name: string;
  owner?: string;
  target: string;
  repositoryUrl?: string;
  revision: string;
  /** 内容寻址树哈希（BYO 导入「内容一致」锚；git-backend 已计算，本地分支透传）。 */
  treeSha?: string;
  /** 本地分析时记录的 origin 远端（归一化为 https，无 remote 时为空）。 */
  originRemote?: string | null;
  branch: string | null;
  message: string;
  committedAt: string;
  workingTreeDirty: boolean;
}

export interface SnapshotWarning {
  code: string;
  values?: Record<string, string | number | boolean | null>;
}

export interface SnapshotProgressEvent {
  stage: "plan" | "partition" | "presentation";
  status: "start" | "complete" | "retry" | "fallback";
  current?: number;
  total?: number;
  durationMs?: number;
  retries?: number;
  message?: string;
}

export interface SnapshotAnalysisPass {
  retries: number;
  sanitize: EvidenceSanitizeSummary;
}

export interface SnapshotMergeStats {
  changesTruncated: number;
  scenariosDeduped: number;
  featuresFolded: number;
}

export interface SnapshotScenarioRef {
  featureName: string;
  reference: string;
}

export interface SnapshotCoreCapability {
  id: string;
  name: string;
  summary: string;
  featureNames: string[];
  scenarioRefs: SnapshotScenarioRef[];
}

export interface SnapshotJourney {
  id: string;
  name: string;
  evidenceStatus: "scenario_composition";
  steps: SnapshotScenarioRef[];
}

export interface SnapshotConcept {
  id: string;
  name: string;
  summary: string;
  scenarioRefs: SnapshotScenarioRef[];
  relations: Array<{
    targetName: string;
    summary: string;
    scenarioRef: SnapshotScenarioRef;
  }>;
}

export interface SnapshotPresentation {
  status: "generated" | "fallback";
  tagline?: string;
  coreCapabilities: SnapshotCoreCapability[];
  journeys: SnapshotJourney[];
  concepts: SnapshotConcept[];
}

export interface SnapshotAnalysis {
  identity: SnapshotIdentity;
  language: OutputLanguage;
  generatedAt: string;
  modelName: string;
  result: AnalysisResult;
  partitions: AnalysisPartition[];
  index: OpenedRemoteSourceRevision;
  coverage: AnalysisCoverageReceipt;
  warnings: SnapshotWarning[];
  passes: SnapshotAnalysisPass[];
  mergeStats: SnapshotMergeStats;
  presentation?: SnapshotPresentation;
  effectiveCoverage?: SnapshotEffectiveCoverage;
  onProgress?: (event: SnapshotProgressEvent) => void;
}

export interface SnapshotEvidenceSnippet {
  id: string;
  path: string;
  citedStartLine: number | null;
  citedEndLine: number | null;
  lines: Array<{ number: number; text: string }>;
  truncated: boolean;
  unavailable: boolean;
  sourceUrl?: string;
}

export interface SnapshotCodebaseArea {
  path: string;
  featureNames: string[];
  scenarioCount: number;
  evidencePathCount: number;
}

export interface SnapshotReportData {
  schemaVersion: 1;
  language: OutputLanguage;
  snapshot: SnapshotIdentity;
  generatedAt: string;
  modelName: string;
  product: {
    description: string | null;
    evidence: AnalysisResult["product"]["evidence"];
  };
  features: AnalysisResult["features"];
  presentation?: SnapshotPresentation;
  codebaseNavigation: SnapshotCodebaseArea[];
  evidenceSnippets: SnapshotEvidenceSnippet[];
  coverage: AnalysisCoverageReceipt;
  effectiveCoverage?: SnapshotEffectiveCoverage;
  warnings: SnapshotWarning[];
  analysis: {
    partitions: number;
    retries: number;
    emptyPasses: number;
    droppedScenarios: number;
    scenariosDeduped: number;
    featuresFolded: number;
  };
}
