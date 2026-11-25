import { execFile, spawn } from "node:child_process";
import type { ChangedFile, FileStatus, ManifestEntry } from "./impact-classification";

/**
 * 从 Git 对象读一个提交窗口（规格 §7.1 的 Git Diff Contract）。
 *
 * 只读 Git 对象，不看工作区。diff 的参数按契约钉死，不依赖用户配置或平台默认值，
 * 同一窗口在任何环境下得到同一份清单。清单与补丁分两次调用生成，再按顺序逐段对应；
 * 不从补丁头行解析路径，因为头行的转义形态会随配置变化。
 */

export const DIFF_CONTRACT_VERSION = "git-diff-v1";

/** 与契约补丁命令同一组参数；试验另加 `--unified=0`，因为要的是精确的变更行而不是上下文。 */
const DIFF_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%"] as const;
/** 与 Git 自身的二进制启发式一致：前 8000 字节含 NUL。 */
const BINARY_SNIFF_BYTES = 8000;

const RAW_HEADER = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/;
/** 类型变化（文件与符号链接互换）按修改处理，具体由模式列说明。出现别的状态字母说明读不懂这份清单，直接失败。 */
const STATUS_BY_LETTER: Readonly<Record<string, FileStatus>> = { A: "added", D: "deleted", M: "modified", R: "renamed", T: "modified" };

function tokensOf(output: string): string[] {
  return output.split("\0").filter((token) => token !== "");
}

function present(modeOrSha: string): string | null {
  return modeOrSha.match(/^0+$/) ? null : modeOrSha;
}

export function parseRawDiff(output: string): ManifestEntry[] {
  const tokens = tokensOf(output);
  const entries: ManifestEntry[] = [];
  for (let i = 0; i < tokens.length; ) {
    const header = tokens[i++];
    const match = RAW_HEADER.exec(header);
    const status = match ? STATUS_BY_LETTER[match[5]] : undefined;
    if (!match || !status) throw new Error(`读不懂的 diff 清单记录：${header}`);
    const renamedFrom = status === "renamed" ? tokens[i++] : undefined;
    const path = tokens[i++];
    if (path === undefined) throw new Error(`diff 清单记录缺少路径：${header}`);
    const facts = { path, oldMode: present(match[1]), newMode: present(match[2]), oldBlobSha: present(match[3]), newBlobSha: present(match[4]) };
    // 只有重命名带旧路径。两个分支看上去一样，分别写是为了让类型收窄到各自的形状。
    if (renamedFrom === undefined) {
      if (status === "renamed") throw new Error(`diff 清单记录缺少路径：${header}`);
      entries.push({ ...facts, status, oldPath: null });
    } else {
      entries.push({ ...facts, status: "renamed", oldPath: renamedFrom });
    }
  }
  return entries;
}

/** numstat 只用来预筛二进制：被 `.gitattributes` 标成 `-diff` 的纯文本在这里也显示成 `-`，所以最终以 blob 内容为准。 */
export function parseNumStat(output: string): boolean[] {
  const flags: boolean[] = [];
  const tokens = tokensOf(output);
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i++];
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
    if (!match) throw new Error(`读不懂的 numstat 记录：${token}`);
    if (match[3] === "") i += 2; // 重命名：文件名一项为空，后面跟着新旧两个路径
    flags.push(match[1] === "-");
  }
  return flags;
}

/** 按文件边界切分补丁流。每行以 `diff --git` 开头处起一段，段数必须等于清单的记录数。 */
export function splitPatchStream(stream: string): string[] {
  const segments: string[] = [];
  let current: string[] | null = null;
  const lines = stream.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // git 的输出以换行结尾
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) segments.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) segments.push(current.join("\n"));
  return segments;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+/;

/** 变更前坐标下被替换或删除的行区间。纯插入没有旧行，不产生区间。 */
export function removedLineRanges(patch: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const line of patch.split("\n")) {
    const match = HUNK_HEADER.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

function gitText(repoRoot: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoRoot, "-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** 读 blob 的开头若干字节；够了就停，不为一个大文件把整个内容读进来。 */
function blobHead(repoRoot: string, sha: string, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repoRoot, "cat-file", "blob", sha], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let received = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (received >= limit) return;
      chunks.push(chunk);
      received += chunk.length;
      if (received >= limit) child.kill();
    });
    child.on("error", reject);
    child.on("close", () => resolve(Buffer.concat(chunks).subarray(0, limit)));
  });
}

async function blobIsBinary(repoRoot: string, sha: string | null): Promise<boolean> {
  return sha === null ? false : (await blobHead(repoRoot, sha, BINARY_SNIFF_BYTES)).includes(0);
}

