/**
 * 提案生产（修订稿 §5.4）：在客户端把一次全量分析做成可以上传的提案。
 *
 * 和服务端同一套函数，差别只在注入：
 *   1. 状态判定（lib/client-publish/state.ts）。
 *   2. 本地 git 取变更窗口：解析成文件项，用和服务端相同的两个函数算行为标志和行号区间。补丁文本不出本机。
 *   3. 分区提取（现有客户端已经这样跑）。
 *   4. 行为面枚举：只针对窗口里含行为变更的文件，和托管分析一样。
 *   5. 流程图：每个功能生成一张，校验不过的不交。
 *   6. 隐私扫描：拿本次读过的全部源码建索引，命中的场景或流程图剔除；落在账本必需的字段上就停下。
 *   7. 封装（sealProposal）：校验契约、算哈希。
 *
 * 全量提案在有基线时也带变更窗口：托管的沿用判定靠「含行为变更的路径集合」决定哪些旧场景不沿用，
 * 不带窗口的话，代码已经删掉的行为会以旧场景的形式留下来。
 */
import { basename } from "node:path";
import type { AnalysisResult } from "../ai";
import { enumerateBehavioralChunks, type BehavioralEnumerationMetrics } from "../behavioral-enumeration";
import type { RepositoryIdentity, RepositoryProvider } from "../client-proposal/contract";
import { sealProposal, type Proposal } from "../client-proposal/contract";
import { isSchemaArtifact } from "../evidence";
import { generateFeatureFlowGraph } from "../feature-flow-generation";
import { behavioralChangePaths } from "../patch-scan";
import type { PrivacyHit, PrivacyRule, SourceText } from "../privacy-scan";
import { createSourceIndex, scanValue } from "../privacy-scan";
import { CLIENT_PROMPT_VERSION } from "../prompt-policy";
import type { RemoteSourceBackend, SourceScopeRoot } from "../remote-source-index";
import { specFeatureKey } from "../spec-diff";
import { FlowValidationError, scenarioFingerprint } from "../semantic-feature-flow";
import type { StructuredCompletionClient } from "../llm-client";
import { analyzeProductSnapshot } from "../snapshot/analyze";
import { runGit } from "../snapshot/git";
import { createLocalGitBackend, resolveGitSnapshot } from "../snapshot/git-backend";
import type { SnapshotAnalysis, SnapshotIdentity, SnapshotProgressEvent } from "../snapshot/types";
import { prunePrivacyHits } from "./prune";
import { repositoryIdentityOf } from "./identity";
import type { ClientProduct } from "./server";
import { decidePublish, type CommitRelation, type PublishDecision } from "./state";
import { parseUnifiedDiff, windowOf, type WindowFileInput } from "./window";
import { CLIENT_IMPACT_RULES_VERSION, CLIENT_PIPELINE_VERSION, CLIENT_VERSION } from "./version";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FLOW_WORKERS = 3;
const SCAN_ROUNDS = 5;

export class ClientPublishError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "ClientPublishError";
  }
}

export type ProduceProgress =
  | SnapshotProgressEvent
  | { stage: "window" | "enumerate" | "flows" | "scan"; status: "start" | "complete"; message?: string };

export interface ProduceOptions {
  repositoryRoot: string;
  /** 服务端上下文里这个产品的那一项：账本当前提交、已绑定的仓库从这里来。 */
  product: ClientProduct;
  full: boolean;
  outputLanguage: "zh-CN" | "en";
  client: StructuredCompletionClient;
  modelName?: string;
  scopeRoots?: SourceScopeRoot[];
  /** 远端地址看不出是哪一家代码托管服务时，由用户指定。 */
  provider?: RepositoryProvider;
  onProgress?: (event: ProduceProgress) => void;
  /** 测试注入。 */
  analyze?: typeof analyzeProductSnapshot;
}

