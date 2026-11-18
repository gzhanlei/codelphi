import { describe, expect, it, vi } from "vitest";
import { buildAdjudicationPrompt, parseAdjudicationVerdict, adjudicateFeedbackReport, runFeedbackAdjudicationSweepOnce, type AdjudicationDependencies } from "../lib/feedback-adjudication";

const completion = vi.fn();

const report = {
  id: 12,
  productId: 1,
  repositoryId: 1,
  revision: "95db983dc6deb914424ab897c989ac04a4085497",
  claim: "[mcp:bug] run 319 重提取疑似违反 W0-10：功能「MCP OAuth 自动发现与动态客户端注册」被重提取，但 4 个代码未变的场景被记为 removed——HP-5/HP-6（token 端点）、HP-7（发现元数据）、HP-31（refresh 旋转）。",
};

function jsonRow(sql: string, rows: unknown[]) {
  return async () => [rows];
}

describe("feedback adjudication prompt (AI 裁决)", () => {
  it("contains the claim, ledger changes digest and code excerpts", () => {
    const prompt = buildAdjudicationPrompt({
      claim: "场景 HP-5 被误删但代码未变",
      changes: [{ kind: "removed", entityType: "scenario", featureName: "MCP OAuth", scenarioReference: "HP-5", summary: "移除场景 HP-5", evidencePaths: ["lib/mcp/oauth.ts"] }],
      codeExcerpts: [{ path: "lib/mcp/oauth.ts", content: "export async function exchangeToken() {" }],
    });
    expect(prompt).toContain("场景 HP-5 被误删但代码未变");
    expect(prompt).toContain("removed");
    expect(prompt).toContain("lib/mcp/oauth.ts");
    expect(prompt).toContain("export async function exchangeToken()");
    expect(prompt).toContain("confirmed_defect");
    expect(prompt).toContain("false_alarm");
    expect(prompt).toContain("needs_human");
  });

  it("states that only confirmed high-confidence defects trigger corrective rebuilds", () => {
    const prompt = buildAdjudicationPrompt({ claim: "x", changes: [], codeExcerpts: [] });
    expect(prompt).toContain("全量重建");
    expect(prompt).toContain("needs_human");
  });
});

describe("parseAdjudicationVerdict", () => {
  it("parses fenced and plain JSON verdicts", () => {
    expect(parseAdjudicationVerdict('```json\n{"verdict":"confirmed_defect","confidence":"high","reason":"代码仍实现该行为"}\n```')).toEqual({
      verdict: "confirmed_defect", confidence: "high", reason: "代码仍实现该行为",
    });
    expect(parseAdjudicationVerdict('{"verdict":"false_alarm","confidence":"high","reason":"行为确已移除"}')).toEqual({
      verdict: "false_alarm", confidence: "high", reason: "行为确已移除",
    });
  });

  it("rejects unknown verdicts", () => {
    expect(() => parseAdjudicationVerdict('{"verdict":"whatever","confidence":"high","reason":"r"}')).toThrow();
  });
});

