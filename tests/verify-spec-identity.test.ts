import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { compareDiffPairing, diffSpecWithFolded } from "../lib/spec-diff";
import {
  identityRowsOf,
  parseArgs,
  parseLedgerExport,
  renderReport,
  run,
  specOf,
  verifyLedger,
  type ExportedVersion,
} from "../scripts/verify-spec-identity";

let nextId = 1;
const id = () => nextId++;
const feature = (name: string, parentKey: string | null = null, source: "generated" | "manual" = "generated") => ({ id: id(), name, summary: `${name} summary`, parentKey, source, position: 0 });
const scenario = (featureId: number, reference: string, outcome = "Works") => ({ id: id(), featureId, reference, context: "User", action: "Does it", outcome, category: "happy", step: null, source: "generated" as const });
const change = (entityType: string, kind: string, featureKey: string, scenarioReference = "") => ({ id: id(), entityType, kind, featureKey, featureName: featureKey, scenarioReference, baseSpecVersionId: null });
const version = (repositoryId: number, versionsBefore: number, features: Array<ReturnType<typeof feature>>, scenarios: Array<ReturnType<typeof scenario>>, changes: Array<ReturnType<typeof change>> = []): ExportedVersion => ({
  id: 100 + versionsBefore,
  repositoryId,
  productId: 3,
  sha: `${versionsBefore}`.padStart(40, "0"),
  analysisRunId: 10 + versionsBefore,
  baseSpecVersionId: null,
  features,
  scenarios,
  changes,
});

/** 一条没有改过名的版本链。 */
function plainChain(repositoryId = 8): ExportedVersion[] {
  const a1 = feature("甲");
  const b1 = feature("乙");
  const first = version(repositoryId, 0, [a1, b1], [scenario(a1.id, "HP-1"), scenario(b1.id, "HP-1")], [change("feature", "added", "甲"), change("scenario", "added", "甲", "HP-1")]);
  const a2 = feature("甲");
  const b2 = feature("乙");
  const second = version(repositoryId, 1, [a2, b2], [scenario(a2.id, "HP-1"), scenario(a2.id, "HP-2", "Broken"), scenario(b2.id, "HP-1")], [change("scenario", "changed", "甲", "HP-2")]);
  const a3 = feature("甲");
  const c3 = feature("丙", "甲");
  // 最后一条变化记录说的是一个被折叠掉的变体名：它不在这一版，不在上一版，也不在登记表里。
  const third = version(repositoryId, 2, [a3, c3], [scenario(a3.id, "HP-1")], [change("feature", "added", "丙"), change("scenario", "removed", "甲", "HP-2"), change("feature", "added", "甲 副本")]);
  return [first, second, third];
}

describe("解析导出文件", () => {
  it("reads one version per line and skips the header", () => {
    const chain = plainChain();
    const text = [JSON.stringify({ kind: "header", repositories: [8], versions: 3 }), ...chain.map((entry) => JSON.stringify(entry))].join("\n");
    expect(parseLedgerExport(text)).toEqual(chain);
  });

  it("names the line that is not JSON or not a version", () => {
    expect(() => parseLedgerExport(`${JSON.stringify(plainChain()[0])}\nnot json\n`)).toThrow(/第 2 行/);
    expect(() => parseLedgerExport(`${JSON.stringify(plainChain()[0])}\n{"id":1}\n`)).toThrow(/第 2 行/);
    expect(() => parseLedgerExport("null\n")).toThrow(/第 1 行/);
  });

  it("accepts an empty ledger as zero versions", () => {
    expect(parseLedgerExport("")).toEqual([]);
    expect(parseLedgerExport(JSON.stringify({ kind: "header", repositories: [8], versions: 0 }))).toEqual([]);
  });
});