export interface GitWindow {
  baseSha: string;
  headSha: string;
  files: ChangedFile[];
  /** 变更前坐标下被改动的行区间，按变更前的路径归档。只有需要重锚的证据才会用到它。 */
  removedLines: ReadonlyMap<string, readonly (readonly [number, number])[]>;
}

interface DiffOutputs {
  manifest: ManifestEntry[];
  binaryFlags: boolean[];
  patches: string[];
}

/** 三份输出的条数必须一致，否则补丁无法对应到清单。直接失败，不猜。 */
export function assertDiffOutputsAligned(counts: readonly [number, number, number]): void {
  if (new Set(counts).size !== 1) throw new Error(`diff 的三份输出对不上：清单 ${counts[0]} 条，numstat ${counts[1]} 条，补丁 ${counts[2]} 段`);
}

async function readDiffOutputs(repoRoot: string, baseSha: string, headSha: string): Promise<DiffOutputs> {
  const range = [baseSha, headSha, "--"];
  const [raw, numstat, patchStream] = await Promise.all([
    gitText(repoRoot, ["diff", ...DIFF_OPTIONS, "--no-abbrev", "--raw", "-z", ...range]),
    gitText(repoRoot, ["diff", ...DIFF_OPTIONS, "--numstat", "-z", ...range]),
    gitText(repoRoot, ["diff", ...DIFF_OPTIONS, "--unified=0", "--patch", ...range]),
  ]);
  const outputs = { manifest: parseRawDiff(raw), binaryFlags: parseNumStat(numstat), patches: splitPatchStream(patchStream) };
  assertDiffOutputsAligned([outputs.manifest.length, outputs.binaryFlags.length, outputs.patches.length]);
  return outputs;
}

/** numstat 只当预筛：被 `.gitattributes` 标成 `-diff` 的纯文本也显示成二进制，最终以 blob 内容为准。 */
async function toChangedFiles(repoRoot: string, manifest: readonly ManifestEntry[], binaryFlags: readonly boolean[], patches: readonly string[]): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  for (const [index, entry] of manifest.entries()) {
    const suspectedBinary = binaryFlags[index] && ((await blobIsBinary(repoRoot, entry.oldBlobSha)) || (await blobIsBinary(repoRoot, entry.newBlobSha)));
    files.push(toChangedFile(entry, suspectedBinary, patches[index]));
  }
  return files;
}

function toChangedFile(entry: ManifestEntry, binary: boolean, patch: string): ChangedFile {
  // 两个分支看上去一样，分别写是为了让类型收窄到各自的形状。
  return entry.status === "renamed" ? { ...entry, binary, patch } : { ...entry, binary, patch };
}

function collectRemovedLines(manifest: readonly ManifestEntry[], patches: readonly string[]): GitWindow["removedLines"] {
  const removedLines = new Map<string, readonly (readonly [number, number])[]>();
  manifest.forEach((entry, index) => {
    const contentChanged = entry.status !== "renamed" || entry.oldBlobSha !== entry.newBlobSha;
    if (!contentChanged) return;
    const ranges = removedLineRanges(patches[index]);
    if (ranges.length > 0) removedLines.set(entry.oldPath ?? entry.path, ranges);
  });
  return removedLines;
}

export async function readGitWindow(repoRoot: string, baseSha: string, headSha: string): Promise<GitWindow> {
  const { manifest, binaryFlags, patches } = await readDiffOutputs(repoRoot, baseSha, headSha);
  return { baseSha, headSha, files: await toChangedFiles(repoRoot, manifest, binaryFlags, patches), removedLines: collectRemovedLines(manifest, patches) };
}

/** 某个提交上每个 blob 的字节数。目录与子模块不计。 */
export async function readTreeSizes(repoRoot: string, sha: string): Promise<Map<string, number>> {
  const output = await gitText(repoRoot, ["ls-tree", "-r", "-l", "-z", sha]);
  const sizes = new Map<string, number>();
  for (const record of tokensOf(output)) {
    const match = /^[0-7]{6} blob [0-9a-f]+\s+(\d+)\t([\s\S]+)$/.exec(record);
    if (match) sizes.set(match[2], Number(match[1]));
  }
  return sizes;
}

export function isAncestor(repoRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoRoot, "merge-base", "--is-ancestor", ancestor, descendant], (error) => {
      if (!error) resolve(true);
      else if (error.code === 1) resolve(false);
      else reject(error);
    });
  });
}

/** 窗口里的提交，从旧到新。 */
export async function listCommits(repoRoot: string, baseSha: string, headSha: string): Promise<string[]> {
  return (await gitText(repoRoot, ["rev-list", "--reverse", `${baseSha}..${headSha}`])).split("\n").filter((line) => line !== "");
}

export async function countCommits(repoRoot: string, baseSha: string, headSha: string): Promise<number> {
  return Number((await gitText(repoRoot, ["rev-list", "--count", `${baseSha}..${headSha}`])).trim());
}
