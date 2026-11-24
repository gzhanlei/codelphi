import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { WindowOutcome } from "../lib/impact-classification";
import type { TrialSummary } from "../lib/incremental-trial-metrics";
import type { StalePoint } from "../lib/incremental-trial-metrics";
import { GOLDEN_CATEGORIES } from "../lib/incremental-trial";
import {
  INCREMENTAL_WINDOW_THRESHOLD,
  TOKEN_SAVINGS_THRESHOLD,
  incrementalShare,
  liftTable,
  parseArgs,
  pickGolden,
  renderReport,
  run,
  summarizeStale,
  verdictOf,
  type TrialReport,
  type TrialWindowRow,
} from "../scripts/incremental-usability-trial";

function summary(overrides: Partial<TrialSummary> = {}): TrialSummary {
  return {
    windows: 0,
    incrementalWindows: 0,
    incrementalShare: null,
    meanTokenSavings: null,
    meanFeatureShareOfDirectWindows: null,
    exceedsFullWindows: 0,
    outcomeCounts: { direct: 0, no_behavior: 0, no_detected_behavior_change: 0, global_unbounded: 0, unknown: 0 },
    globalReasonCounts: {},
    ...overrides,
  };
}

const point = (overrides: Partial<StalePoint> = {}): StalePoint => ({
  newlyStale: 0,
  stale: 0,
  anchors: 10,
  staleShare: 0,
  recoveredByReanalysis: 0,
  recoveredByFullResync: 0,
  ...overrides,
});

const row = (index: number, overrides: Partial<TrialWindowRow> = {}): TrialWindowRow => ({
  repositoryId: 8,
  index,
  baseSha: `base-${index}`,
  headSha: `head-${index}`,
  linear: true,
  commits: 1,
  files: [],
  metrics: null,
  commitOutcomes: [],
  ...overrides,
});

describe("参数解析", () => {
  it("reads the ledger, the output directory, the primary repository and the clones", () => {
    expect(parseArgs(["--ledger", "a.jsonl", "--out", "run", "--primary", "8", "--repo", "8=/repos/a", "--repo", "11=/repos/b"])).toEqual({
      ledgerPath: "a.jsonl",
      outDir: "run",
      primaryRepositoryId: 8,
      repositories: [
        { repositoryId: 8, repoRoot: "/repos/a" },
        { repositoryId: 11, repoRoot: "/repos/b" },
      ],
    });
  });

  it("refuses a run that would silently measure the wrong thing", () => {
    expect(() => parseArgs(["--out", "run", "--primary", "8", "--repo", "8=/repos/a"])).toThrow(/--ledger/);
    expect(() => parseArgs(["--ledger", "a.jsonl", "--out", "run", "--primary", "x", "--repo", "8=/repos/a"])).toThrow(/--primary/);
    expect(() => parseArgs(["--ledger", "a.jsonl", "--primary", "8", "--repo", "8=/repos/a"])).toThrow(/--out/);
    expect(() => parseArgs(["--ledger", "a.jsonl", "--out", "run", "--primary", "8"])).toThrow(/--repo/);
    expect(() => parseArgs(["--ledger", "a.jsonl", "--out", "run", "--primary", "8", "--repo", "8=/repos/a", "--force"])).toThrow(/不认识的参数/);
    expect(() => parseArgs(["--ledger", "a.jsonl", "--out", "run", "--primary", "8", "--repo", "/repos/a"])).toThrow(/<仓库号>=<本地克隆路径>/);
    expect(() => parseArgs(["--ledger", "--out", "run"])).toThrow(/缺少取值/);
  });
});

describe("go/no-go 判定", () => {
  it("passes only when both primary metrics reach their thresholds", () => {
    expect(verdictOf(summary({ incrementalShare: INCREMENTAL_WINDOW_THRESHOLD, meanTokenSavings: TOKEN_SAVINGS_THRESHOLD })).passes).toBe(true);
    expect(verdictOf(summary({ incrementalShare: 0.9, meanTokenSavings: 0.3 })).passes).toBe(false);
    expect(verdictOf(summary({ incrementalShare: 0.5, meanTokenSavings: 0.9 })).passes).toBe(false);
    expect(verdictOf(summary()).passes).toBe(false);
  });

  it("says which threshold was missed", () => {
    const verdict = verdictOf(summary({ incrementalShare: 0.5, meanTokenSavings: 0.3 }));
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons[0]).toMatch(/可增量窗口比例 50\.0% 低于 70\.0%/);
    expect(verdict.reasons[1]).toMatch(/token 节省率 30\.0% 低于 50\.0%/);
  });

  it("takes the thresholds from the spec, not from this script's mood", () => {
    expect(INCREMENTAL_WINDOW_THRESHOLD).toBe(0.7);
    expect(TOKEN_SAVINGS_THRESHOLD).toBe(0.5);
  });
});