describe("把导出的行还原成两种形状", () => {
  const chain = plainChain();
  const second = chain[1];

  it("gives the diff the features with their scenarios as they were stored", () => {
    const spec = specOf(second);
    expect(spec.map((entry) => entry.name)).toEqual(["甲", "乙"]);
    expect(spec[0].scenarios.map((item) => [item.reference, item.outcome, item.category, item.step, item.source, item.evidence])).toEqual([
      ["HP-1", "Works", "happy", null, "generated", []],
      ["HP-2", "Broken", "happy", null, "generated", []],
    ]);
    expect(spec[1]).toMatchObject({ name: "乙", parentKey: null, scenarios: [expect.objectContaining({ reference: "HP-1" })] });
    // 父子关系和来源照原样带过去。
    expect(specOf(chain[2])[1]).toMatchObject({ name: "丙", parentKey: "甲" });
  });

  it("gives the backfill only what it needs to locate and identify a row", () => {
    expect(identityRowsOf(second)).toEqual({
      features: second.features.map((entry) => ({ id: entry.id, name: entry.name, parentKey: null })),
      scenarios: second.scenarios.map((entry) => ({ id: entry.id, featureId: entry.featureId, reference: entry.reference })),
      changes: second.changes.map((entry) => ({ id: entry.id, featureKey: entry.featureKey, scenarioReference: entry.scenarioReference })),
    });
  });
});

describe("在一条版本链上验收", () => {
  it("passes a chain whose names never changed: no conflict, every adjacent pair pairs the same way, and it says what the backfill would do", async () => {
    const report = await verifyLedger(plainChain());

    expect(report.passes).toBe(true);
    const [repository] = report.repositories;
    expect(repository).toMatchObject({
      repositoryId: 8,
      backfill: { versions: 3, conflict: null, mintedFeatures: 3, mintedScenarios: 3, retiredFeatures: 1, retiredScenarios: 2, restoredFeatures: 0 },
      pairs: 2,
      pairsWithIdentities: 2,
      pairsDiffering: 0,
      changeRows: 6,
      // 只有“甲 副本”那一行找不到身份：三处都没有它。
      changeRowsWithoutIdentity: 1,
      unresolvedSamples: ["added:feature 甲 副本"],
    });
  });

  it("counts adjacent pairs per repository and does not mix repositories", async () => {
    const report = await verifyLedger([...plainChain(8), ...plainChain(11).map((entry, index) => ({ ...entry, id: 500 + index }))]);
    expect(report.repositories.map((repository) => [repository.repositoryId, repository.backfill.versions, repository.pairs])).toEqual([[8, 3, 2], [11, 3, 2]]);
  });

  it("fails when a version cannot be assigned identities, and carries the reason", async () => {
    // 两个功能的名称只差一个空格：名称键相同。数据库的名称列区分空格，所以这种数据存得进去。
    const squeezed = feature("甲 副本");
    const withTwin = feature("甲  副本");
    const chain = [...plainChain().slice(0, 2), version(8, 2, [feature("甲"), squeezed, withTwin], [], [])];

    const report = await verifyLedger(chain);

    expect(report.passes).toBe(false);
    expect(report.repositories[0].backfill.conflict).toBe("版本 102：identity_input_invalid 一个版本里有两个功能的名称键相同：甲 副本");
    // 冲突那一版之前的相邻对照样比过了。
    expect(report.repositories[0].pairs).toBe(1);
  });

  it("can be limited to some repositories", async () => {
    const report = await verifyLedger([...plainChain(8), ...plainChain(11).map((entry, index) => ({ ...entry, id: 500 + index }))], { repositoryIds: [11] });
    expect(report.repositories.map((repository) => repository.repositoryId)).toEqual([11]);
  });
});

