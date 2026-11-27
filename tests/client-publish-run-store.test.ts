import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sealProposal, type Proposal } from "../lib/client-proposal/contract";
import { fingerprintOf, loadPreparedPublish, openPublishRun, PublishRunError, stableStringify, type PublishRunIdentity } from "../lib/client-publish/run-store";

const dirs: string[] = [];
async function workdir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codelphi-publish-run-"));
  dirs.push(directory);
  return directory;
}

const identity: PublishRunIdentity = {
  repositoryRoot: "/repos/fixture",
  productSlug: "fixture",
  targetSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  base: null,
  outputLanguage: "zh-CN",
  modelName: "tenant-model",
  clientVersion: "0.1.0",
  pipelineVersion: "p1",
  promptVersion: "2026-11-27",
};

const filesIn = async (root: string): Promise<string[]> => {
  const names = await readdir(root, { recursive: true, encoding: "utf8" }).catch(() => [] as string[]);
  return names.map((name) => String(name)).sort();
};

function proposalOf(sha: string): Proposal {
  return sealProposal({
    contractVersion: "2.0.0",
    artifactKind: "codelphi-analysis-proposal",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
    mode: "full",
    language: "zh-CN",
    repository: { repositoryId: null, provider: "local", host: null, owner: null, name: "fixture" },
    revision: { sha, treeSha: null, committedAt: "2026-11-01T00:00:00.000Z", title: "release", branch: "main" },
    base: null,
    window: null,
    proposal: {
      product: { description: "A fixture product.", evidence: [{ path: "lib/auth.ts", startLine: 1 }] },
      release: { title: "First release", summary: "First summary" },
      changes: [],
      features: [{ name: "Login", summary: "Login handles sign-in.", scenarios: [{ reference: "HP-1", context: "用户使用产品", action: "登录", outcome: "进入首页", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 10 }] }] }],
    },
    carryClaims: [],
    coverage: { implFilesAssembled: 1, implFilesTotal: 1, implBytesAssembled: 200, implBytesTotal: 200, partitionsUsed: 1, partitionsCapped: false, diffTotalPaths: null, diffSelectedPaths: null, diffOmittedPaths: null, primaryRangesOmitted: null },
    flows: [],
    presentation: null,
    client: { version: "0.1.0", pipelineVersion: "p1", promptVersion: "2026-11-27", model: "tenant-model", impactRulesVersion: "impact-v1", analyzedAt: "2026-11-27T01:00:00.000Z" },
  });
}

async function expectRunError(code: PublishRunError["code"], work: () => Promise<unknown>): Promise<void> {
  const error = await work().then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PublishRunError);
  expect((error as PublishRunError).code).toBe(code);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("keys", () => {
  it("hash the content, not the order the keys were written in, and tell every value apart", () => {
    expect(stableStringify({ b: [1, 2], a: "x" })).toBe('{"a":"x","b":[1,2]}');
    // 空串、null、没有值（undefined）、0、false 各是各的，不能撞成一个。
    expect(stableStringify(["", null, undefined, 0, false])).toBe('["",null,null,0,false]');
    expect(stableStringify("")).toBe('""');
    expect(stableStringify(undefined)).toBe("null");
    expect(stableStringify("")).not.toBe(stableStringify(null));
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
    expect(fingerprintOf({ a: 1, b: undefined })).toBe(fingerprintOf({ a: 1 }));
    expect(fingerprintOf({ a: 1, b: [2, { c: 3 }] })).toBe(fingerprintOf({ b: [2, { c: 3 }], a: 1 }));
    expect(fingerprintOf({ a: 1, b: [2, { c: 3 }] })).not.toBe(fingerprintOf({ a: 1, b: [2, { c: 4 }] }));
  });
});

