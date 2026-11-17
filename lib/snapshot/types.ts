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

export interface SnapshotCoreCapability {
  id: string;
  name: string;
  summary: string;
  featureNames: string[];
  scenarioRefs: Array<{ featureName: string; reference: string }>;
}

export interface SnapshotPresentation {
  tagline?: string;
  coreCapabilities: SnapshotCoreCapability[];
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
