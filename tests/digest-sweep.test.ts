import { beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "../lib/secret-box";

// 直接设 env 而非 vi.mock（共享 shard 里 env mock 工厂碰撞会偶发漏桩）
process.env.SESSION_SECRET = "test-secret";
import { digestWindow, renderDigestText, runDigestSweepOnce } from "../lib/digest-sweep";

const execute = vi.fn();

const changeRow = {
  id: 11, kind: "added", entityType: "scenario", featureName: "助理聊天", scenarioReference: "HP-2",
  summary: "URL 可点", highlightType: "News", beforeJson: null,
  afterJson: { scenarios: [{ evidence: [{ path: "lib/chat.ts" }] }] },
  releaseTitle: "助理聊天升级", releaseUrl: "https://github.com/x/y/compare/a...b",
};

const productRow = { id: 1, name: "SalesBuddy" };

const deliveries = { posted: [] as Array<{ target: string; body: string }>, emails: [] as Array<{ to: string; subject: string }> };

describe("digest weekly sweep (A2 §4.3 接线)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliveries.posted = [];
    deliveries.emails = [];
  });

  it("window ends yesterday UTC and spans seven days", () => {
    const window = digestWindow(new Date("2026-11-11T03:00:00Z"));
    expect(window.periodEnd).toBe("2026-11-10");
    expect(window.periodStart).toBe("2026-11-04");
    expect(window.fromLiteral).toBe("2026-11-04 00:00:00");
    expect(window.toLiteral).toBe("2026-11-10 23:59:59");
  });

  it("generates, stores and delivers a digest when the window has behavior changes", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("DISTINCT p.id")) return [[productRow], []];
      if (sql.includes("FROM digests WHERE product_id")) return [[], []];
      if (sql.includes("FROM spec_changes c")) return [[changeRow], []];
      if (sql.includes("FROM notification_channels")) return [[{ id: 7, kind: "slack", target_encrypted: encryptSecret("https://hooks.slack.com/services/T/B/X", "test-secret") }], []];
      if (sql.includes("FROM user_email_prefs")) return [[{ userId: 3, email: "a@b.c" }], []];
      return [[], []];
    });
    const outcome = await runDigestSweepOnce(execute, new Date("2026-11-11T03:00:00Z"), {
      post: async (target, body) => { deliveries.posted.push({ target, body }); },
      sendEmail: async (to, subject) => { deliveries.emails.push({ to, subject }); },
    });
    expect(outcome).toEqual({ generated: 1, skipped: 0, products: 1 });
    const insert = execute.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO digests"));
    expect(insert).toBeDefined();
    const insertArgs = insert as unknown as [string, unknown[]];
    expect(insertArgs[1][1]).toBe("2026-11-04");
    expect(JSON.parse(insertArgs[1][3] as string).changes).toHaveLength(1);
    expect(deliveries.posted).toHaveLength(1);
    expect(deliveries.emails).toHaveLength(1);
    expect(deliveries.emails[0].subject).toContain("周期行为摘要");
  });

  it("skips products whose digest for this period already exists and skips empty weeks without rows", async () => {
    const products = [productRow, { id: 2, name: "RepoMap" }];
    execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("DISTINCT p.id")) return [products, []];
      if (sql.includes("FROM digests WHERE product_id")) return [Number((params as unknown[] | undefined)?.[0]) === 1 ? [{ id: 9 }] : [], []];
      if (sql.includes("FROM spec_changes c")) return [Number((params as unknown[] | undefined)?.[0]) === 2 ? [] : [changeRow], []];
      return [[], []];
    });
    const outcome = await runDigestSweepOnce(execute, new Date("2026-11-11T03:00:00Z"), {
      post: async () => { throw new Error("should not deliver"); },
    });
    expect(outcome).toEqual({ generated: 0, skipped: 1, products: 2 });
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO digests"))).toBe(false);
  });

  it("renders deterministic text with audience-relevant highlights and evidence", () => {
    const text = renderDigestText("SalesBuddy", {
      period: { start: "2026-11-04", end: "2026-11-10" },
      changes: [{ ...changeRow, specChangeId: 11, evidencePaths: ["lib/chat.ts"] }],
      audiences: { support: [], sales: [], marketing: [] },
    });
    expect(text).toContain("SalesBuddy 周期行为摘要（2026-11-04 ~ 2026-11-10）");
    expect(text).toContain("- 新增 助理聊天 · HP-2：URL 可点（News）");
    expect(text).toContain("证据：lib/chat.ts");
  });
});
