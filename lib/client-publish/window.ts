/**
 * 变更窗口（修订稿 §4.3 的取法）：客户端在本地用 git 取补丁，解析成文件项，再用和服务端相同的两个函数
 * （behavioralChangePaths、parsePatchHunks）算出含行为变更的路径集合和行号区间。补丁文本只在本机内存里用，不上传。
 */
import { PLACEHOLDER_PATCH } from "../client-proposal/adapt";
import { unquotePath } from "./identity";
import type { WindowFile } from "../client-proposal/contract";
import { behavioralChangePaths } from "../patch-scan";
import { parsePatchHunks } from "../spec-diff";

/** 一个变更文件，带补丁文本。拿不到补丁文本时 patch 是占位串，和托管路径填的是同一个。 */
export interface WindowFileInput {
  path: string;
  previousPath: string | null;
  status: "added" | "modified" | "removed" | "renamed";
  patch: string;
}

const HEADER = "diff --git ";

/** `a/x`、`b/x` 是路径；`/dev/null` 表示这一侧没有文件。 */
function sidePath(reference: string): string | null {
  const value = unquotePath(reference.trim());
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

/** `diff --git a/x b/y`：取 b/ 后面那一段。只在文件没有 --- 和 +++ 两行时才用得上（只改了文件模式）。 */
function pathOfHeader(header: string): string | null {
  const body = header.slice(HEADER.length);
  const marker = body.indexOf(" b/");
  if (marker < 0) return null;
  const value = unquotePath(body.slice(marker + 3).trim());
  return value === "" ? null : value;
}

function parseBlock(lines: string[]): WindowFileInput | null {
  const rest = lines.slice(1);
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let added = false;
  let removed = false;
  let binary = false;
  let bodyStartsAt = rest.length;
  const modeLines: string[] = [];
  for (const [index, line] of rest.entries()) {
    // 文件头里的 --- 和 +++ 是路径。补丁正文里以 --- 开头的删除行排在 +++ 之后，不会被这里看到。
    if (line.startsWith("--- ")) {
      oldPath = sidePath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = sidePath(line.slice(4));
      bodyStartsAt = index + 1;
      break;
    }
    if (line.startsWith("rename from ")) renameFrom = line.slice("rename from ".length);
    else if (line.startsWith("rename to ")) renameTo = line.slice("rename to ".length);
    else if (line.startsWith("new file")) added = true;
    else if (line.startsWith("deleted file")) removed = true;
    else if (/^Binary files .* differ$/.test(line)) binary = true;
    else if (/^(old|new) mode /.test(line)) modeLines.push(line);
  }
  // 只改文件模式时没有 --- 和 +++ 两行，路径只能从 `diff --git a/x b/y` 里取。
  const path = newPath ?? renameTo ?? oldPath ?? pathOfHeader(lines[0]);
  if (path === null) return null;
  const body = rest.slice(bodyStartsAt).join("\n");
  // 拿不到补丁文本（纯改名、二进制）必须填占位串，不能填空串：占位串不是空串，这会影响行为判定（修订稿 §4.3）。
  const patch = !binary && body.trim() !== "" ? body : modeLines.length > 0 ? modeLines.join("\n") : PLACEHOLDER_PATCH;
  const status = added ? "added" : removed ? "removed" : renameFrom !== null && renameTo !== null ? "renamed" : "modified";
  return { path, previousPath: status === "renamed" ? renameFrom : null, status, patch };
}

/**
 * 把 `git diff --no-color -M --unified=0` 的输出解析成文件项。补丁正文和代码托管接口给的 patch 字段同形：
 * 只有 hunk，不带文件头。文件名里有换行的极端情况不在这里处理（git 会给这种路径加引号）。
 */
export function parseUnifiedDiff(text: string): WindowFileInput[] {
  if (text.trim() === "") return [];
  const blocks: string[][] = [];
  for (const line of text.replace(/\n$/, "").split("\n")) {
    if (line.startsWith(HEADER)) blocks.push([line]);
    else if (blocks.length > 0) blocks[blocks.length - 1].push(line);
  }
  return blocks.map(parseBlock).filter((file): file is WindowFileInput => file !== null);
}

/** 提案里的变更窗口：每个文件带行为标志和行号区间，外加含行为变更的路径集合。 */
export function windowOf(files: readonly WindowFileInput[]): { files: WindowFile[]; behavioralPaths: ReadonlySet<string> } {
  const behavioralPaths = behavioralChangePaths(files);
  return {
    files: files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      behavioral: behavioralPaths.has(file.path),
      // 占位串不是补丁，解析不出区间；占位串下的行号区间本来也不存在。
      hunks: file.patch === PLACEHOLDER_PATCH ? [] : parsePatchHunks(file.patch),
    })),
    behavioralPaths,
  };
}
