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
 *
 * 分步续跑（`publish --workdir`，修订稿 §5.1）：第 3 步的每个分区、第 4 步的枚举、理解层、第 5 步的每张流程图，
 * 一有结果就写进工作目录（lib/client-publish/run-store.ts）。中断后重跑同一条命令，做过的直接拿来用。
 * 给了工作目录但这一次的身份变了（提交、基线、语言、模型、客户端版本），之前的结果作废，从头来。
 */
import { basename } from "node:path";
import type { AnalysisResult, analyzeWithAI } from "../ai";
import { enumerateBehavioralChunks, type BehavioralEnumerationMetrics, type BehavioralEnumerationOutcome } from "../behavioral-enumeration";
import type { RepositoryIdentity, RepositoryProvider } from "../client-proposal/contract";
import { sealProposal, type Proposal } from "../client-proposal/contract";
import { isSchemaArtifact } from "../evidence";
import { generateFeatureFlowGraph } from "../feature-flow-generation";
import { behavioralChangePaths } from "../patch-scan";
import type { PrivacyHit, PrivacyRule, SourceText } from "../privacy-scan";
import { createSourceIndex, scanValue } from "../privacy-scan";
import { CLIENT_PROMPT_VERSION } from "../prompt-policy";
import type { getPartitionedAnalysisSources } from "../remote-analysis";
import type { RemoteSourceBackend, SourceScopeRoot } from "../remote-source-index";
import { specFeatureKey } from "../spec-diff";
import { FlowValidationError, scenarioFingerprint } from "../semantic-feature-flow";
import type { StructuredCompletionClient } from "../llm-client";
import { executeSnapshotWorkOrder, finalizeSnapshotAnalysis, prepareSnapshotAnalysis, type SnapshotExecution } from "../snapshot/workflow";
import { runGit } from "../snapshot/git";
import { createLocalGitBackend, resolveGitSnapshot } from "../snapshot/git-backend";
import type { SnapshotAnalysis, SnapshotIdentity, SnapshotProgressEvent } from "../snapshot/types";
import { prunePrivacyHits } from "./prune";
import { fingerprintOf, openPublishRun, type PublishRunStore } from "./run-store";
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
  /** 分步续跑的工作目录（`publish --workdir`）。不给就不落盘，一次跑完。 */
  workdir?: string;
  /** 测试注入。 */
  analyze?: typeof analyzeWithAI;
  loadPartitions?: typeof getPartitionedAnalysisSources;
}