describe("adjudicateFeedbackReport disposition", () => {
  const okVerdict = '{"verdict":"confirmed_defect","confidence":"high","reason":"代码仍实现该行为，场景被误删"}';

  function setupDeps(overrides: Record<string, unknown> = {}) {
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes("FROM feedback_reports")) return [[{ id: 12, productId: 1, repositoryId: 1, revision: "95db983", claim: report.claim, kind: "bug" }]];
      if (sql.includes("FROM spec_changes")) return [[{ kind: "removed", entityType: "scenario", featureName: "MCP OAuth", scenarioReference: "HP-5", summary: "移除场景 HP-5", beforeJson: JSON.stringify({ reference: "HP-5", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/mcp/oauth.ts", startLine: 16 }] }), afterJson: null }]];
      if (sql.includes("FROM releases")) return [[{ sha: "95db983", repositoryId: 9 }]];
      return [[]];
    }) as unknown as (sql: string, params?: unknown[]) => Promise<unknown>;
    return {
      execute,
      completion: completion.mockResolvedValue(okVerdict),
      queueAnalysis: vi.fn(async () => 320),
      readFile: vi.fn(async () => "export async function exchangeToken() {}"),
      ...overrides,
    } as unknown as AdjudicationDependencies;
  }

  it("confirmed defect triggers a corrective full rebuild and records the run", async () => {
    const deps = setupDeps();
    const outcome = (await adjudicateFeedbackReport(12, deps))!;
    expect(outcome.verdict).toBe("confirmed_defect");
    // 纠偏 run 归属发布仓库（多仓库产品下按 product 任意 JOIN 会落在无关仓库上）
    expect(deps.queueAnalysis).toHaveBeenCalledWith(9, null, "95db983", "manual");
    const update = (deps.execute as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) => String(sql).includes("verdict = ?"));
    expect(update?.[1]).toEqual(["confirmed_defect", "代码仍实现该行为，场景被误删", 320, 12]);
  });

  it("low confidence downgrades to needs_human without a corrective run", async () => {
    const deps = setupDeps({ completion: vi.fn(async () => '{"verdict":"confirmed_defect","confidence":"low","reason":"证据不足"}') });
    const outcome = (await adjudicateFeedbackReport(12, deps))!;
    expect(outcome.verdict).toBe("needs_human");
    expect(deps.queueAnalysis).not.toHaveBeenCalled();
  });

  it("false_alarm records the rejection without touching analysis", async () => {
    const deps = setupDeps({ completion: vi.fn(async () => '{"verdict":"false_alarm","confidence":"high","reason":"行为确实已移除"}') });
    const outcome = (await adjudicateFeedbackReport(12, deps))!;
    expect(outcome.verdict).toBe("false_alarm");
    expect(deps.queueAnalysis).not.toHaveBeenCalled();
  });

  it("unreadable code evidence falls back to needs_human", async () => {
    const deps = setupDeps({ readFile: vi.fn(async () => { throw new Error("scope denied"); }), completion: vi.fn(async () => '{"verdict":"confirmed_defect","confidence":"high","reason":"r"}') });
    const outcome = (await adjudicateFeedbackReport(12, deps))!;
    expect(outcome.verdict).toBe("needs_human");
    expect(deps.queueAnalysis).not.toHaveBeenCalled();
  });

  it("anchors evidence reading on the report's own repository (repository_full_name), not an arbitrary product repo", async () => {
    // 多仓库产品下按 product 任取仓库读证据 = 读错仓库的代码；报告行已存 repository_full_name
    const deps = setupDeps();
    await adjudicateFeedbackReport(12, deps);
    const loadCall = (deps.execute as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) => String(sql).includes("FROM feedback_reports"));
    const loadSql = String(loadCall?.[0]);
    expect(loadSql).toContain("repository_full_name");
    expect(loadSql).toContain("ORDER BY");
    expect(loadCall?.[1]).toEqual([12]);
  });

  it("zero code evidence never auto-confirms a defect (guard bypass closed)", async () => {    // 近期变化无证据路径：confirm_defect+high 不得在零代码证据下触发全量重建
    const deps = setupDeps({
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("FROM feedback_reports")) return [[{ id: 12, productId: 1, repositoryId: 1, revision: "95db983", claim: report.claim, kind: "bug" }]];
        if (sql.includes("FROM spec_changes")) return [[]];
        if (sql.includes("FROM releases")) return [[{ sha: "95db983", repositoryId: 9 }]];
        return [[]];
      }) as unknown as (sql: string, params?: unknown[]) => Promise<unknown>,
      completion: vi.fn(async () => '{"verdict":"confirmed_defect","confidence":"high","reason":"r"}'),
    });
    const outcome = (await adjudicateFeedbackReport(12, deps))!;
    expect(outcome.verdict).toBe("needs_human");
    expect(deps.queueAnalysis).not.toHaveBeenCalled();
  });
});

describe("runFeedbackAdjudicationSweepOnce", () => {
  it("picks pending bug reports older than the threshold and adjudicates each", async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes("ORDER BY f.id LIMIT")) return [[{ id: 12, productId: 1, repositoryId: 1, revision: "95db983", claim: "c", kind: "bug" }]];
      if (sql.includes("FROM feedback_reports f") && sql.includes("repositories r")) return [[{ id: 12, productId: 1, repositoryId: 1, revision: "95db983", claim: "c", kind: "bug" }]];
      if (sql.includes("FROM spec_changes")) return [[]];
      if (sql.includes("FROM releases")) return [[{ sha: "95db983" }]];
      return [[]];
    }) as unknown as (sql: string, params?: unknown[]) => Promise<unknown>;
    const outcome = await runFeedbackAdjudicationSweepOnce({
      execute,
      completion: vi.fn(async () => '{"verdict":"false_alarm","confidence":"high","reason":"r"}'),
      queueAnalysis: vi.fn(async () => 1),
      readFile: vi.fn(async () => "code"),
    });
    expect(outcome.adjudicated).toBe(1);
    expect(outcome.needsHuman + outcome.confirmed + outcome.dismissed).toBe(1);
  });
});
