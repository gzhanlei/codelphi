import { describe, expect, it } from "vitest";
import { changeOf, coverageOf, PLACEHOLDER_PATCH, provenanceOf, releaseUrlOf, runContextOf } from "../lib/client-proposal/adapt";
import { sealProposal, type Proposal } from "../lib/client-proposal/contract";

const feature = (name: string) => ({
  name,
  summary: `${name} 的摘要`,
  scenarios: [{ reference: "HP-1", context: "访客", action: "登录", outcome: "进入首页", category: "happy" as const, evidence: [{ path: "lib/auth.ts", startLine: 10 }] }],
});

function body(): Record<string, unknown> {
  return {
    contractVersion: "2.0.0",
    artifactKind: "codelphi-analysis-proposal",
    idempotencyKey: "6f1c0d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
    mode: "full",
    language: "zh-CN",
    repository: { repositoryId: 57, provider: "github", host: "github.com", owner: "acme", name: "api" },
    revision: { sha: "a".repeat(40), treeSha: "b".repeat(40), committedAt: "2026-11-26T10:00:00.000Z", title: "feat: login", branch: "main" },
    base: { specVersionId: 332, sha: "c".repeat(40) },
    window: {
      files: [
        { path: "lib/auth.ts", previousPath: null, status: "modified", behavioral: true, hunks: [{ oldStart: 10, oldCount: 3, newStart: 12, newCount: 4 }] },
        { path: "README.md", previousPath: null, status: "modified", behavioral: false, hunks: [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 }] },
      ],
      analyzedPaths: ["lib/auth.ts"],
      skipped: [{ path: "README.md", reason: "documentation" }],
      affectedFeatureKeys: ["登录"],
    },
    proposal: {
      product: { description: "Acme API 的行为账本。", evidence: [{ path: "lib/auth.ts", startLine: 1 }] },
      release: { title: "登录", summary: "登录相关行为" },
      changes: [],
      features: [feature("登录")],
    },
    carryClaims: [],
    coverage: { implFilesAssembled: 2, implFilesTotal: 3, implBytesAssembled: 200, implBytesTotal: 300, partitionsUsed: 1, partitionsCapped: false, diffTotalPaths: 2, diffSelectedPaths: 1, diffOmittedPaths: 1, primaryRangesOmitted: null },
    flows: [],
    presentation: {},
    client: { version: "1.2.0", pipelineVersion: "p1", promptVersion: "2026-11-26", model: "tenant-model", impactRulesVersion: "impact-v1", analyzedAt: "2026-11-26T10:30:00.000Z" },
  };
}

const proposal = (overrides: Record<string, unknown> = {}): Proposal => sealProposal({ ...body(), ...overrides });
const identity = { runId: 900, repositoryId: 57, productId: 5, organizationId: 3, productSlug: "acme", productName: "Acme", owner: "acme", name: "api", provider: "github" as const };

describe("runContextOf", () => {
  it("describes the run the way the merge path and the isolation guards read it", () => {
    const run = runContextOf(proposal(), identity);
    expect(run).toMatchObject({
      id: 900,
      repositoryId: 57,
      productId: 5,
      organizationId: 3,
      productSlug: "acme",
      productName: "Acme",
      owner: "acme",
      name: "api",
      beforeSha: "c".repeat(40),
      afterSha: "a".repeat(40),
      baseSpecVersionId: 332,
      connectionId: null,
      provider: "github",
      accountId: 3,
      analyzeMode: "full",
      outputLanguage: "zh-CN",
      triggerType: "client_upload",
      analysisExecutor: "client",
    });
    expect(run.baseCapturedAt).toBeInstanceOf(Date);
  });

  it("has no base on a first publish, so the version is a baseline", () => {
    const run = runContextOf(proposal({ base: null, window: null }), identity);
    expect(run.beforeSha).toBeNull();
    expect(run.baseSpecVersionId).toBeNull();
    expect(run.baseCapturedAt).toBeNull();
  });
});