const metrics = (outcome: WindowOutcome, fastPathStale = 0) =>
  ({
    outcome,
    globalReasons: [],
    incremental: true,
    reanalyzedFeatures: outcome === "direct" ? 1 : 0,
    featureShare: 0,
    newImplementationFiles: 0,
    incrementalFiles: 0,
    incrementalBytes: 0,
    fullFiles: 0,
    fullBytes: 0,
    tokenSavings: 0,
    exceedsFull: false,
    fastPath: { stale: fastPathStale, touched: fastPathStale, nonBehavioralTouched: 0 },
  }) as NonNullable<TrialWindowRow["metrics"]>;

describe("stale 汇总", () => {
  it("counts new stale anchors on fast-path windows only, and sums what recovered them", () => {
    const points = [
      point({ newlyStale: 2, stale: 2, staleShare: 0.2 }),
      point({ newlyStale: 1, stale: 3, staleShare: 0.3 }),
      point({ stale: 1, staleShare: 0.1, recoveredByReanalysis: 2 }),
      point({ stale: 0, staleShare: 0, recoveredByFullResync: 1 }),
    ];
    expect(summarizeStale(points, ["no_behavior", "direct", "no_detected_behavior_change", "global_unbounded"])).toEqual({
      fastPathWindows: 2,
      // 第一个快速路径窗口新增 2 个，占 10 个锚点的 20%；第二个不是快速路径，新增的 1 个不计。
      meanNewlyStale: 1,
      meanNewlyStaleShare: 0.1,
      maxStaleShare: 0.3,
      finalStaleShare: 0,
      finalAnchors: 10,
      recoveredByReanalysis: 2,
      recoveredByFullResync: 1,
    });
  });

  it("gives the full share when a single carried anchor goes stale", () => {
    expect(summarizeStale([point({ newlyStale: 1, stale: 1, anchors: 1, staleShare: 1 })], ["no_behavior"])).toMatchObject({ meanNewlyStale: 1, meanNewlyStaleShare: 1 });
  });

  it("does not divide by zero when a fast path finds no anchor carried", () => {
    expect(summarizeStale([point({ anchors: 0, newlyStale: 0, staleShare: 0 })], ["no_behavior"])).toMatchObject({ meanNewlyStale: 0, meanNewlyStaleShare: 0 });
  });

  it("returns an empty summary for a repository without windows", () => {
    expect(summarizeStale([], [])).toMatchObject({ fastPathWindows: 0, meanNewlyStale: null, meanNewlyStaleShare: null, finalStaleShare: 0, finalAnchors: 0 });
  });
});

describe("如果某条全局规则可以封闭", () => {
  const full = (index: number, globalReasons: string[]) =>
    row(index, {
      metrics: {
        ...metrics("global_unbounded"),
        incremental: false,
        globalReasons: globalReasons as never,
      } as never,
    });

  it("counts the windows each rule triggers alone and with others, and the share if it were closed", () => {
    const rows = [
      row(0, { metrics: metrics("direct") }),
      full(1, ["schema_migration"]),
      full(2, ["schema_migration"]),
      full(3, ["schema_migration", "shared_module"]),
      full(4, ["shared_module"]),
    ];
    expect(liftTable(rows, summary({ windows: 5, incrementalWindows: 1, incrementalShare: 0.2 }))).toEqual([
      { reason: "schema_migration", alone: 2, withOthers: 1, incrementalShareIfClosed: 3 / 5 },
      { reason: "shared_module", alone: 1, withOthers: 1, incrementalShareIfClosed: 2 / 5 },
    ]);
  });

  it("stays empty when nothing forced a full resync", () => {
    expect(liftTable([row(0, { metrics: metrics("direct") })], summary({ windows: 1, incrementalWindows: 1, incrementalShare: 1 }))).toEqual([]);
  });
});

describe("Golden Repository 窗口", () => {
  it("keeps only the coordinates of each picked window", () => {
    const readme = row(3, { metrics: metrics("no_behavior"), files: [{ path: "README.md", oldPath: null, status: "modified", classification: "no_behavior", reason: "document", directFeatureKeys: [] }] });
    const picks = pickGolden([row(0), readme]);
    expect(picks.readme_only).toEqual({ index: 3, baseSha: "base-3", headSha: "head-3" });
    expect(picks.tests_only).toBeNull();
    expect(Object.keys(picks).sort()).toEqual(GOLDEN_CATEGORIES.map((category) => category.id).sort());
  });
});

