import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  MAX_SUPPORTED_CONTRACT_VERSIONS,
  MIN_SUPPORTED_CONTRACT_VERSION,
  parseProposal,
  PROPOSAL_CONTRACT_VERSION,
  ProposalContractError,
  proposalHashOf,
  sealProposal,
} from "../lib/client-proposal/contract";

const feature = (name: string, outcome: string) => ({
  name,
  summary: `${name} 的摘要`,
  scenarios: [{ reference: "HP-1", context: "访客", action: "登录", outcome, category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 10 }] }],
});

/** 一份合法的提案正文（不含 proposalHash）。每个字段都给了一个看得出来的值，好验证哈希覆盖了它。 */
function body(): Record<string, unknown> {
  return {
    contractVersion: PROPOSAL_CONTRACT_VERSION,
    artifactKind: "codelphi-analysis-proposal",
    idempotencyKey: "6f1c0d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
    mode: "full",
    language: "zh-CN",
    repository: { repositoryId: 57, provider: "github", host: "github.com", owner: "acme", name: "api" },
    revision: { sha: "a".repeat(40), treeSha: "b".repeat(40), committedAt: "2026-11-26T10:00:00.000Z", title: "feat: login", branch: "main" },
    base: null,
    window: null,
    proposal: {
      product: { description: "Acme API 的行为账本。", evidence: [{ path: "lib/auth.ts", startLine: 1 }] },
      release: { title: "登录", summary: "登录相关行为" },
      changes: [{ featureName: "登录", kind: "added", description: "新增登录", userImpact: "", evidence: [] }],
      features: [feature("登录", "进入首页")],
    },
    carryClaims: [],
    coverage: { implFilesAssembled: 2, implFilesTotal: 3, implBytesAssembled: 200, implBytesTotal: 300, partitionsUsed: 1, partitionsCapped: false, diffTotalPaths: null, diffSelectedPaths: null, diffOmittedPaths: null, primaryRangesOmitted: null },
    flows: [{ featureStableKey: "登录", fingerprint: "abc123", graph: { nodes: [{ id: "n1", label: "打开登录页" }] } }],
    presentation: { headline: "Acme API" },
    client: { version: "1.2.0", pipelineVersion: "p1", promptVersion: "2026-11-26", model: "tenant-model", impactRulesVersion: "impact-v1", analyzedAt: "2026-11-26T10:30:00.000Z" },
  };
}