export interface ProduceSummary {
  decision: PublishDecision;
  proposal?: Proposal;
  repository: RepositoryIdentity;
  /** 工作区有没有未提交的改动。分析只读已提交的内容，所以不影响结果，但要告诉用户。 */
  dirty: boolean;
  /** 被隐私扫描剔掉的字段和命中的规则。 */
  pruned: Array<{ path: string; rules: PrivacyRule[] }>;
  flows: { generated: number; rejected: number };
  enumeration: BehavioralEnumerationMetrics | null;
}

async function exists(repositoryRoot: string, revision: string): Promise<boolean> {
  try {
    await runGit(["-C", repositoryRoot, "cat-file", "-e", `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function isAncestor(repositoryRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(["-C", repositoryRoot, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** 账本当前提交和目标提交的关系（§5.3）。账本的提交不在本地历史里时是 missing，和「互不为祖先」分开。 */
export async function relationOf(repositoryRoot: string, ledgerSha: string | null, targetSha: string): Promise<CommitRelation | null> {
  if (ledgerSha === null) return null;
  if (ledgerSha === targetSha) return "equal";
  if (!(await exists(repositoryRoot, ledgerSha))) return "missing";
  if (await isAncestor(repositoryRoot, ledgerSha, targetSha)) return "ledger_is_ancestor";
  if (await isAncestor(repositoryRoot, targetSha, ledgerSha)) return "target_is_ancestor";
  return "unrelated";
}

async function originRemote(repositoryRoot: string): Promise<string | null> {
  try {
    return (await runGit(["-C", repositoryRoot, "remote", "get-url", "origin"])).toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

/** 首次发布的窗口是该提交自己的改动（和托管首次分析的 `commits/{after}` 对齐）；根提交没有父提交，和空树比。 */
async function windowBase(repositoryRoot: string, targetSha: string, windowFrom: "parent" | "base", ledgerSha: string | null): Promise<string> {
  if (windowFrom === "base") return ledgerSha as string;
  return (await exists(repositoryRoot, `${targetSha}^`)) ? `${targetSha}^` : EMPTY_TREE;
}

async function unifiedDiff(repositoryRoot: string, from: string, to: string): Promise<string> {
  return (await runGit(
    ["-C", repositoryRoot, "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-M", "--unified=0", from, to, "--"],
    { maxBufferBytes: 256 * 1024 * 1024, timeoutMs: 120_000 },
  )).toString("utf8");
}

/** 分区里的源码是带行号的；模型看到的就是它。建索引前把行号去掉，才和提案里的文本对得上。 */
function plainSource(content: string): string {
  const lines = content.split("\n");
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  const numbered = nonEmpty.filter((line) => /^\d+: /.test(line)).length;
  return nonEmpty.length > 0 && numbered / nonEmpty.length >= 0.5 ? lines.map((line) => line.replace(/^\d+: /, "")).join("\n") : content;
}

/** 本次读过的全部源码：分区里的每个文件，加上变更窗口里还在的每个文件（行为面枚举读的是它们的改动区附近）。 */
async function sourceTexts(repositoryRoot: string, analysis: SnapshotAnalysis, files: readonly WindowFileInput[], targetSha: string): Promise<SourceText[]> {
  const sources = new Map<string, string>();
  for (const partition of analysis.partitions) for (const source of partition.sources) sources.set(source.path, plainSource(source.content));
  for (const file of files) {
    if (file.status === "removed" || sources.has(file.path)) continue;
    try {
      const text = (await runGit(["-C", repositoryRoot, "show", `${targetSha}:${file.path}`], { maxBufferBytes: 16 * 1024 * 1024 })).toString("utf8");
      // 二进制文件不进比对：里面没有模型会抄出来的「行」。
      if (!text.includes("\0")) sources.set(file.path, text);
    } catch {
      // 读不到就不比对这个文件。
    }
  }
  return [...sources].map(([path, text]) => ({ path, text }));
}

async function generateFlows(result: AnalysisResult, client: StructuredCompletionClient, language: "zh-CN" | "en", onProgress?: (event: ProduceProgress) => void): Promise<Proposal["flows"]> {
  const flows: Proposal["flows"] = [];
  let rejected = 0;
  let cursor = 0;
  const features = result.features;
  await Promise.all(Array.from({ length: Math.min(FLOW_WORKERS, features.length) }, async () => {
    while (cursor < features.length) {
      const feature = features[cursor++];
      try {
        const graph = await generateFeatureFlowGraph(feature, undefined, language, { client, noSourceOutput: true });
        flows.push({ featureStableKey: specFeatureKey(feature.name), fingerprint: scenarioFingerprint(feature.scenarios), graph });
      } catch (error) {
        // 校验不过的图不交；服务端那一栏按现有的空态解释。模型故障同样略过，不让一张图拖垮整次发布。
        rejected += 1;
        if (!(error instanceof FlowValidationError)) console.warn("[client-publish] flow graph skipped", { feature: feature.name, message: error instanceof Error ? error.message.slice(0, 160) : String(error) });
      }
    }
  }));
  onProgress?.({ stage: "flows", status: "complete", message: `${flows.length}/${features.length}` });
  return flows;
}

/**
 * 剔除命中的场景和流程图，重扫，直到扫不出东西为止。落在账本必需字段上的命中剔除不了：停下，让用户调整后重跑。
 */
function privatize(fields: Record<string, unknown>, index: ReturnType<typeof createSourceIndex>): ProduceSummary["pruned"] {
  const pruned: ProduceSummary["pruned"] = [];
  for (let round = 0; round < SCAN_ROUNDS; round += 1) {
    const hits = scanValue(fields, index);
    if (hits.length === 0) return pruned;
    const result = prunePrivacyHits(fields, hits);
    if (result.blocked.length > 0) {
      throw new ClientPublishError(
        "privacy_hit_in_required_field",
        "the proposal quotes source code in a field the ledger needs (product description or release information); run the analysis again",
        result.blocked,
      );
    }
    pruned.push(...result.dropped);
  }
  const remaining = scanValue(fields, index);
  if (remaining.length > 0) throw new ClientPublishError("privacy_hits_remain", "the proposal still contains text that looks like source code", remaining.map((hit) => ({ path: hit.path, rule: hit.rule })));
  return pruned;
}

export async function produceProposal(options: ProduceOptions): Promise<ProduceSummary> {
  const onProgress = options.onProgress;
  const snapshot = await resolveGitSnapshot(options.repositoryRoot);
  const repositoryRoot = snapshot.repoRoot;
  const targetSha = snapshot.revision;
  const relation = await relationOf(repositoryRoot, options.product.currentRevisionSha, targetSha);
  const decision = decidePublish({ hasLedger: options.product.currentRevisionSha !== null, relation: relation ?? "unrelated", full: options.full });

  const remote = await originRemote(repositoryRoot);
  const bound = options.product.repository;
  const repository: RepositoryIdentity = bound
    ? { repositoryId: bound.repositoryId, provider: bound.provider as RepositoryProvider, host: bound.host, owner: bound.owner, name: bound.name as string }
    : repositoryIdentityOf(remote, basename(repositoryRoot), { ...(options.provider ? { provider: options.provider } : {}) });
  const base: ProduceSummary = { decision, repository, dirty: snapshot.workingTreeDirty, pruned: [], flows: { generated: 0, rejected: 0 }, enumeration: null };
  if (decision.action !== "publish") return base;

  const identity: SnapshotIdentity = {
    source: "local",
    name: basename(repositoryRoot),
    target: repositoryRoot,
    treeSha: snapshot.treeSha,
    revision: targetSha,
    branch: snapshot.branch,
    message: snapshot.message,
    committedAt: snapshot.committedAt,
    workingTreeDirty: snapshot.workingTreeDirty,
    ...(remote ? { originRemote: remote, repositoryUrl: remote } : {}),
  };
  const backend: RemoteSourceBackend = createLocalGitBackend(snapshot);
  const analysis = await (options.analyze ?? analyzeProductSnapshot)({
    backend,
    identity,
    productName: options.product.name || options.product.slug,
    ...(options.scopeRoots?.length ? { scopeRoots: options.scopeRoots } : {}),
    outputLanguage: options.outputLanguage,
    client: options.client,
    noSourceOutput: true,
    ...(onProgress ? { onProgress: (event: SnapshotProgressEvent) => onProgress(event) } : {}),
  });

  onProgress?.({ stage: "window", status: "start" });
  const files = parseUnifiedDiff(await unifiedDiff(repositoryRoot, await windowBase(repositoryRoot, targetSha, decision.windowFrom, options.product.currentRevisionSha), targetSha));
  const window = windowOf(files);
  const change = { message: snapshot.message, committedAt: snapshot.committedAt, url: "", files };
  onProgress?.({ stage: "window", status: "complete", message: `${files.length}` });

  let result = analysis.result;
  const behavioralPaths = [...behavioralChangePaths(files)];
  if (behavioralPaths.length > 0) {
    onProgress?.({ stage: "enumerate", status: "start", message: `${behavioralPaths.length}` });
    const { mergeChunkResults } = await import("../extraction-merge");
    const enumerated = await enumerateBehavioralChunks({
      behavioralPaths,
      files,
      index: analysis.index,
      change,
      knownFeatureNames: [...new Set(result.features.map((feature) => feature.name))],
      outputLanguage: options.outputLanguage,
      client: options.client,
      noSourceOutput: true,
    });
    base.enumeration = enumerated.metrics;
    const chunks = [{ result }, ...enumerated.chunks.map((chunk) => ({ result: chunk.result }))];
    result = mergeChunkResults(chunks);
    onProgress?.({ stage: "enumerate", status: "complete", message: enumerated.metrics.status });
  }
  if (result.features.length === 0) throw new ClientPublishError("no_features", "the analysis produced no evidence-backed feature");

  onProgress?.({ stage: "flows", status: "start" });
  const flows = await generateFlows(result, options.client, options.outputLanguage, onProgress);
  const { coverageRatio: _ratio, ...coverage } = analysis.coverage;
  const fields: Record<string, unknown> = {
    contractVersion: "2.0.0",
    artifactKind: "codelphi-analysis-proposal",
    idempotencyKey: newIdempotencyKey(),
    mode: "full",
    language: options.outputLanguage,
    repository,
    revision: { sha: targetSha, treeSha: snapshot.treeSha, committedAt: snapshot.committedAt, title: snapshot.message.slice(0, 500), branch: snapshot.branch },
    base: options.product.currentRevisionSha === null ? null : { specVersionId: options.product.currentVersionId ?? 0, sha: options.product.currentRevisionSha },
    window: {
      files: window.files,
      analyzedPaths: files.map((file) => file.path).filter((path) => !isSchemaArtifact(path)),
      skipped: files.filter((file) => isSchemaArtifact(file.path)).map((file) => ({ path: file.path, reason: "schema_artifact" })),
      affectedFeatureKeys: [],
    },
    proposal: result,
    carryClaims: [],
    coverage,
    flows,
    // 理解层没通过校验时客户端退回兜底。兜底只是一份功能索引，不随提案上传，服务端保留上一份。
    presentation: analysis.presentation?.status === "generated" ? analysis.presentation : null,
    client: {
      version: CLIENT_VERSION,
      pipelineVersion: CLIENT_PIPELINE_VERSION,
      promptVersion: CLIENT_PROMPT_VERSION,
      model: options.modelName ?? options.client.displayName ?? "unknown",
      impactRulesVersion: CLIENT_IMPACT_RULES_VERSION,
      analyzedAt: new Date().toISOString(),
    },
  };

  onProgress?.({ stage: "scan", status: "start" });
  const index = createSourceIndex(await sourceTexts(repositoryRoot, analysis, files, targetSha));
  base.pruned = privatize(fields, index);
  onProgress?.({ stage: "scan", status: "complete", message: `${base.pruned.length}` });
  base.flows = { generated: flows.length, rejected: result.features.length - flows.length };
  return { ...base, proposal: sealProposal(fields) };
}

function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "";
}