describe("报告渲染", () => {
  const report: TrialReport = {
    thresholds: { incrementalWindow: INCREMENTAL_WINDOW_THRESHOLD, tokenSavings: TOKEN_SAVINGS_THRESHOLD },
    primaryRepositoryId: 8,
    repositories: [
      {
        repositoryId: 8,
        windows: 2,
        summary: summary({ windows: 2, incrementalWindows: 2, incrementalShare: 1, meanTokenSavings: 0.6, globalReasonCounts: { dependency_manifest: 1 } }),
        commitWindows: 5,
        commitIncrementalShare: 0.8,
        stale: { fastPathWindows: 1, meanNewlyStale: 1, meanNewlyStaleShare: 0.1, maxStaleShare: 0.1, finalStaleShare: 0, finalAnchors: 10, recoveredByReanalysis: 1, recoveredByFullResync: 0 },
        nonLinearWindows: [{ index: 0, baseSha: "abcdef12", headSha: "ffffffff" }],
        lift: [{ reason: "dependency_manifest", alone: 1, withOthers: 0, incrementalShareIfClosed: 1.5 }],
      },
    ],
    golden: Object.fromEntries(GOLDEN_CATEGORIES.map((category) => [category.id, null])),
    verdict: verdictOf(summary({ windows: 2, incrementalWindows: 2, incrementalShare: 1, meanTokenSavings: 0.6 })),
  };

  it("states the verdict, the thresholds and every section", () => {
    const text = renderReport(report);
    expect(text).toContain("**通过。**");
    expect(text).toContain("可增量窗口比例不低于 70.0%，预估 token 节省率不低于 50.0%");
    expect(text).toContain("| 8 | 2 | 1 | 100.0% | 60.0% |");
    expect(text).toContain("| 8 | dependency_manifest | 1 |");
    expect(text).toContain("| 8 | dependency_manifest | 1 | 0 | 150.0% |");
    expect(text).toContain("abcdef12 → ffffffff");
    expect(text).toContain("真实历史里没有找到，需要合成夹具");
    for (const heading of ["## 结论", "## 各仓库", "## 窗口归宿分布", "## 全量重同步的触发原因", "## 如果某条全局规则可以封闭", "## stale 锚点", "## 非线性窗口（不计入比例）", "## Golden Repository 的冻结窗口"]) {
      expect(text).toContain(heading);
    }
  });

  it("sorts full-resync reasons by how often they fire, and says so when there are none", () => {
    const withReasons = summary({ windows: 3, globalReasonCounts: { schema_migration: 1, dependency_manifest: 2 } });
    const text = renderReport({ ...report, repositories: [{ ...report.repositories[0], summary: withReasons }, { ...report.repositories[0], repositoryId: 11, summary: summary() }] });
    expect(text.indexOf("| 8 | dependency_manifest | 2 |")).toBeLessThan(text.indexOf("| 8 | schema_migration | 1 |"));
    expect(text).toContain("| 11 | （无） | 0 |");
    expect(text).not.toContain("| 8 | （无） |");
  });

  it("prints the stale numbers of a measured repository rather than the empty placeholder", () => {
    expect(renderReport(report)).toContain("| 8 | 1 | 1.00 | 10.0% | 10.0% | 0.0% | 1 | 0 |");
    const unmeasured = renderReport({ ...report, repositories: [{ ...report.repositories[0], stale: { ...report.repositories[0].stale, fastPathWindows: 0, meanNewlyStale: null, meanNewlyStaleShare: null } }] });
    expect(unmeasured).toContain("| 8 | 0 | 无 | 无 |");
  });

  it("leaves out the non-linear section when every window is linear", () => {
    const linear = { ...report, repositories: report.repositories.map((result) => ({ ...result, nonLinearWindows: [] })) };
    // 表头里本来就有“非线性窗口”这一列，所以只看小节标题在不在。
    expect(renderReport(linear)).not.toContain("## 非线性窗口");
  });
});

describe("按提交计的可增量比例", () => {
  it("counts direct and fast-path commits and reports null when there is nothing to measure", () => {
    expect(incrementalShare([])).toBeNull();
    expect(incrementalShare(["direct", "global_unbounded", "no_behavior", "no_detected_behavior_change", "unknown"])).toBe(3 / 5);
  });
});

