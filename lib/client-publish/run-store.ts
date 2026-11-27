/**
 * 分步续跑的落盘（修订稿 §5.1；沿用原规格 §16.2 的两个词：`--prepare` 生成，`--finalize` 合并并上传）。
 *
 * 一次全量要跑几十分钟，花的钱几乎都在模型调用上：分区提取、行为面枚举、理解层、流程图。所以每一样
 * 一有结果就立刻写进工作目录；中断之后重跑同一条命令，做过的直接拿来用，只补没做完的。
 *
 * 几条规则：
 * - 工作目录里放两样东西：`publish.json` 说明这一次是给哪个提交、哪个产品、哪种语言、哪个模型做的；
 *   `publish/` 下是一条条结果。别的命令（雷达快照）在工作目录里的文件不碰。
 * - 「这一次」的任何一项变了（提交、树、基线、语言、模型、客户端和提示词的版本），之前的结果就都不能用了：
 *   整个 `publish/` 清掉重来。不同模型做出的分区拼在一份提案里是不对的。
 * - 每条结果带着自己的键（输入的指纹）。输入变了的条目即使文件还在也不采用。
 * - 写文件先写同目录的临时文件再改名，读到的一定是完整的；读到坏文件、被手改过的文件都当没有。
 * - `--finalize` 只读不写、不调模型。读出来的提案要重新过一遍契约校验（含内容哈希），对不上就不上传。
 *
 * 工作目录里是分析的中间结果，含模型的原样输出（隐私扫描在最后一步才做）。它在本机、由用户自己指定，
 * 不进提交。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseProposal, type Proposal } from "../client-proposal/contract";

/** 一次分步续跑的身份。任何一项不同，就是另一次分析。 */
export interface PublishRunIdentity {
  repositoryRoot: string;
  productSlug: string;
  targetSha: string;
  treeSha: string;
  base: { specVersionId: number; sha: string } | null;
  outputLanguage: "zh-CN" | "en";
  modelName: string;
  /** 产品的源码根目录。换了它，窗口就不一样：之前做好的分区不能沿用。没配置就没有这一项。 */
  scopeRoots?: Array<{ path: string; label?: string; role?: string }>;
  /** 模型思考还是不思考。换了它，做完的分区就不能沿用：同一个分区在两种模式下给出的内容不一样。不带 thinking 参数的客户端没有这一项。 */
  thinking?: "enabled" | "disabled";
  clientVersion: string;
  pipelineVersion: string;
  promptVersion: string;
}

interface PublishRunDescriptor extends PublishRunIdentity {
  /** 这一次开始的时间。提案里的 analyzedAt 取它，重跑同一次得到的提案才一字不差。 */
  startedAt: string;
}

export type PublishRunErrorCode = "publish_not_prepared" | "publish_target_mismatch" | "publish_corrupt";

export class PublishRunError extends Error {
  readonly code: PublishRunErrorCode;

  constructor(code: PublishRunErrorCode, message: string) {
    super(message);
    this.name = "PublishRunError";
    this.code = code;
  }
}

const DESCRIPTOR = "publish.json";
const ENTRIES = "publish";

/** 给键用的稳定序列化：对象的键按字典序，不看写入顺序。不要求整数。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort();
  return `{${entries.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** 一段输入的指纹，用作结果条目的键。 */
export function fingerprintOf(input: unknown): string {
  return createHash("sha256").update(stableStringify(input), "utf8").digest("hex");
}

export interface PublishRunStore {
  /** 结果条目的目录。 */
  readonly directory: string;
  /** 读一条做完的结果。没有、读坏了、键对不上，都返回 null。 */
  read<T>(name: string, key: string): Promise<T | null>;
  /** 记一条做完的结果。先写临时文件再改名。 */
  write(name: string, key: string, value: unknown): Promise<void>;
}

interface Entry {
  key: string;
  value: unknown;
}

const SAME_IDENTITY: ReadonlyArray<keyof PublishRunIdentity> = [
  "repositoryRoot", "productSlug", "targetSha", "treeSha", "base", "outputLanguage", "modelName", "scopeRoots", "thinking", "clientVersion", "pipelineVersion", "promptVersion",
];

const sameIdentity = (left: PublishRunIdentity, right: PublishRunIdentity): boolean =>
  SAME_IDENTITY.every((field) => stableStringify(left[field]) === stableStringify(right[field]));

/** 条目的名字只允许是目录之内的相对路径。 */
function assertName(name: string): void {
  if (name === "" || name.startsWith("/") || name.endsWith("/") || /[\\\0]/.test(name) || name.split("/").some((part) => part === "" || part === ".." || part === ".")) {
    throw new Error(`entry name must stay inside the run directory: ${name}`);
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readEntry(path: string): Promise<Entry | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { key?: unknown }).key !== "string") return null;
    return parsed as Entry;
  } catch {
    return null;
  }
}