describe("changeOf", () => {
  it("carries the window as files without patch text, with hunks and the behavioural set the client computed", () => {
    const change = changeOf(proposal());
    expect(change.message).toBe("feat: login");
    expect(change.committedAt).toBe("2026-11-26T10:00:00.000Z");
    expect(change.files).toEqual([
      { path: "lib/auth.ts", status: "modified", patch: PLACEHOLDER_PATCH, hunks: [{ oldStart: 10, oldCount: 3, newStart: 12, newCount: 4 }] },
      { path: "README.md", status: "modified", patch: PLACEHOLDER_PATCH, hunks: [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 }] },
    ]);
    expect([...change.behavioralPaths ?? []]).toEqual(["lib/auth.ts"]);
    expect(change.url).toBe(`https://github.com/acme/api/commit/${"a".repeat(40)}`);
  });

  it("uses the same placeholder string the hosted path writes when it cannot get a patch", () => {
    expect(PLACEHOLDER_PATCH).toBe("(binary or patch unavailable)");
  });

  it("is an empty window on a first publish", () => {
    const change = changeOf(proposal({ base: null, window: null }));
    expect(change.files).toEqual([]);
    expect([...change.behavioralPaths ?? []]).toEqual([]);
  });
});

describe("releaseUrlOf", () => {
  const withRepository = (repository: Record<string, unknown>) => releaseUrlOf(proposal({ repository }));

  it("links GitHub and public GitLab the way their web interfaces do, and self-hosted hosts by name", () => {
    expect(withRepository({ repositoryId: 1, provider: "github", host: "github.com", owner: "acme", name: "api" })).toBe(`https://github.com/acme/api/commit/${"a".repeat(40)}`);
    expect(withRepository({ repositoryId: 1, provider: "gitlab", host: "gitlab.com", owner: "team", name: "api" })).toBe(`https://gitlab.com/team/api/-/commit/${"a".repeat(40)}`);
    expect(withRepository({ repositoryId: 1, provider: "gitlab", host: "gitlab.corp.com", owner: "team", name: "api" })).toBe(`https://gitlab.corp.com/team/api/-/commit/${"a".repeat(40)}`);
    expect(withRepository({ repositoryId: 1, provider: "gitea", host: "git.example.com", owner: "team", name: "api" })).toBe(`https://git.example.com/team/api/commit/${"a".repeat(40)}`);
  });

  it("has no link for a repository that only exists on the tenant's machine", () => {
    expect(withRepository({ repositoryId: 1, provider: "local", host: null, owner: null, name: "repo" })).toBe("");
  });
});

describe("coverageOf", () => {
  it("derives the ratio on the server from the integer counts, with the formula the hosted path uses", () => {
    expect(coverageOf(proposal())).toMatchObject({ implFilesAssembled: 2, implFilesTotal: 3, implBytesAssembled: 200, implBytesTotal: 300, coverageRatio: 200 / 300, partitionsUsed: 1, partitionsCapped: false, diffTotalPaths: 2, diffSelectedPaths: 1, diffOmittedPaths: 1, primaryRangesOmitted: null });
    expect(coverageOf(proposal({ coverage: { ...(body().coverage as object), implBytesTotal: 0, implBytesAssembled: 0 } }))?.coverageRatio).toBe(0);
  });

  it("is undefined when the client sent no receipt", () => {
    expect(coverageOf(proposal({ coverage: null }))).toBeUndefined();
  });
});

describe("provenanceOf", () => {
  it("keeps what the server confirmed apart from what the client merely says", () => {
    const provenance = provenanceOf(proposal(), { receivedAt: "2026-11-26T11:00:00.000Z", specVersionId: 400, counts: { reanalyzed: 120, deterministicallyCarried: 30, clientDeclaredUnaffected: 0 } });
    expect(provenance).toEqual({
      server: {
        executor: "client",
        receivedAt: "2026-11-26T11:00:00.000Z",
        specVersionId: 400,
        revisionSha: "a".repeat(40),
        contractVersion: "2.0.0",
        verification: { scope: "file_level_paths", reanalyzed: 120, deterministicallyCarried: 30, clientDeclaredUnaffected: 0 },
      },
      client: {
        model: "tenant-model",
        clientVersion: "1.2.0",
        pipelineVersion: "p1",
        promptVersion: "2026-11-26",
        impactRulesVersion: "impact-v1",
        analyzedAt: "2026-11-26T10:30:00.000Z",
      },
    });
    // 客户端那一组是客户端的说法：原样记录，一个字都不是服务端核实的。
    expect(Object.keys(provenance.client).sort()).toEqual(["analyzedAt", "clientVersion", "impactRulesVersion", "model", "pipelineVersion", "promptVersion"]);
  });
});
