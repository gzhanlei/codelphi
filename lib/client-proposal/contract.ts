/**
 * 提案契约 2.0.0（修订稿 §4.3、§4.6）。客户端和服务端共用这一份代码。
 *
 * 客户端分析把结果作为「提案」交给服务端；服务端不读源码、不调模型，用现有的合并逻辑落成规格版本和发布。
 * 提案体（proposal）与服务端模型输出的字段结构相同：复用 analysisSchema 的字段 schema，只去掉单次响应的集合数量上限。
 *
 * 三件事在这里一次做完：
 *   - 校验：schema 加一条「载荷里只出现整数」。比例由服务端用整数计数算，哈希的规范化因此不涉及浮点数。
 *   - 哈希：proposalHash 是整个载荷的 SHA-256，除了 idempotencyKey 和它自己。两边都是在校验之后的对象上算的，
 *     所以键的顺序、空白、客户端多带的字段都不影响结果。
 *   - 版本：contractVersion 不在支持范围里就拒绝，并带回最低支持的版本。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { analysisSchema } from "../ai";

export const PROPOSAL_CONTRACT_VERSION = "2.0.0";
export const PROPOSAL_ARTIFACT_KIND = "codelphi-analysis-proposal";

/**
 * 服务端同时接受的契约版本，新的在前。一次全量分析可能跑几十分钟，期间服务端可能更新，
 * 所以上一个版本的提案也收（修订稿 §6「可更新性」）。目前只有 2.0.0；提升版本时把旧的留在后面一位。
 */
export const MAX_SUPPORTED_CONTRACT_VERSIONS = [PROPOSAL_CONTRACT_VERSION] as const;
export const MIN_SUPPORTED_CONTRACT_VERSION = MAX_SUPPORTED_CONTRACT_VERSIONS[MAX_SUPPORTED_CONTRACT_VERSIONS.length - 1];

export const REPOSITORY_PROVIDERS = ["github", "gitlab", "gitee", "gitea", "local"] as const;
export type RepositoryProvider = (typeof REPOSITORY_PROVIDERS)[number];

export type ProposalErrorCode = "invalid_proposal" | "proposal_hash_mismatch" | "contract_version_mismatch";

export class ProposalContractError extends Error {
  constructor(
    readonly code: ProposalErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProposalContractError";
  }
}