describe("publish run store", () => {
  it("opens a work directory for one run and remembers what finished", async () => {
    const directory = await workdir();
    const first = await openPublishRun(directory, identity);
    expect(first.resumed).toBe(false);
    expect(await filesIn(directory)).toEqual(["publish", "publish.json"]);

    await first.store.write("partitions/partition-001.json", "key-1", { result: { features: [1] }, pass: { retries: 0 } });
    await first.store.write("flows/login.json", "key-2", { graph: { nodes: [] } });
    expect(await first.store.read<{ result: { features: number[] } }>("partitions/partition-001.json", "key-1")).toEqual({ result: { features: [1] }, pass: { retries: 0 } });
    // 键对不上就当没有：同一条目的输入变了，旧结果不能用。
    expect(await first.store.read("partitions/partition-001.json", "another-key")).toBeNull();
    expect(await first.store.read("partitions/partition-002.json", "key-1")).toBeNull();
    // 落盘是完整的：没有留下写到一半的临时文件。
    expect((await filesIn(directory)).filter((name) => name.includes(".tmp"))).toEqual([]);

    const again = await openPublishRun(directory, identity);
    expect(again.resumed).toBe(true);
    expect(await again.store.read("flows/login.json", "key-2")).toEqual({ graph: { nodes: [] } });
  });

  it("starts over when anything that changes the result has changed", async () => {
    for (const change of [
      { targetSha: "c".repeat(40) },
      { treeSha: "d".repeat(40) },
      { base: { specVersionId: 4, sha: "c".repeat(40) } },
      { outputLanguage: "en" as const },
      { modelName: "another-model" },
      { promptVersion: "2026-12-01" },
      { pipelineVersion: "p2" },
      { clientVersion: "0.2.0" },
      { productSlug: "another-product" },
      { repositoryRoot: "/repos/another-checkout" },
    ]) {
      const directory = await workdir();
      const first = await openPublishRun(directory, identity);
      await first.store.write("partitions/partition-001.json", "key", { done: true });
      const second = await openPublishRun(directory, { ...identity, ...change });
      expect(second.resumed, JSON.stringify(change)).toBe(false);
      expect(await second.store.read("partitions/partition-001.json", "key")).toBeNull();
      expect(JSON.parse(await readFile(join(directory, "publish.json"), "utf8"))).toMatchObject({ ...identity, ...change });
    }
  });

  it("treats a work directory it cannot make sense of as a fresh run", async () => {
    const directory = await workdir();
    await writeFile(join(directory, "publish.json"), "{not json");
    expect((await openPublishRun(directory, identity)).resumed).toBe(false);
    // 能解析成 JSON、但不是一次分析的记录，也一样。
    for (const text of ["null", "42", '"a string"', "[]", JSON.stringify({ repositoryRoot: "/repos/fixture", targetSha: identity.targetSha })]) {
      await writeFile(join(directory, "publish.json"), text);
      expect((await openPublishRun(directory, identity)).resumed, text).toBe(false);
      expect(JSON.parse(await readFile(join(directory, "publish.json"), "utf8"))).toMatchObject({ startedAt: expect.any(String), ...identity });
    }
    // 工作目录被别的东西占着也不报错：分步续跑的文件都放在自己的子目录里。
    const shared = await workdir();
    await writeFile(join(shared, "manifest.json"), JSON.stringify({ some: "snapshot workspace" }));
    expect((await openPublishRun(shared, identity)).resumed).toBe(false);
    expect(JSON.parse(await readFile(join(shared, "manifest.json"), "utf8"))).toEqual({ some: "snapshot workspace" });
  });

  it("ignores an entry that was truncated or rewritten by hand, and refuses names that would leave the directory", async () => {
    const directory = await workdir();
    const { store } = await openPublishRun(directory, identity);
    await store.write("partitions/one.json", "k", { ok: true });
    await writeFile(join(directory, "publish", "partitions", "two.json"), "{\"key\":\"k\",\"value\":{");
    await writeFile(join(directory, "publish", "partitions", "three.json"), "not an entry at all");
    // 能解析成 JSON、但不是「键加值」的，也当没有。
    for (const [index, text] of ["null", "42", '"text"', "[]", '{"value":1}', '{"key":7,"value":1}'].entries()) {
      await writeFile(join(directory, "publish", "partitions", `other-${index}.json`), text);
      expect(await store.read(`partitions/other-${index}.json`, "k"), text).toBeNull();
    }
    expect(await store.read("partitions/two.json", "k")).toBeNull();
    expect(await store.read("partitions/three.json", "k")).toBeNull();
    // 名字只能是目录之内的相对路径：空的、绝对的、以斜杠开头的、带反斜杠或空字节、含空段或 . 或 .. 的都不收。
    for (const bad of ["", "/abs.json", "dir/", "a//b.json", "a/./b.json", "a/../b.json", "..", ".", "a\\b.json", "a\0b.json", "a/.."]) {
      await expect(store.read(bad, "k"), JSON.stringify(bad)).rejects.toThrow(/name/);
      await expect(store.write(bad, "k", {}), JSON.stringify(bad)).rejects.toThrow(/name/);
    }
    await expect(store.read("../publish.json", "k")).rejects.toThrow(/name/);
    await expect(store.write("/etc/passwd", "k", {})).rejects.toThrow(/name/);
    // 目录之内的多层名字可以用。
    await store.write("flows/a.b_c-d-1/x-2.json", "k", { ok: 1 });
    expect(await store.read("flows/a.b_c-d-1/x-2.json", "k")).toEqual({ ok: 1 });
    expect(await readFile(join(directory, "publish", "partitions", "one.json"), "utf8")).toBe(JSON.stringify({ key: "k", value: { ok: true } }));
  });
});

