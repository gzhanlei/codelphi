import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecute, requestStructuredCompletion, loadNoteById } = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  requestStructuredCompletion: vi.fn(),
  loadNoteById: vi.fn(),
}));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute }) }));
vi.mock("../lib/session", () => ({ getSessionUser: vi.fn(), requireSessionUser: vi.fn() }));
vi.mock("../lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("../lib/rate-limit", () => ({ enforceExportRateLimit: vi.fn(async () => null) }));
vi.mock("../lib/ai", () => ({ requestStructuredCompletion: requestStructuredCompletion }));
vi.mock("../lib/release-notes-service", () => ({ loadNoteById: loadNoteById }));

import { POST } from "../app/api/products/[slug]/release-notes/[noteId]/enhance/route";
import { buildEnhancePrompt, parseEnhancedSummary } from "../lib/release-notes-enhance";
import { getSessionUser } from "../lib/session";
import { requireProductAccess } from "../lib/product-access";
import { currentOrganizationModel } from "../lib/organization-model";
import { encryptSecret } from "../lib/secret-box";
import { MODEL_REQUIRED_RESPONSE_MESSAGE } from "../lib/analysis-executor";

const access = {
  product: { id: 1, slug: "salesbuddy", name: "SalesBuddy", description: "d", organizationId: 7 },
  organization: { id: 7, slug: "team", name: "Team", role: "owner" },
  role: "owner",
  via: "organization",
} as const;

const note = { id: 5, status: "draft", emphasis: "定价已收口", voiceId: null, shareToken: "tok", publishedAt: null, unpublishedAt: null, releaseId: 9 };

const blockRow = { emphasis: "", kind: "added", featureName: "助理聊天", scenarioReference: "HP-2", summary: "URL 可点", highlightType: "News" };

const WORKSPACE_MODEL = { baseUrl: "https://api.example/v1", apiKey: "sk-workspace", model: "k3-256k" };
/** 工作区有没有自己的模型配置。润色要用它；没有就什么都不调。 */
let modelConfigured = true;

function enhanceRequest(body: unknown) {
  return new NextRequest("https://codelphi.example/api/products/salesbuddy/release-notes/5/enhance", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("release note enhance (A2 §4.3-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionUser).mockResolvedValue({ id: 3, sub: "user-1", email: "a@b.c", name: "A", picture: "" } as never);
    vi.mocked(requireProductAccess).mockResolvedValue(access as never);
    loadNoteById.mockResolvedValue(note);
    vi.stubEnv("SESSION_SECRET", "enhance-test-secret");
    modelConfigured = true;
    dbExecute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM organization_models WHERE organization_id")) {
        return [modelConfigured ? [{ base_url: WORKSPACE_MODEL.baseUrl, api_key_encrypted: encryptSecret(WORKSPACE_MODEL.apiKey, "enhance-test-secret"), model: WORKSPACE_MODEL.model }] : []];
      }
      return [[blockRow], []];
    });
  });

  it("rewrites inside the workspace's own model", async () => {
    const seen: unknown[] = [];
    requestStructuredCompletion.mockImplementation(async () => {
      seen.push(currentOrganizationModel());
      return JSON.stringify({ summary: "改写后的文案" });
    });
    const response = await POST(enhanceRequest({ position: 1 }), { params: Promise.resolve({ slug: "salesbuddy", noteId: "5" }) });
    expect((await response.json()).suggestion).toBe("改写后的文案");
    expect(seen).toEqual([{ organizationId: 7, ...WORKSPACE_MODEL }]);
    expect(currentOrganizationModel()).toBeNull();
  });

  it("answers 409 and calls no model when the workspace has no model of its own", async () => {
    modelConfigured = false;
    const response = await POST(enhanceRequest({ position: 1 }), { params: Promise.resolve({ slug: "salesbuddy", noteId: "5" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "model_not_configured", message: MODEL_REQUIRED_RESPONSE_MESSAGE });
    expect(requestStructuredCompletion).not.toHaveBeenCalled();
  });

  it("prompt carries facts-only rules, emphasis alignment, and optional instruction", () => {
    const prompt = buildEnhancePrompt({ kind: "added", featureName: "助理聊天", scenarioReference: "HP-2", summary: "URL 可点", highlightType: "News", emphasis: "定价已收口", instruction: "更简短" });
    expect(prompt).toContain("禁止新增原文没有的功能、数字、日期或承诺");
    expect(prompt).toContain("定价已收口");
    expect(prompt).toContain("用户指令：更简短");
    expect(prompt).toContain("新增 助理聊天 · HP-2（News）：URL 可点");
  });

  it("parses fenced JSON and plain-text AI output", () => {
    expect(parseEnhancedSummary('```json\n{"summary":"改写后的文案"}\n```')).toBe("改写后的文案");
    expect(parseEnhancedSummary("改写后的纯文本文案")).toBe("改写后的纯文本文案");
    expect(() => parseEnhancedSummary("")).toThrow();
    expect(() => parseEnhancedSummary("x".repeat(4001))).toThrow();
  });

  it("returns the suggestion without persisting (人在环) and bills with release_note_enhance kind", async () => {
    requestStructuredCompletion.mockResolvedValue(JSON.stringify({ summary: "聊天里的链接现在可以直接点了" }));
    const response = await POST(enhanceRequest({ position: 1 }), { params: Promise.resolve({ slug: "salesbuddy", noteId: "5" }) });
    const data = await response.json();
    expect(data.suggestion).toBe("聊天里的链接现在可以直接点了");
    // 不自动落库
    expect(dbExecute.mock.calls.some(([sql]) => String(sql).includes("UPDATE release_note_blocks"))).toBe(false);
    const call = requestStructuredCompletion.mock.calls[0];
    expect(call[1]).toEqual({ runId: null, accountId: null, chargeComponent: "main", callKind: "release_note_enhance" });
  });

  it("409 on published notes and 404 for missing blocks", async () => {
    loadNoteById.mockResolvedValue({ ...note, status: "published" });
    expect((await POST(enhanceRequest({ position: 1 }), { params: Promise.resolve({ slug: "salesbuddy", noteId: "5" }) })).status).toBe(409);
    loadNoteById.mockResolvedValue(note);
    dbExecute.mockResolvedValue([[], []]);
    expect((await POST(enhanceRequest({ position: 99 }), { params: Promise.resolve({ slug: "salesbuddy", noteId: "5" }) })).status).toBe(404);
  });
});