const integer = z.number().int();
const nonNegative = integer.min(0);
const commitId = z.string().regex(/^[0-9a-f]{40}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hashValue = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** 仓库身份（修订稿 §6）：repositoryId 由服务端分配，第一次发布时为 null；纯本地仓库没有主机名和属主。 */
export const repositoryIdentitySchema = z
  .object({
    repositoryId: integer.positive().nullable(),
    provider: z.enum(REPOSITORY_PROVIDERS),
    host: z.string().min(1).max(191).nullable(),
    owner: z.string().min(1).max(191).nullable(),
    name: z.string().min(1).max(191),
  })
  .superRefine((repository, context) => {
    if (repository.provider === "local") {
      if (repository.host !== null) context.addIssue({ code: "custom", path: ["host"], message: "a local repository has no host" });
      if (repository.owner !== null) context.addIssue({ code: "custom", path: ["owner"], message: "a local repository has no owner" });
      return;
    }
    if (repository.host === null) context.addIssue({ code: "custom", path: ["host"], message: "a remote repository must name its host" });
    if (repository.owner === null) context.addIssue({ code: "custom", path: ["owner"], message: "a remote repository must name its owner" });
  });

const hunkSchema = z.object({
  oldStart: nonNegative,
  oldCount: nonNegative,
  newStart: nonNegative,
  newCount: nonNegative,
});

/** 变更窗口里的一个文件。path 是主路径：文件现在在哪，删除时是它原来在哪。行号区间与服务端的 PatchHunk 同形。 */
export const windowFileSchema = z.object({
  path: z.string().min(1).max(500),
  previousPath: z.string().min(1).max(500).nullable(),
  status: z.enum(["added", "modified", "removed", "renamed"]),
  behavioral: z.boolean(),
  hunks: z.array(hunkSchema),
});

/** 覆盖率回执：只有整数计数，比例由服务端算。 */
export const coverageReceiptSchema = z.object({
  implFilesAssembled: nonNegative,
  implFilesTotal: nonNegative,
  implBytesAssembled: nonNegative,
  implBytesTotal: nonNegative,
  partitionsUsed: nonNegative,
  partitionsCapped: z.boolean(),
  diffTotalPaths: nonNegative.nullable(),
  diffSelectedPaths: nonNegative.nullable(),
  diffOmittedPaths: nonNegative.nullable(),
  primaryRangesOmitted: nonNegative.nullable(),
});

/** 提案正文。features/scenarios 不设数量上限：这是合并后的全量结果，不是一次模型响应（analysisSchema 那边的 50/40 是单个响应的上限）。 */
const proposalFeatureSchema = analysisSchema.shape.features.element.extend({
  scenarios: z.array(analysisSchema.shape.features.element.shape.scenarios.element),
});
const proposalBodySchema = z.object({
  product: analysisSchema.shape.product,
  release: analysisSchema.shape.release,
  changes: analysisSchema.shape.changes,
  features: z.array(proposalFeatureSchema),
});

const shortVersion = z.string().min(1).max(64);

/** 不含 proposalHash 的提案。 */
const proposalFieldsSchema = z.object({
  contractVersion: z.string().min(1).max(32),
  artifactKind: z.literal(PROPOSAL_ARTIFACT_KIND),
  idempotencyKey: uuid,
  mode: z.enum(["full", "incremental"]),
  /** 提案文本的语言。规格版本的 output_language 按它记。 */
  language: z.enum(["zh-CN", "en"]),
  repository: repositoryIdentitySchema,
  revision: z.object({
    sha: commitId,
    treeSha: commitId.nullable(),
    committedAt: z.string().min(1).max(64),
    title: z.string().max(500),
    branch: z.string().max(191).nullable(),
  }),
  base: z.object({ specVersionId: integer.positive(), sha: commitId }).nullable(),
  window: z
    .object({
      files: z.array(windowFileSchema),
      analyzedPaths: z.array(z.string().min(1).max(500)),
      skipped: z.array(z.object({ path: z.string().min(1).max(500), reason: z.string().min(1).max(64) })),
      affectedFeatureKeys: z.array(z.string().min(1).max(191)),
    })
    .nullable(),
  proposal: proposalBodySchema,
  carryClaims: z.array(z.object({ featureKey: z.string().min(1).max(191), reason: z.literal("anchors_untouched") })),
  coverage: coverageReceiptSchema.nullable(),
  flows: z.array(z.object({ featureStableKey: z.string().min(1).max(191), fingerprint: z.string().min(1).max(64), graph: z.unknown() })),
  presentation: z.unknown(),
  // 客户端的说法，服务端不核对（修订稿 §6：来源信息分「服务端确认」和「客户端声明」两组）。
  client: z.object({
    version: shortVersion,
    pipelineVersion: shortVersion,
    promptVersion: shortVersion,
    model: z.string().min(1).max(200),
    impactRulesVersion: shortVersion,
    analyzedAt: z.string().min(1).max(64),
  }),
});

const proposalSchema = proposalFieldsSchema.extend({ proposalHash: hashValue });

export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;
export type WindowFile = z.infer<typeof windowFileSchema>;
export type CoverageReceiptInput = z.infer<typeof coverageReceiptSchema>;
/** 客户端交给 sealProposal 的东西：提案正文，还没有 proposalHash。 */
export type ProposalFields = z.infer<typeof proposalFieldsSchema>;
/** 封好的提案：正文加 proposalHash。上传的就是它。 */
export type Proposal = z.infer<typeof proposalSchema>;

/** 不参与哈希的两个字段：一个是每次上传操作的编号，一个是哈希自己。 */
const NOT_HASHED = new Set(["idempotencyKey", "proposalHash"]);

/**
 * 规范化 JSON：对象键按 UTF-16 码元升序，没有多余的空白，数组的顺序保留，null 保留，只出现整数。
 * undefined 的成员不写（和 JSON 一样），数组里的 undefined 记成 null。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
      if (!Number.isInteger(value)) throw new Error(`canonicalJson: only integers are allowed, got ${String(value)}`);
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return String(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
      const entries = Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: not a JSON value (${typeof value})`);
  }
}

/** 提案内容的 SHA-256。传入的是校验之后的完整提案（带不带那两个不参与哈希的字段都可以）。 */
export function proposalHashOf(proposal: Record<string, unknown>): string {
  const hashed: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(proposal)) if (!NOT_HASHED.has(key)) hashed[key] = item;
  return `sha256:${createHash("sha256").update(canonicalJson(hashed), "utf8").digest("hex")}`;
}

