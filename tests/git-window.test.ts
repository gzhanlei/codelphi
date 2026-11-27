import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFile } from "../lib/impact-classification";
import {
  assertDiffOutputsAligned,
  countCommits,
  isAncestor,
  listCommits,
  parseRawDiff,
  readGitWindow,
  readTreeSizes,
  removedLineRanges,
  splitPatchStream,
} from "../lib/git-window";

/** 与 Git 自身的二进制启发式同一个界限：只看前 8000 字节。 */
const SNIFF_LIMIT = 8000;

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "trial", GIT_AUTHOR_EMAIL: "trial@example.com", GIT_COMMITTER_NAME: "trial", GIT_COMMITTER_EMAIL: "trial@example.com" },
  }).trim();
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codelphi-git-window-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  return root;
}

async function commitAll(root: string, message: string): Promise<string> {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("git-window 纯解析函数", () => {
  it("parses NUL-separated raw records, including a rename's two paths", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const zero = "0".repeat(40);
    const records = parseRawDiff(
      [`:100644 100755 ${a} ${b} M\0scripts/run.sh\0`, `:100644 100644 ${a} ${a} R100\0lib/b.ts\0lib/c.ts\0`, `:000000 100644 ${zero} ${b} A\0lib/new.ts\0`].join(""),
    );
    expect(records).toEqual([
      { oldMode: "100644", newMode: "100755", oldBlobSha: a, newBlobSha: b, status: "modified", oldPath: null, path: "scripts/run.sh" },
      { oldMode: "100644", newMode: "100644", oldBlobSha: a, newBlobSha: a, status: "renamed", oldPath: "lib/b.ts", path: "lib/c.ts" },
      { oldMode: null, newMode: "100644", oldBlobSha: null, newBlobSha: b, status: "added", oldPath: null, path: "lib/new.ts" },
    ]);
  });

  it("refuses a raw record it does not understand instead of guessing", () => {
    expect(() => parseRawDiff(":100644 100644 a b X\0x\0")).toThrow(/X/);
  });

  it("splits a patch stream on file boundaries without reading paths from headers", () => {
    const stream = [
      "diff --git a/a.ts b/a.ts",
      "@@ -1 +1 @@",
      "-l1",
      "+diff --git not a boundary",
      "diff --git a/b.md b/b.md",
      "@@ -2,0 +3 @@",
      "+x",
      "diff --git a/有 空格.md b/有 空格.md",
      "",
    ].join("\n");
    const segments = splitPatchStream(stream);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toContain("+diff --git not a boundary");
    expect(segments[2]).toBe("diff --git a/有 空格.md b/有 空格.md");
    expect(splitPatchStream("")).toEqual([]);
  });

  it("fails when the manifest, the numstat and the patch stream disagree on how many files changed", () => {
    expect(() => assertDiffOutputsAligned([1, 2, 1])).toThrow(/对不上：清单 1 条，numstat 2 条，补丁 1 段/);
    expect(() => assertDiffOutputsAligned([3, 3, 3])).not.toThrow();
  });

  it("reads the replaced old-side line ranges and skips pure insertions", () => {
    const patch = ["@@ -3,2 +3,0 @@", "-a", "-b", "@@ -10,0 +11,2 @@", "+x", "+y", "@@ -7 +9 @@", "-c", "+d"].join("\n");
    expect(removedLineRanges(patch)).toEqual([[3, 4], [7, 7]]);
    expect(removedLineRanges("@@ -0,0 +1 @@\n+new\n")).toEqual([]);
  });
});

