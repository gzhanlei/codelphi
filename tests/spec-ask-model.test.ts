import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionUser, requireAccess, answer, loadContext, dbExecute, requestCompletion, seen } = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireAccess: vi.fn(),
  answer: vi.fn(),
  loadContext: vi.fn(),
  dbExecute: vi.fn(),
  requestCompletion: vi.fn(),
  seen: [] as unknown[],
}));

vi.mock("../lib/session", () => ({ getSessionUser }));
vi.mock("../lib/product-access", () => ({ requireProductAccess: requireAccess }));
vi.mock("../lib/public-demo", () => ({ resolveLegacyPublicDemoProduct: vi.fn(async () => null) }));
vi.mock("../lib/rate-limit", () => ({ enforceExportRateLimit: vi.fn(async () => null) }));
vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute }) }));
vi.mock("../lib/spec-ask", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/spec-ask")>(),
  answerSpecQuestion: answer,
  loadSpecAnswerContext: loadContext,
}));
vi.mock("../lib/ai", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/ai")>(),
  requestStructuredCompletion: requestCompletion,
}));

import { GET } from "../app/api/products/[slug]/spec/ask/route";
import { currentOrganizationModel } from "../lib/organization-model";
import { encryptSecret } from "../lib/secret-box";

const WORKSPACE_MODEL = { baseUrl: "https://api.example/v1", apiKey: "sk-workspace", model: "k3-256k" };
const MATCHED = {
  status: "matched" as const,
  question: "上传文件最多几个？",
  terms: ["上传"],
  features: [{ id: 1, name: "文件上传", summary: "上传附件，限制数量与文件大小", stableKey: "文件上传" }],
  scenarios: [{ id: 11, featureId: 1, featureName: "文件上传", featureStableKey: "文件上传", reference: "HP-1", context: "用户在上传框选择附件", action: "一次选择不超过 10 个文件", outcome: "系统接受并进入上传队列", evidence: [] }],
  notice: "以下为规格原文摘录，非 AI 生成。",
};
const ask = (q: string) => GET(new NextRequest(`https://radar.example/api/products/radar/spec/ask?q=${encodeURIComponent(q)}`), { params: Promise.resolve({ slug: "radar" }) });

describe("the AI answer of a spec question runs on the workspace's own model", () => {
  let modelConfigured: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SESSION_SECRET", "spec-ask-test-secret");
    modelConfigured = true;
    getSessionUser.mockResolvedValue({ sub: "user", email: "pm@example.com" });
    requireAccess.mockResolvedValue({ product: { id: 3, organizationId: 7 } });
    answer.mockResolvedValue(MATCHED);
    loadContext.mockResolvedValue({ specVersionId: 7, repo: null, sha: null });
    dbExecute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM organization_models WHERE organization_id")) {
        return [modelConfigured ? [{ base_url: WORKSPACE_MODEL.baseUrl, api_key_encrypted: encryptSecret(WORKSPACE_MODEL.apiKey, "spec-ask-test-secret"), model: WORKSPACE_MODEL.model }] : []];
      }
      return [[]];
    });
    requestCompletion.mockImplementation(async () => {
      seen.push(currentOrganizationModel());
      return JSON.stringify({ answerable: true, answer: "一次不超过 10 个文件。", used: [] });
    });
  });

  it("answers inside the workspace's model, with the call receipted as before", async () => {
    const response = await ask("上传文件最多几个？");
    expect(response.status).toBe(200);
    expect((await response.json()).aiAnswer).toEqual({ answer: "一次不超过 10 个文件。", used: [] });
    expect(seen).toEqual([{ organizationId: 7, ...WORKSPACE_MODEL }]);
    expect(requestCompletion.mock.calls[0][1]).toEqual({ runId: null, accountId: null, chargeComponent: "main", callKind: "spec_ask_answer" });
    expect(currentOrganizationModel()).toBeNull();
  });

  it("returns the spec cards and calls no model when the workspace has none, saying why there is no AI answer", async () => {
    modelConfigured = false;
    const response = await ask("上传文件最多几个？");
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.status).toBe("matched");
    expect(payload.scenarios[0].outcome).toBe("系统接受并进入上传队列");
    expect(payload.aiAnswer).toBeNull();
    expect(payload.aiUnavailableReason).toBe("工作区还没有配置自己的模型，AI 综合回答不可用；下面的规格条目不受影响。");
    expect(payload.answerInsufficient).toBeUndefined();
    expect(requestCompletion).not.toHaveBeenCalled();
  });

  it("says the same to an anonymous visitor of a public demo product", async () => {
    getSessionUser.mockResolvedValue(null);
    requireAccess.mockResolvedValue(null);
    const { resolveLegacyPublicDemoProduct } = await import("../lib/public-demo");
    vi.mocked(resolveLegacyPublicDemoProduct).mockResolvedValue({ id: 9, slug: "radar", name: "Radar", organizationId: 7, organizationSlug: "team" } as never);
    modelConfigured = false;
    const response = await ask("上传文件最多几个？");
    expect((await response.json()).aiUnavailableReason).toContain("工作区还没有配置自己的模型");
    expect(requestCompletion).not.toHaveBeenCalled();
  });
});