const storeIn = (directory: string): PublishRunStore => ({
  directory,
  async read<T>(name: string, key: string): Promise<T | null> {
    assertName(name);
    const entry = await readEntry(join(directory, name));
    return entry && entry.key === key ? (entry.value as T) : null;
  },
  async write(name: string, key: string, value: unknown): Promise<void> {
    assertName(name);
    await writeAtomically(join(directory, name), JSON.stringify({ key, value } satisfies Entry));
  },
});

/**
 * 打开一次分步续跑。工作目录里已经有同一次分析的记录就接着做（resumed 为 true），否则清掉旧记录重新开始。
 * 身份认不出来的工作目录（没有说明文件、文件坏了）也按新的一次处理。
 */
export async function openPublishRun(workdir: string, identity: PublishRunIdentity): Promise<{ store: PublishRunStore; resumed: boolean; startedAt: string }> {
  const descriptorPath = join(workdir, DESCRIPTOR);
  const directory = join(workdir, ENTRIES);
  let existing: PublishRunDescriptor | null = null;
  try {
    existing = JSON.parse(await readFile(descriptorPath, "utf8")) as PublishRunDescriptor;
    if (typeof existing !== "object" || existing === null || typeof existing.startedAt !== "string") existing = null;
  } catch {
    existing = null;
  }
  if (existing && sameIdentity(existing, identity)) return { store: storeIn(directory), resumed: true, startedAt: existing.startedAt };
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  await writeAtomically(descriptorPath, JSON.stringify({ ...identity, startedAt } satisfies PublishRunDescriptor));
  return { store: storeIn(directory), resumed: false, startedAt };
}

const PROPOSAL_ENTRY = "proposal.json";
const SUMMARY_ENTRY = "summary.json";

/** `--prepare` 留给 `--finalize` 看的东西：提案本身，和给人看的几项计数。提案不含在 summary 里。 */
export type PreparedPublishSummary = Omit<import("./produce").ProduceSummary, "proposal">;

export interface PreparedPublish {
  proposal: Proposal;
  summary: PreparedPublishSummary;
  startedAt: string;
}

/**
 * 取出 `--prepare` 做好的提案，`--finalize` 用。只读。
 * 工作目录里没有这个产品、这个仓库的准备结果，或者准备没做完，是 publish_not_prepared；
 * 准备的是另一个提交，是 publish_target_mismatch——那份提案仍然是对的，但不能在不知不觉中发出去；
 * 提案和它自己的哈希对不上，是 publish_corrupt。
 */
export async function loadPreparedPublish(workdir: string, expected: { repositoryRoot: string; productSlug: string; targetSha: string }): Promise<PreparedPublish> {
  let descriptor: PublishRunDescriptor;
  try {
    descriptor = JSON.parse(await readFile(join(workdir, DESCRIPTOR), "utf8")) as PublishRunDescriptor;
  } catch {
    throw new PublishRunError("publish_not_prepared", `nothing has been prepared in ${workdir}; run publish with --prepare first`);
  }
  if (typeof descriptor !== "object" || descriptor === null || typeof descriptor.startedAt !== "string" || descriptor.repositoryRoot !== expected.repositoryRoot || descriptor.productSlug !== expected.productSlug) {
    throw new PublishRunError("publish_not_prepared", `${workdir} holds a prepared publish for another repository or product; run publish with --prepare first`);
  }
  if (descriptor.targetSha !== expected.targetSha) {
    throw new PublishRunError("publish_target_mismatch", `${workdir} was prepared for commit ${descriptor.targetSha.slice(0, 12)}, the repository is now at ${expected.targetSha.slice(0, 12)}; check that commit out again or run publish with --prepare`);
  }
  const directory = join(workdir, ENTRIES);
  const proposalEntry = await readEntry(join(directory, PROPOSAL_ENTRY));
  const summaryEntry = await readEntry(join(directory, SUMMARY_ENTRY));
  if (!proposalEntry || !summaryEntry) throw new PublishRunError("publish_not_prepared", `the preparation in ${workdir} did not finish; run publish with --prepare again, finished work is reused`);
  try {
    // 和服务端同一套校验：形状、版本、内容哈希。工作目录里的文件被截断或手改过，都过不了。
    return { proposal: parseProposal(proposalEntry.value), summary: summaryEntry.value as PreparedPublishSummary, startedAt: descriptor.startedAt };
  } catch (error) {
    throw new PublishRunError("publish_corrupt", `the prepared proposal in ${workdir} no longer matches its own hash (${error instanceof Error ? error.message : String(error)}); run publish with --prepare again, finished work is reused`);
  }
}