describe("git-window 读窗口", () => {
  async function buildWindow() {
    const root = await createRepo();
    await mkdir(join(root, "lib"));
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "a.ts"), "l1\nl2\nl3\nl4\nl5\n");
    await writeFile(join(root, "lib/b.ts"), "x\ny\n");
    await writeFile(join(root, "lib/d.ts"), "p\nq\nr\ns\n");
    await writeFile(join(root, "docs/old.md"), "old doc\n");
    await writeFile(join(root, "scripts/run.sh"), "echo hi\n");
    await writeFile(join(root, "plain.txt"), "text\n");
    await writeFile(join(root, ".gitattributes"), "*.txt -diff\n");
    const base = await commitAll(root, "base");

    await writeFile(join(root, "a.ts"), "l1\nl2\nL3\nL4\nl5\n");
    await writeFile(join(root, "lib/new.ts"), "export const n = 1;\n");
    await rm(join(root, "docs/old.md"));
    await rename(join(root, "lib/b.ts"), join(root, "lib/c.ts"));
    await writeFile(join(root, "lib/e.ts"), "p\nq\nr\nS\n");
    await rm(join(root, "lib/d.ts"));
    await chmod(join(root, "scripts/run.sh"), 0o755);
    await symlink("a.ts", join(root, "link.ts"));
    await mkdir(join(root, "img"));
    // 两个二进制：一个 NUL 不在开头，一个开头就是 NUL。都不含 0x01，免得“检测 NUL”被换成“检测 0x01”也测不出来。
    await writeFile(join(root, "img/logo.png"), Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x02]));
    await writeFile(join(root, "img/font.woff2"), Buffer.from([0x00, 0x77, 0x4f, 0x46, 0x02]));
    await writeFile(join(root, "plain.txt"), "text changed\n");
    await writeFile(join(root, "plain-new.txt"), "fresh text\n");
    await writeFile(join(root, "plain-big.txt"), bigTextWithNulBeyond(SNIFF_LIMIT));
    const head = await commitAll(root, "head");
    const window = await readGitWindow(root, base, head);
    return { root, base, head, window, byPath: new Map(window.files.map((entry) => [entry.path, entry])) };
  }

  it("reads every kind of change with modes, blob ids and status", async () => {
    const { byPath } = await buildWindow();
    expect([...byPath.keys()].sort()).toEqual([
      "a.ts",
      "docs/old.md",
      "img/font.woff2",
      "img/logo.png",
      "lib/c.ts",
      "lib/e.ts",
      "lib/new.ts",
      "link.ts",
      "plain-big.txt",
      "plain-new.txt",
      "plain.txt",
      "scripts/run.sh",
    ]);
    expect(byPath.get("a.ts")).toMatchObject({ status: "modified", oldPath: null, oldMode: "100644", newMode: "100644", binary: false });
    expect(byPath.get("a.ts")?.patch).toContain("+L3");
    expect(byPath.get("docs/old.md")).toMatchObject({ status: "deleted", oldPath: null, newMode: null, newBlobSha: null, binary: false });
    expect(byPath.get("lib/new.ts")).toMatchObject({ status: "added", oldMode: null, oldBlobSha: null, binary: false });
    expect(byPath.get("lib/c.ts")).toMatchObject({ status: "renamed", oldPath: "lib/b.ts", binary: false });
    expect(byPath.get("lib/c.ts")?.oldBlobSha).toBe(byPath.get("lib/c.ts")?.newBlobSha);
    expect(byPath.get("lib/c.ts")?.patch ?? "").not.toMatch(/^@@/m);
    expect(byPath.get("lib/e.ts")).toMatchObject({ status: "renamed", oldPath: "lib/d.ts", binary: false });
    expect(byPath.get("lib/e.ts")?.oldBlobSha).not.toBe(byPath.get("lib/e.ts")?.newBlobSha);
    expect(byPath.get("lib/e.ts")?.patch).toContain("+S");
    expect(byPath.get("scripts/run.sh")).toMatchObject({ status: "modified", oldMode: "100644", newMode: "100755", binary: false });
    expect(byPath.get("link.ts")).toMatchObject({ status: "added", newMode: "120000", binary: false });
    expect(byPath.get("img/logo.png")).toMatchObject({ status: "added", binary: true });
  });

  it("decides binary by blob content, not by the patch git rendered", async () => {
    const { byPath } = await buildWindow();
    const forcedBinaryText = byPath.get("plain.txt");
    // 被 .gitattributes 标成 -diff 的纯文本：内容里没有 NUL，所以不是二进制。
    expect(forcedBinaryText).toMatchObject({ status: "modified", binary: false });
    // git 对它只能给出“Binary files differ”。读窗口如实保留这段输出，由分类器判定它不构成证据。
    expect(forcedBinaryText?.patch).toContain("Binary files");
    // 纯文本文件不在分析目标里（2026-11-27 起）：分类器判定它不构成证据。这不是因为它被判成了二进制——
    // binary 仍是 false，见上。
    const impact = classifyFile(forcedBinaryText!, new Map());
    expect(impact.classification).toBe("no_detected_behavior_change");
    expect(impact).toMatchObject({ reason: "outside_analysis_target" });
    expect(byPath.get("img/logo.png")).toMatchObject({ binary: true });
  });

  it("decides binary from the first 8000 bytes only, including a NUL in the very first byte", async () => {
    const { byPath } = await buildWindow();
    expect(byPath.get("img/logo.png")).toMatchObject({ binary: true });
    expect(byPath.get("img/font.woff2")).toMatchObject({ binary: true });
    expect(byPath.get("plain-big.txt")).toMatchObject({ status: "added", binary: false });
    // 新增的文件没有旧 blob：这一侧不能被当成“有 NUL”。
    expect(byPath.get("plain-new.txt")).toMatchObject({ status: "added", binary: false });
  });

  it("records the old-side lines each change replaced, keyed by the pre-change path", async () => {
    const { window } = await buildWindow();
    const lines = (path: string) => window.removedLines.get(path) ?? [];
    expect(lines("a.ts")).toEqual([[3, 4]]);
    expect(lines("docs/old.md")).toEqual([[1, 1]]);
    expect(lines("lib/d.ts")).toEqual([[4, 4]]);
    // 没有旧行被替换的文件（纯重命名、纯新增）不占键。
    expect([...window.removedLines.keys()].sort()).toEqual(["a.ts", "docs/old.md", "lib/d.ts"]);
    expect(lines("lib/b.ts")).toEqual([]);
    expect(lines("lib/new.ts")).toEqual([]);
  });

  it("sizes every blob at a commit and leaves out trees and gitlinks", async () => {
    const { root, head } = await buildWindow();
    const sizes = await readTreeSizes(root, head);
    expect(sizes.get("a.ts")).toBe("l1\nl2\nL3\nL4\nl5\n".length);
    expect(sizes.get("link.ts")).toBe("a.ts".length);
    expect(sizes.has("lib")).toBe(false);
  });

  it("tells ancestry and counts the commits of a window", async () => {
    const { root, base, head } = await buildWindow();
    await writeFile(join(root, "a.ts"), "l1\n");
    const second = await commitAll(root, "second");
    expect(await isAncestor(root, base, second)).toBe(true);
    expect(await isAncestor(root, second, base)).toBe(false);
    expect(await countCommits(root, base, head)).toBe(1);
    expect(await countCommits(root, base, second)).toBe(2);
  });

  it("lists the commits of a window oldest first", async () => {
    const { root, base } = await buildWindow();
    await writeFile(join(root, "a.ts"), "l1\n");
    const second = await commitAll(root, "second");
    await writeFile(join(root, "a.ts"), "l1\nl2\n");
    const third = await commitAll(root, "third");
    expect(await listCommits(root, base, third)).toEqual([expect.stringMatching(/^[0-9a-f]{40}$/), second, third]);
    expect(await listCommits(root, third, third)).toEqual([]);
  });

  it("yields no files for an empty window", async () => {
    const root = await createRepo();
    await writeFile(join(root, "a.ts"), "a\n");
    const base = await commitAll(root, "base");
    const window = await readGitWindow(root, base, base);
    expect(window.files).toEqual([]);
    expect(window.removedLines.size).toBe(0);
  });
});

/** 一段够长的 ASCII 文本，唯一的 NUL 落在 `beyond` 指定的位置之后。 */
function bigTextWithNulBeyond(beyond: number): Buffer {
  const bytes = Buffer.alloc(beyond + 1000, 0x41);
  bytes[beyond + 10] = 0x00;
  return bytes;
}