const seal = (overrides: Record<string, unknown> = {}) => sealProposal({ ...body(), ...overrides });
const part = (key: "revision" | "client" | "coverage" | "proposal"): Record<string, unknown> => body()[key] as Record<string, unknown>;
/** 调用 parseProposal，把它抛出来的错误说明取回来。 */
const messageOf = (parse: () => unknown): string => {
  try {
    parse();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
/** 调用 parseProposal，把它抛出来的错误码取回来；没抛就返回 undefined。 */
const codeOf = (parse: () => unknown): string | undefined => {
  try {
    parse();
    return undefined;
  } catch (error) {
    return error instanceof ProposalContractError ? error.code : `not a ProposalContractError: ${String(error)}`;
  }
};

describe("canonicalJson", () => {
  it("sorts object keys, keeps array order, drops undefined members and writes nothing extra", () => {
    expect(canonicalJson({ b: 1, a: [2, "x", null, true], c: { z: undefined, y: "é" } })).toEqual('{"a":[2,"x",null,true],"b":1,"c":{"y":"é"}}');
    expect(canonicalJson({ 中文: 1, "a": 2 })).toBe('{"a":2,"中文":1}');
  });

  it("orders keys by UTF-16 code units, which is what both sides compute", () => {
    expect(canonicalJson({ "\uFFFF": 1, "\uE000": 2, z: 3, Z: 4 })).toBe('{"Z":4,"z":3,"\uE000":2,"\uFFFF":1}');
  });

  it("refuses anything that is not a JSON value with integers only", () => {
    expect(() => canonicalJson({ a: 0.5 })).toThrow(/integer/);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/integer/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/JSON/);
  });
});

describe("sealProposal", () => {
  it("validates the payload and fills in a sha256 of everything except the two identity fields", () => {
    const sealed = seal();
    expect(sealed.proposalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(seal().proposalHash).toBe(sealed.proposalHash);
    const { proposalHash, idempotencyKey, ...rest } = sealed;
    expect(proposalHash).toBe(proposalHashOf(rest));
    expect(idempotencyKey).toBe("6f1c0d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f");
  });

  it("gives the same content the same hash whatever the key order, whitespace or idempotency key", () => {
    const sealed = seal();
    const reordered = Object.fromEntries(Object.entries(body()).reverse());
    expect(sealProposal({ ...reordered, idempotencyKey: "00000000-0000-4000-8000-000000000001" }).proposalHash).toBe(sealed.proposalHash);
  });

  it("covers base, revision, client metadata, coverage, flows and presentation, so the same analysis on another base is another proposal", () => {
    const sealed = seal();
    const differs = (overrides: Record<string, unknown>) => sealProposal({ ...body(), ...overrides }).proposalHash !== sealed.proposalHash;
    expect(differs({ base: { specVersionId: 332, sha: "c".repeat(40) } })).toBe(true);
    expect(differs({ revision: { ...part("revision"), sha: "d".repeat(40) } })).toBe(true);
    expect(differs({ client: { ...part("client"), model: "another-model" } })).toBe(true);
    expect(differs({ coverage: { ...part("coverage"), implFilesAssembled: 3 } })).toBe(true);
    expect(differs({ flows: [] })).toBe(true);
    expect(differs({ presentation: { headline: "Another" } })).toBe(true);
  });

  it("strips keys the contract does not declare, so both sides hash the same object", () => {
    const sealed = seal({ extra: "ignored", absent: undefined });
    expect(sealed).not.toHaveProperty("extra");
    expect(sealed).not.toHaveProperty("absent");
  });

  it("refuses to seal a contract version the server will not accept", () => {
    expect(codeOf(() => seal({ contractVersion: "0.9.0" }))).toBe("contract_version_mismatch");
  });

  it("answers anything that is not a proposal object with the contract error, not a crash", () => {
    for (const input of [null, undefined, 42, "text", [], true]) {
      expect(codeOf(() => parseProposal(input)), String(input)).toBe("invalid_proposal");
    }
  });

  it("keeps the details of a schema failure to twenty issues", () => {
    const broken = Array.from({ length: 30 }, (_, index) => ({ name: `功能 ${index}`, summary: "摘要", scenarios: [{ ...feature("x", "y").scenarios[0], reference: "bad" }] }));
    try {
      seal({ proposal: { ...part("proposal"), features: broken } });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProposalContractError);
      expect((error as ProposalContractError).details).toHaveLength(20);
      expect((error as ProposalContractError).message).toContain("proposal.features");
    }
  });

  it("accepts a full result with more features than one model response may hold", () => {
    const sealed = seal({ proposal: { ...part("proposal"), features: Array.from({ length: 120 }, (_, index) => feature(`功能 ${index}`, "结果")) } });
    expect(sealed.proposal.features).toHaveLength(120);
  });
});

describe("parseProposal", () => {
  it("accepts what sealProposal produced, after a JSON round trip", () => {
    const sealed = seal({ mode: "incremental", base: { specVersionId: 7, sha: "e".repeat(40) } });
    expect(parseProposal(JSON.parse(JSON.stringify(sealed)))).toEqual(sealed);
  });

  it("rejects a hash that does not match the content", () => {
    const sealed = seal();
    const tampered = { ...sealed, proposal: { ...sealed.proposal, features: [feature("登录", "别的结果")] } };
    expect(() => parseProposal(tampered)).toThrowError(ProposalContractError);
    expect(codeOf(() => parseProposal(tampered))).toBe("proposal_hash_mismatch");
  });

  it("rejects a contract version it does not speak and says which one it needs", () => {
    try {
      parseProposal({ ...seal(), contractVersion: "0.9.0" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProposalContractError);
      expect((error as ProposalContractError).code).toBe("contract_version_mismatch");
      expect((error as ProposalContractError).details).toEqual({ minSupportedContractVersion: MIN_SUPPORTED_CONTRACT_VERSION, supported: MAX_SUPPORTED_CONTRACT_VERSIONS });
    }
  });

  it("accepts the previous contract version, as the server may have been updated while the client was analysing", () => {
    expect(MAX_SUPPORTED_CONTRACT_VERSIONS).toEqual([PROPOSAL_CONTRACT_VERSION]);
  });

  it("refuses any number that is not an integer, including inside parts the schema leaves open", () => {
    for (const payload of [
      { coverage: { ...part("coverage"), implFilesAssembled: 2.5 } },
      { flows: [{ featureStableKey: "登录", fingerprint: "abc", graph: { score: 0.87 } }] },
      { flows: [{ featureStableKey: "登录", fingerprint: "abc", graph: { nodes: [{ rank: 0.87 }] } }] },
      { presentation: { ratio: 1 / 3 } },
    ]) {
      try {
        seal(payload);
        throw new Error(`should have thrown for ${JSON.stringify(payload).slice(0, 80)}`);
      } catch (error) {
        // 是契约错误，不是算哈希时碰巧摔在规范化上。
        expect(error).toBeInstanceOf(ProposalContractError);
        expect((error as ProposalContractError).code).toBe("invalid_proposal");
        expect((error as ProposalContractError).message).toMatch(/integer/);
      }
    }
    // 说明里带的是从载荷根算起的字段路径，开头没有多余的点。
    expect(codeOf(() => seal({ presentation: { ratio: 0.5 } }))).toBe("invalid_proposal");
    expect(messageOf(() => seal({ presentation: { ratio: 0.5 } }))).toContain("presentation.ratio is 0.5");
  });

  it("keeps the proposal body on the model-output schema", () => {
    const badReference = { proposal: { ...part("proposal"), features: [{ ...feature("登录", "x"), scenarios: [{ ...feature("登录", "x").scenarios[0], reference: "S-1" }] }] } };
    expect(() => seal(badReference)).toThrow(ProposalContractError);
    expect(() => seal({ proposal: { ...part("proposal"), features: [{ name: "登录", summary: "摘要", scenarios: [] }, { name: "登录", summary: "摘要", scenarios: [] }] } })).not.toThrow();
  });

  it("checks repository identity: a local repository has no host or owner, a remote one has both", () => {
    expect(() => seal({ repository: { repositoryId: null, provider: "local", host: null, owner: null, name: "repo" } })).not.toThrow();
    expect(() => seal({ repository: { repositoryId: 57, provider: "gitlab", host: "gitlab.corp.com", owner: "team", name: "api" } })).not.toThrow();
    expect(() => seal({ repository: { repositoryId: 57, provider: "gitlab", host: null, owner: "team", name: "api" } })).toThrow(/host/);
    expect(() => seal({ repository: { repositoryId: null, provider: "github", host: "github.com", owner: null, name: "api" } })).toThrow(/owner/);
    expect(() => seal({ repository: { repositoryId: 57, provider: "bitbucket", host: "bitbucket.org", owner: "team", name: "api" } })).toThrow(ProposalContractError);
    expect(() => seal({ repository: { repositoryId: 0, provider: "local", host: null, owner: null, name: "repo" } })).toThrow(ProposalContractError);
  });

  it("requires a UUID as the idempotency key and a full commit id as the revision", () => {
    expect(() => seal({ idempotencyKey: "not-a-uuid" })).toThrow(ProposalContractError);
    expect(() => seal({ revision: { ...part("revision"), sha: "abc123" } })).toThrow(ProposalContractError);
  });
});
