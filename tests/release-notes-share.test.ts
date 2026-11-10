import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecute, enforceExportRateLimit } = vi.hoisted(() => ({ dbExecute: vi.fn(), enforceExportRateLimit: vi.fn() }));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute }) }));
vi.mock("../lib/rate-limit", () => ({ enforceExportRateLimit }));

import { GET } from "../app/share/notes/[token]/route";

const noteRow = { id: 5, publishedAt: new Date("2026-11-11T00:00:00Z"), productName: "SalesBuddy" };

const blockRows = [
  { spec_change_id: 11, summaryOverride: "人工改写后的文案", kind: "added", featureName: "助理聊天", scenarioReference: "HP-2", summary: "URL 可点", highlightType: "News", beforeJson: null, afterJson: { scenarios: [{ evidence: [{ path: "lib/chat.ts" }] }] } },
  { spec_change_id: 12, summaryOverride: null, kind: "changed", featureName: "定价答复", scenarioReference: "EC-1", summary: "确定性答复", highlightType: null, beforeJson: null, afterJson: { scenarios: [{ evidence: [{ path: "lib/pricing.ts" }] }] } },
];

describe("release notes public share page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceExportRateLimit.mockResolvedValue(null);
  });

  it("renders the human override when present and the live summary otherwise", async () => {
    dbExecute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM release_notes n JOIN products")) return [[noteRow], []];
      if (sql.includes("FROM release_note_blocks b")) return [blockRows, []];
      return [[], []];
    });
    const response = await GET(new NextRequest("https://codelphi.example/share/notes/tok"), { params: Promise.resolve({ token: "tok" }) });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("人工改写后的文案");
    expect(html).toContain("确定性答复");
    expect(html).toContain("Highlight: News");
    expect(html).toContain("lib/chat.ts");
    expect(html).not.toContain("URL 可点");
  });

  it("404s for unknown or unpublished tokens and enforces the export rate limit", async () => {
    dbExecute.mockImplementation(async () => [[], []]);
    const response = await GET(new NextRequest("https://codelphi.example/share/notes/none"), { params: Promise.resolve({ token: "none" }) });
    expect(response.status).toBe(404);
    expect(enforceExportRateLimit).toHaveBeenCalled();
  });
});