describe("参数与报告", () => {
  it("takes the ledger path and optional repositories, and refuses what it does not understand", () => {
    expect(parseArgs(["--ledger", "a.jsonl"])).toEqual({ ledgerPath: "a.jsonl", repositoryIds: [] });
    expect(parseArgs(["--ledger", "a.jsonl", "--repository", "8", "--repository", "11"])).toEqual({ ledgerPath: "a.jsonl", repositoryIds: [8, 11] });
    expect(() => parseArgs([])).toThrow(/--ledger/);
    expect(parseArgs(["--ledger", "a.jsonl", "--out", "report.md"])).toEqual({ ledgerPath: "a.jsonl", repositoryIds: [], reportPath: "report.md" });
    expect(() => parseArgs(["--ledger", "a.jsonl", "--apply"])).toThrow(/不认识的参数/);
    expect(() => parseArgs(["--ledger", "a.jsonl", "--repository", "x"])).toThrow(/仓库号/);
    // 取值的位置上是另一个开关：不能悄悄把开关名当成文件名。
    expect(() => parseArgs(["--ledger", "--out", "x"])).toThrow(/缺少取值/);
  });

  it("does not pass an export with nothing to verify", async () => {
    const report = await verifyLedger([]);
    expect(report.passes).toBe(false);
    expect(renderReport(report)).toContain("**不通过。** 导出里没有可以验收的版本。");
  });

  it("says plainly whether the ledger passes, with one line per repository", async () => {
    const passing = await verifyLedger(plainChain());
    const text = renderReport(passing);
    // “不通过”里也有“通过”两个字，所以整句断言。
    expect(text).toContain("**通过。**");
    expect(text).not.toContain("不通过");
    expect(text).toContain("| 8 | 3 | 6 | 6 | 3 | 3 | 0 | 1 | 2 | 2 | 0 | 6 | 1 | 无 |");
    expect(text).toContain("甲 副本");
    for (const header of ["## 回填演练遇到的冲突", "## 相邻版本两种配对结果不同的地方", "## 没有带着身份比的相邻版本"]) expect(text).not.toContain(header);
    // 没有问题的那几节整节不出现。节与节之间本来是两个空行；空节被渲染出来会多出连续的空行。
    expect(text).not.toMatch(/\n{4,}/);

    const squeezed = feature("甲 副本");
    const failing = await verifyLedger([...plainChain().slice(0, 2), version(8, 2, [feature("甲"), squeezed, feature("甲  副本")], [], [])]);
    const failure = renderReport(failing);
    expect(failure).toContain("**不通过。** 1 个仓库有问题");
    expect(failure).toContain("## 回填演练遇到的冲突");
    expect(failure).toContain("仓库 8：版本 102：identity_input_invalid");
  });
});

describe("脚本端到端", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reads the export file, verifies it and writes the report next to it", async () => {
    const root = await mkdtemp(join(tmpdir(), "codelphi-verify-"));
    roots.push(root);
    const ledger = join(root, "ledger.jsonl");
    await writeFile(ledger, [JSON.stringify({ kind: "header", versions: 3 }), ...plainChain().map((entry) => JSON.stringify(entry))].join("\n") + "\n");

    const report = await run({ ledgerPath: ledger, reportPath: join(root, "verification.md") });

    expect(report.passes).toBe(true);
    expect(await readFile(join(root, "verification.md"), "utf8")).toBe(renderReport(report));
  });

  it("does not write a report file unless asked", async () => {
    const root = await mkdtemp(join(tmpdir(), "codelphi-verify-"));
    roots.push(root);
    const ledger = join(root, "ledger.jsonl");
    await writeFile(ledger, plainChain().map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await mkdir(join(root, "out"), { recursive: true });

    const report = await run({ ledgerPath: ledger, reportPath: join(root, "out", "report.md") });

    expect(report.passes).toBe(true);
    expect(await readFile(join(root, "out", "report.md"), "utf8")).toContain("通过");
  });
});