/** 载荷里任何一个不是整数的数都拒绝，包括 schema 没有逐字段声明的部分（流程图的图、理解层）。 */
function assertIntegersOnly(value: unknown, path: string): void {
  if (typeof value === "number" && !Number.isInteger(value)) throw new ProposalContractError("invalid_proposal", `${path} is ${String(value)}: the proposal carries integers only`);
  if (Array.isArray(value)) value.forEach((item, index) => assertIntegersOnly(item, `${path}[${index}]`));
  else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) assertIntegersOnly(item, path === "" ? key : `${path}.${key}`);
}

function isSupportedVersion(version: string): boolean {
  return (MAX_SUPPORTED_CONTRACT_VERSIONS as readonly string[]).includes(version);
}

function contractVersionOf(input: unknown): string | undefined {
  const version = typeof input === "object" && input !== null ? (input as { contractVersion?: unknown }).contractVersion : undefined;
  return typeof version === "string" ? version : undefined;
}

function unsupportedVersion(version: string): ProposalContractError {
  return new ProposalContractError("contract_version_mismatch", `proposal contract ${version} is not supported`, {
    minSupportedContractVersion: MIN_SUPPORTED_CONTRACT_VERSION,
    supported: MAX_SUPPORTED_CONTRACT_VERSIONS,
  });
}

/** 校验错误的说明里带上前几条出问题的字段路径，调用方不用去翻 details 就能知道哪里不对。 */
function invalidProposal(issues: readonly z.core.$ZodIssue[]): ProposalContractError {
  const shown = issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  return new ProposalContractError("invalid_proposal", `proposal failed schema validation: ${shown}`, issues.slice(0, 20));
}

/** 客户端用：校验提案正文，填上 proposalHash。校验不过就抛 ProposalContractError，什么也不上传。 */
export function sealProposal(input: Record<string, unknown>): Proposal {
  assertIntegersOnly(input, "");
  const parsed = proposalFieldsSchema.safeParse(input);
  const version = contractVersionOf(input);
  if (version !== undefined && !isSupportedVersion(version)) throw unsupportedVersion(version);
  if (!parsed.success) throw invalidProposal(parsed.error.issues);
  return proposalSchema.parse({ ...parsed.data, proposalHash: proposalHashOf(parsed.data) });
}

/** 服务端用：校验完整的提案，重算哈希并和客户端上报的比较。任何一处不对都抛 ProposalContractError。 */
export function parseProposal(input: unknown): Proposal {
  assertIntegersOnly(input, "");
  const preflight = proposalSchema.safeParse(input);
  const version = contractVersionOf(input);
  if (version !== undefined && !isSupportedVersion(version)) throw unsupportedVersion(version);
  if (!preflight.success) throw invalidProposal(preflight.error.issues);
  if (proposalHashOf(preflight.data) !== preflight.data.proposalHash) throw new ProposalContractError("proposal_hash_mismatch", "proposalHash does not match the proposal content");
  return preflight.data;
}