/** 这次有多少是直接从工作目录拿来的。没有工作目录时都是零。 */
export interface ReusedWork {
  partitions: number;
  flows: number;
  enumeration: boolean;
  presentation: boolean;
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
  reused: ReusedWork;
  /** 这一次分析开始的时间。有工作目录时取自它的记录，所以重跑同一次得到的提案一字不差。 */
  startedAt: string;
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
export function plainSource(content: string): string {
  const lines = content.split("\n");
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  const numbered = nonEmpty.filter((line) => /^\d+: /.test(line)).length;
  return nonEmpty.length > 0 && numbered / nonEmpty.length >= 0.5 ? lines.map((line) => line.replace(/^\d+: /, "")).join("\n") : content;
}

/** 本次读过的全部源码：分区里的每个文件，加上变更窗口里还在的每个文件（行为面枚举读的是它们的改动区附近）。 */
export async function sourceTexts(repositoryRoot: string, analysis: Pick<SnapshotAnalysis, "partitions">, files: readonly WindowFileInput[], targetSha: string): Promise<SourceText[]> {
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

/** 条目文件名只用功能键里的安全字符，再接一段功能键的指纹，不同的功能不会撞名。 */
function flowEntryName(featureKey: string): string {
  return `${featureKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "feature"}-${fingerprintOf(featureKey).slice(0, 12)}`;
}

async function generateFlows(result: AnalysisResult, client: StructuredCompletionClient, language: "zh-CN" | "en", store: PublishRunStore | null, onProgress?: (event: ProduceProgress) => void): Promise<{ flows: Proposal["flows"]; reused: number }> {
  const flows: Proposal["flows"] = [];
  let reused = 0;
  let cursor = 0;
  const features = result.features;
  await Promise.all(Array.from({ length: Math.min(FLOW_WORKERS, features.length) }, async () => {
    while (cursor < features.length) {
      const feature = features[cursor++];
      const featureStableKey = specFeatureKey(feature.name);
      const fingerprint = scenarioFingerprint(feature.scenarios);
      const name = `flows/${flowEntryName(featureStableKey)}.json`;
      // 这张图之前已经生成过，场景也没变：不调模型。
      const finished = store ? await store.read<Proposal["flows"][number]>(name, fingerprint) : null;
      if (finished) {
        flows.push(finished);
        reused += 1;
        continue;
      }
      try {
        const graph = await generateFeatureFlowGraph(feature, undefined, language, { client, noSourceOutput: true });
        const entry = { featureStableKey, fingerprint, graph };
        if (store) await store.write(name, fingerprint, entry);
        flows.push(entry);
      } catch (error) {
        // 校验不过的图不交；服务端那一栏按现有的空态解释。模型故障同样略过，不让一张图拖垮整次发布。
        if (!(error instanceof FlowValidationError)) console.warn("[client-publish] flow graph skipped", { feature: feature.name, message: error instanceof Error ? error.message.slice(0, 160) : String(error) });
      }
    }
  }));
  // 按功能排好序再交出去：几路并发生成的先后每次不同，而提案的哈希要只看内容。
  flows.sort((left, right) => (left.featureStableKey < right.featureStableKey ? -1 : left.featureStableKey > right.featureStableKey ? 1 : 0));
  onProgress?.({ stage: "flows", status: "complete", message: `${flows.length}/${features.length}` });
  return { flows, reused };
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

function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "";
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
  const detected = repositoryIdentityOf(remote, basename(repositoryRoot), { ...(options.provider ? { provider: options.provider } : {}) });
  const repository: RepositoryIdentity = bound
    ? { repositoryId: bound.repositoryId, provider: bound.provider as RepositoryProvider, host: bound.host ?? (bound.provider === "local" ? null : detected.host), owner: bound.owner, name: bound.name as string }
    : detected;
  const modelName = options.modelName ?? options.client.displayName ?? "unknown";
  const base: ProduceSummary = {
    decision,
    repository,
    dirty: snapshot.workingTreeDirty,
    pruned: [],
    flows: { generated: 0, rejected: 0 },
    enumeration: null,
    reused: { partitions: 0, flows: 0, enumeration: false, presentation: false },
    startedAt: new Date().toISOString(),
  };
  if (decision.action !== "publish") return base;
  const ledgerBase = options.product.currentRevisionSha === null ? null : { specVersionId: options.product.currentVersionId ?? 0, sha: options.product.currentRevisionSha };

  // 工作目录：记下这一次是给哪个提交、哪种语言、哪个模型做的。和上一次对不上，之前的结果就都不能用了。
  const run = options.workdir
    ? await openPublishRun(options.workdir, {
      repositoryRoot,
      productSlug: options.product.slug,
      targetSha,
      treeSha: snapshot.treeSha ?? "",
      base: ledgerBase,
      outputLanguage: options.outputLanguage,
      modelName,
      thinking: options.client.thinking,
      clientVersion: CLIENT_VERSION,
      pipelineVersion: CLIENT_PIPELINE_VERSION,
      promptVersion: CLIENT_PROMPT_VERSION,
    })
    : null;
  const store = run?.store ?? null;
  if (run) base.startedAt = run.startedAt;

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
  const prepared = await prepareSnapshotAnalysis({
    backend,
    identity,
    productName: options.product.name || options.product.slug,
    ...(options.scopeRoots?.length ? { scopeRoots: options.scopeRoots } : {}),
    outputLanguage: options.outputLanguage,
    noSourceOutput: true,
    ...(options.loadPartitions ? { loadPartitions: options.loadPartitions } : {}),
    ...(onProgress ? { onProgress: (event: SnapshotProgressEvent) => onProgress(event) } : {}),
  });
  // 每个分区做完就落盘。后面的分区要知道前面提取出了哪些功能名，所以沿用下来的结果也要计进去。
  const executions: SnapshotExecution[] = [];
  const knownFeatureNames = new Set<string>();
  for (const [partitionIndex, workOrder] of prepared.workOrders.entries()) {
    const current = partitionIndex + 1;
    const name = `partitions/${workOrder.id}.json`;
    const key = fingerprintOf(workOrder.sources.map((source) => [source.path, source.content]));
    const finished = store ? await store.read<SnapshotExecution>(name, key) : null;
    if (finished) {
      executions.push(finished);
      for (const feature of finished.result.features) knownFeatureNames.add(feature.name);
      base.reused.partitions += 1;
      onProgress?.({ stage: "partition", status: "complete", current, total: prepared.workOrders.length, message: "reused" });
      continue;
    }
    const partitionStartedAt = Date.now();
    onProgress?.({ stage: "partition", status: "start", current, total: prepared.workOrders.length });
    const execution = await executeSnapshotWorkOrder(workOrder, {
      client: options.client,
      previousFeatureNames: [...knownFeatureNames],
      onRetry: (error) => onProgress?.({ stage: "partition", status: "retry", current, total: prepared.workOrders.length, message: error.message.slice(0, 200) }),
      ...(options.analyze ? { analyze: options.analyze } : {}),
    });
    if (store) await store.write(name, key, execution);
    onProgress?.({ stage: "partition", status: "complete", current, total: prepared.workOrders.length, durationMs: Date.now() - partitionStartedAt, retries: execution.pass.retries });
    for (const feature of execution.result.features) knownFeatureNames.add(feature.name);
    executions.push(execution);
  }
  // 理解层是一次单独的模型调用，按提取结果的指纹记下来。
  const resultKey = fingerprintOf(executions.map((execution) => execution.result));
  const storedPresentation = store ? await store.read<unknown>("presentation.json", resultKey) : null;
  if (storedPresentation !== null) base.reused.presentation = true;
  const analysis = await finalizeSnapshotAnalysis(prepared, executions, {
    modelName,
    client: options.client,
    noSourceOutput: true,
    ...(storedPresentation !== null ? { presentation: storedPresentation } : {}),
  });
  if (store && storedPresentation === null && analysis.presentation?.status === "generated") await store.write("presentation.json", resultKey, analysis.presentation);

  onProgress?.({ stage: "window", status: "start" });
  const files = parseUnifiedDiff(await unifiedDiff(repositoryRoot, await windowBase(repositoryRoot, targetSha, decision.windowFrom, options.product.currentRevisionSha), targetSha));
  const window = windowOf(files);
  const change = { message: snapshot.message, committedAt: snapshot.committedAt, url: "", files };
  onProgress?.({ stage: "window", status: "complete", message: `${files.length}` });

  let result = analysis.result;
  const behavioralPaths = [...behavioralChangePaths(files)];
  if (behavioralPaths.length > 0) {
    onProgress?.({ stage: "enumerate", status: "start", message: `${behavioralPaths.length}` });
    const known = [...new Set(result.features.map((feature) => feature.name))];
    const enumerationKey = fingerprintOf({ behavioralPaths, files, known, outputLanguage: options.outputLanguage });
    const enumerationName = "enumeration.json";
    const storedEnumeration = store ? await store.read<BehavioralEnumerationOutcome>(enumerationName, enumerationKey) : null;
    const enumerated = storedEnumeration ?? await enumerateBehavioralChunks({
      behavioralPaths,
      files,
      index: analysis.index,
      change,
      knownFeatureNames: known,
      outputLanguage: options.outputLanguage,
      client: options.client,
      noSourceOutput: true,
    });
    if (store && storedEnumeration === null) await store.write(enumerationName, enumerationKey, enumerated);
    if (storedEnumeration !== null) base.reused.enumeration = true;
    base.enumeration = enumerated.metrics;
    const { mergeChunkResults } = await import("../extraction-merge");
    const chunks = [{ result }, ...enumerated.chunks.map((chunk) => ({ result: chunk.result }))];
    result = mergeChunkResults(chunks);
    onProgress?.({ stage: "enumerate", status: "complete", message: enumerated.metrics.status });
  }
  if (result.features.length === 0) throw new ClientPublishError("no_features", "the analysis produced no evidence-backed feature");

  onProgress?.({ stage: "flows", status: "start" });
  const generated = await generateFlows(result, options.client, options.outputLanguage, store, onProgress);
  const flows = generated.flows;
  base.reused.flows = generated.reused;
  const { coverageRatio: _ratio, ...coverage } = analysis.coverage;
  const fields: Record<string, unknown> = {
    contractVersion: "2.0.0",
    artifactKind: "codelphi-analysis-proposal",
    idempotencyKey: newIdempotencyKey(),
    mode: "full",
    language: options.outputLanguage,
    repository,
    revision: { sha: targetSha, treeSha: snapshot.treeSha, committedAt: snapshot.committedAt, title: snapshot.message.slice(0, 500), branch: snapshot.branch },
    base: ledgerBase,
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
      model: modelName,
      impactRulesVersion: CLIENT_IMPACT_RULES_VERSION,
      analyzedAt: base.startedAt,
    },
  };

  onProgress?.({ stage: "scan", status: "start" });
  const index = createSourceIndex(await sourceTexts(repositoryRoot, analysis, files, targetSha));
  base.pruned = privatize(fields, index);
  onProgress?.({ stage: "scan", status: "complete", message: `${base.pruned.length}` });
  base.flows = { generated: flows.length, rejected: result.features.length - flows.length };
  const proposal = sealProposal(fields);
  // `--prepare` 留给 `--finalize` 的两样东西。先写 summary 再写 proposal：finalize 两个都要有才认。
  if (store) {
    await store.write("summary.json", targetSha, { ...base });
    await store.write("proposal.json", proposal.proposalHash, proposal);
  }
  return { ...base, proposal };
}