describe("loading a prepared publish", () => {
  const prepared = async () => {
    const directory = await workdir();
    const { store } = await openPublishRun(directory, identity);
    const proposal = proposalOf(identity.targetSha);
    await store.write("summary.json", identity.targetSha, { features: 1, scenarios: 1 });
    await store.write("proposal.json", proposal.proposalHash, proposal);
    return { directory, store, proposal };
  };

  it("returns the sealed proposal and its summary without touching a model", async () => {
    const { directory, proposal } = await prepared();
    const loaded = await loadPreparedPublish(directory, { repositoryRoot: identity.repositoryRoot, productSlug: "fixture", targetSha: identity.targetSha });
    expect(loaded.proposal.proposalHash).toBe(proposal.proposalHash);
    expect(loaded.summary).toEqual({ features: 1, scenarios: 1 });
  });

  it("says plainly when there is nothing to finalize", async () => {
    const nowhere = await workdir();
    await expectRunError("publish_not_prepared", () => loadPreparedPublish(nowhere, { repositoryRoot: identity.repositoryRoot, productSlug: "fixture", targetSha: identity.targetSha }));
    const empty = await workdir();
    await openPublishRun(empty, identity);
    await expectRunError("publish_not_prepared", () => loadPreparedPublish(empty, { repositoryRoot: identity.repositoryRoot, productSlug: "fixture", targetSha: identity.targetSha }));
    // 记录文件能解析、但不是一次分析的记录。
    const odd = await workdir();
    for (const text of ["null", "42", "[]", JSON.stringify({ repositoryRoot: identity.repositoryRoot, productSlug: "fixture", targetSha: identity.targetSha })]) {
      await writeFile(join(odd, "publish.json"), text);
      await expectRunError("publish_not_prepared", () => loadPreparedPublish(odd, { repositoryRoot: identity.repositoryRoot, productSlug: "fixture", targetSha: identity.targetSha }));
    }
    const { directory } = await prepared();
    await expectRunError("publish_not_prepared", () => loadPreparedPublish(directory, { repositoryRoot: identity.repositoryRoot, productSlug: "another-product", targetSha: identity.targetSha }));
    await expectRunError("publish_not_prepared", () => loadPreparedPublish(directory, { repositoryRoot: "/repos/elsewhere", productSlug: "fixture", targetSha: identity.targetSha }));
  });

  it("refuses to upload a proposal for a commit the repository has moved away from", async () => {
    const { directory } = await prepared();
    await expectRunError("publish_target_mismatch", () => loadPreparedPublish(directory, { repositoryRoot: identity.repositoryRoot, productSlug: "fixture", targetSha: "f".repeat(40) }));
  });

  it("needs both the proposal and its summary: a preparation that stopped between the two is not finished", async () => {
    const missingSummary = await prepared();
    await rm(join(missingSummary.directory, "publish", "summary.json"));
    await expectRunError("publish_not_prepared", () => loadPreparedPublish(missingSummary.directory, { repositoryRoot: identity.repositoryRoot, productSlug: "fixture", targetSha: identity.targetSha }));
    const missingProposal = await prepared();
    await rm(join(missingProposal.directory, "publish", "proposal.json"));
    await expectRunError("publish_not_prepared", () => loadPreparedPublish(missingProposal.directory, { repositoryRoot: identity.repositoryRoot, productSlug: "fixture", targetSha: identity.targetSha }));
  });

  it("refuses a proposal that no longer matches its own hash", async () => {
    const { directory, store } = await prepared();
    const tampered = proposalOf(identity.targetSha) as unknown as { proposal: { release: { summary: string } } };
    tampered.proposal.release.summary = "edited after sealing";
    await store.write("proposal.json", "sha256:whatever", tampered);
    await expectRunError("publish_corrupt", () => loadPreparedPublish(directory, { repositoryRoot: identity.repositoryRoot, productSlug: "fixture", targetSha: identity.targetSha }));
  });
});