describe("试验脚本端到端", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  // 在进程内直接调用编排函数。不把脚本当子进程跑：`npm test` 把临时目录设在项目里的长路径下，
  // tsx 在那里建不起通信用的 socket。
  it("runs from the ledger export to the report on a repository with three releases", async () => {
    const root = await mkdtemp(join(tmpdir(), "codelphi-trial-e2e-"));
    roots.push(root);
    const repo = join(root, "repo");
    await mkdir(join(repo, "lib"), { recursive: true });
    await mkdir(join(repo, "tests"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], {
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "trial", GIT_AUTHOR_EMAIL: "trial@example.com", GIT_COMMITTER_NAME: "trial", GIT_COMMITTER_EMAIL: "trial@example.com" },
      }).trim();
    const commit = (message: string) => {
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    await writeFile(join(repo, "lib/a.ts"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
    await writeFile(join(repo, "tests/a.test.ts"), "t1\nt2\nt3\nt4\nt5\nt6\nt7\nt8\nt9\nt10\n");
    await writeFile(join(repo, "README.md"), "hello\n");
    const base = commit("base");
    await writeFile(join(repo, "lib/a.ts"), "l1\nl2\nL3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
    await writeFile(join(repo, "tests/a.test.ts"), "t1\nt2\nT3\nt4\nt5\nt6\nt7\nt8\nt9\nt10\n");
    const middle = commit("middle");
    await writeFile(join(repo, "README.md"), "hello world\n");
    const head = commit("head");

    // 功能 a 的证据在 lib/a.ts 第 3 行和 tests/a.test.ts 第 5 行。三个发布版本的锚点相同。
    const release = (sha: string) =>
      JSON.stringify({ repositoryId: 8, sha, versionId: 1, features: [[1, "a"]], anchors: [["a", "lib/a.ts", 3, 3], ["a", "tests/a.test.ts", 5, 5]] });
    const ledger = join(root, "ledger.jsonl");
    await writeFile(ledger, [base, middle, head].map(release).join("\n") + "\n");
    const out = join(root, "out");

    const report = await run({ ledgerPath: ledger, primaryRepositoryId: 8, repositories: [{ repositoryId: 8, repoRoot: repo }], outDir: out });

    const [result] = report.repositories;
    // 第一个窗口是 direct：lib/a.ts 改了，功能 a 要重分析。第二个窗口只改了 README，是快速路径。
    // 可增量比例 100%，平均节省率恰好 50%：达到阈值就算通过。
    expect(report.verdict).toEqual({ incrementalShare: 1, tokenSavings: 0.5, passes: true, reasons: [] });
    expect(result).toMatchObject({ repositoryId: 8, windows: 2, commitWindows: 2, commitIncrementalShare: 1, nonLinearWindows: [] });
    expect(result.summary).toMatchObject({
      windows: 2,
      incrementalShare: 1,
      outcomeCounts: { direct: 1, no_behavior: 1 },
      meanFeatureShareOfDirectWindows: 1,
      // 第一个窗口要读 lib/a.ts 和功能 a 的另一份证据 tests/a.test.ts，比全量只读 lib/a.ts 还多，按全量计（节省 0）；第二个窗口不读源码（节省 100%）。
      exceedsFullWindows: 1,
      meanTokenSavings: 0.5,
    });
    // 重分析了功能 a，它的锚点随之刷新，没有留下 stale。
    expect(result.stale).toMatchObject({ fastPathWindows: 1, recoveredByReanalysis: 0, finalStaleShare: 0 });
    expect(report.golden.readme_only).toMatchObject({ index: 1, baseSha: middle, headSha: head });

    const saved = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    expect(saved).toEqual(report);
    expect(await readFile(join(out, "report.md"), "utf8")).toContain("**通过。**");
    const rows = (await readFile(join(out, "windows.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.linear, row.commits, row.commitOutcomes])).toEqual([
      [true, 1, ["direct"]],
      [true, 1, ["no_behavior"]],
    ]);
  });

  it("refuses a repository that the ledger export does not contain", async () => {
    const root = await mkdtemp(join(tmpdir(), "codelphi-trial-e2e-"));
    roots.push(root);
    const ledger = join(root, "ledger.jsonl");
    await writeFile(ledger, "");
    await expect(run({ ledgerPath: ledger, primaryRepositoryId: 8, repositories: [{ repositoryId: 8, repoRoot: root }], outDir: join(root, "out") })).rejects.toThrow(/没有仓库 8/);
  });
});