describe("验收能看出的四类问题", () => {
  const lineVersions = (count: number) => Array.from({ length: count }, (_, index) => version(8, index, [feature(`功能${index}`)], [], []));
  /** 记下每一对相邻版本里变更前的名称，用来断言比对的先后顺序。 */
  const recording = () => {
    const pairs: string[] = [];
    const compare = vi.fn<typeof compareDiffPairing>((before, after) => {
      pairs.push((before ?? []).map((item) => item.name).join(","));
      return compareDiffPairing(before, after);
    });
    return { pairs, compare };
  };

  it("treats a version with no features as a pair that carries no identity, and says so", async () => {
    // 一个版本里一个功能都没有：它两边的那两对相邻版本，各有一边没有身份。
    const chain = [version(8, 0, [feature("甲")], []), version(8, 1, [], []), version(8, 2, [feature("甲")], []), version(8, 3, [feature("甲")], [])];

    const report = await verifyLedger(chain);

    expect(report.passes).toBe(false);
    // 三对里，中间隔着空版本的那两对各有一边没有身份；最后一对两边都有。
    expect(report.repositories[0]).toMatchObject({ pairs: 3, pairsWithIdentities: 1, pairsDiffering: 0 });
    const text = renderReport(report);
    expect(text).toContain("## 没有带着身份比的相邻版本");
    expect(text).toContain("- 仓库 8：3 对里有 2 对");
  });

  it("counts a pair in which a side has exactly one feature", async () => {
    const report = await verifyLedger(lineVersions(3));

    expect(report.passes).toBe(true);
    expect(report.repositories[0]).toMatchObject({ pairs: 2, pairsWithIdentities: 2, pairsDiffering: 0 });
  });

  it("reports a differing pair even when both pairings list the same rows", async () => {
    const compare = vi.fn<typeof compareDiffPairing>((before, after) => ({ same: false, byName: diffSpecWithFolded(before, after), byIdentity: diffSpecWithFolded(before, after) }));

    const report = await verifyLedger(plainChain(), { compare });

    expect(report.passes).toBe(false);
    expect(report.repositories[0]).toMatchObject({ pairs: 2, pairsWithIdentities: 2, pairsDiffering: 2 });
    expect(report.repositories[0].differences).toEqual([
      "v100 → v101：两种配对的结果不同，但逐行的变化和折叠清单一样",
      "v101 → v102：两种配对的结果不同，但逐行的变化和折叠清单一样",
    ]);
    const text = renderReport(report);
    expect(text).toContain("## 相邻版本两种配对结果不同的地方");
    expect(text).toContain("- 仓库 8，v100 → v101：");
  });

  it("lists the one row that differs when there is exactly one", async () => {
    const compare = vi.fn<typeof compareDiffPairing>((before, after) => {
      const outcome = diffSpecWithFolded(before, after);
      const extra = { kind: "added", entityType: "feature", featureName: "多出来的一行", scenarioReference: null, summary: "", before: null, after: null } as never;
      return { same: false, byName: outcome, byIdentity: { ...outcome, changes: [...outcome.changes, extra] } };
    });

    const report = await verifyLedger(lineVersions(2), { compare });

    expect(report.repositories[0].pairsDiffering).toBe(1);
    expect(report.repositories[0].differences).toEqual(["v100 → v101：只按身份配对时有：[变化] added:feature 多出来的一行"]);
  });

  it("lists the rows only one pairing produces, and no more than a sample", async () => {
    const compare = vi.fn<typeof compareDiffPairing>((before, after) => ({ same: false, byName: { changes: [], folded: [] }, byIdentity: diffSpecWithFolded(before, after) }));

    const report = await verifyLedger(lineVersions(23), { compare });

    expect(report.repositories[0].pairsDiffering).toBe(22);
    expect(report.repositories[0].differences).toHaveLength(20);
    expect(report.repositories[0].differences[0]).toMatch(/^v100 → v101：只按身份配对时有：\[变化\]/);
  });

  it("compares neighbouring versions from oldest to newest, whatever order the export is in", async () => {
    // 甲一直在，乙时有时无：正着走和倒着走统计出来的退休、恢复次数不同，顺序错了会被看出来。
    const chain = [
      version(8, 0, [feature("甲"), feature("乙")], []),
      version(8, 1, [feature("甲")], []),
      version(8, 2, [feature("甲"), feature("乙")], []),
      version(8, 3, [feature("甲")], []),
    ];
    const forward = recording();
    const first = await verifyLedger(chain, { compare: forward.compare });
    const backward = recording();
    const second = await verifyLedger([...chain].reverse(), { compare: backward.compare });

    expect(first.repositories[0].backfill).toMatchObject({ mintedFeatures: 2, retiredFeatures: 2, restoredFeatures: 1 });
    // 每次比对拿到的“变更前”依次是前三版的名称。
    expect(forward.pairs).toEqual(["甲,乙", "甲", "甲,乙"]);
    expect(backward.pairs).toEqual(forward.pairs);
    expect(second).toEqual(first);
  });
});
