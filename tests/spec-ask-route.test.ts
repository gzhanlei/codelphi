import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/products/[slug]/spec/ask/route";
import { answerSpecQuestion, type SpecAnswer } from "../lib/spec-ask";

const { getSessionUser, resolveDemo, requireAccess } = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  resolveDemo: vi.fn(),
  requireAccess: vi.fn(),
}));

vi.mock("../lib/session", () => ({ getSessionUser }));
vi.mock("../lib/public-demo", () => ({ resolveLegacyPublicDemoProduct: resolveDemo }));
vi.mock("../lib/product-access", () => ({ requireProductAccess: requireAccess }));
vi.mock("../lib/spec-ask", () => ({ answerSpecQuestion: vi.fn() }));

const MATCHED = {
  status: "matched" as const,
  question: "上传文件最多几个？",
  terms: ["上传", "文件", "最多"],
  features: [{ id: 1, name: "文件上传", summary: "上传附件，限制数量与大小" }],
  scenarios: [{ id: 11, featureId: 1, featureName: "文件上传", reference: "HP-1", context: "用户在上传框选择附件", action: "一次选择不超过 10 个文件", outcome: "系统接受并进入上传队列" }],
  notice: "以下为规格原文摘录，非 AI 生成；点击条目可查看完整功能与代码证据。",
};
const UNCOVERED: SpecAnswer = {
  status: "uncovered",
  question: "怎么配置 SSO？",
  terms: ["SSO"],
  features: [],
  scenarios: [],
  notice: "当前规格未覆盖此问题，未覆盖部分不产生结论。可换用更贴近功能名称的词，或前往规格页查看。",
};
const context = { params: Promise.resolve({ slug: "radar" }) };

describe("spec ask route (B2.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionUser.mockResolvedValue({ sub: "user", email: "pm@example.com" });
    requireAccess.mockResolvedValue({ product: { id: 3 } });
    resolveDemo.mockResolvedValue(null);
    vi.mocked(answerSpecQuestion).mockResolvedValue(MATCHED);
  });

  it("answers a natural-language question with the spec's own wording", async () => {
    const response = await GET(new NextRequest("https://radar.example/api/products/radar/spec/ask?q=%E4%B8%8A%E4%BC%A0%E6%96%87%E4%BB%B6%E6%9C%80%E5%A4%9A%E5%87%A0%E4%B8%AA%EF%BC%9F"), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as typeof MATCHED;
    expect(payload.status).toBe("matched");
    expect(payload.scenarios[0].outcome).toBe("系统接受并进入上传队列");
    expect(payload.notice).toContain("规格原文");
    expect(answerSpecQuestion).toHaveBeenCalledWith(3, "上传文件最多几个？");
  });

  it("returns 401 JSON for an anonymous visitor on a non-demo product", async () => {
    getSessionUser.mockResolvedValue(null);
    const response = await GET(new NextRequest("https://radar.example/api/products/radar/spec/ask?q=test"), context);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "未登录" });
    expect(answerSpecQuestion).not.toHaveBeenCalled();
  });

  it("serves the public demo product to anonymous visitors without a session", async () => {
    getSessionUser.mockResolvedValue(null);
    resolveDemo.mockResolvedValue({ id: 9, slug: "radar", name: "Radar", organizationId: 7, organizationSlug: "team" });
    const response = await GET(new NextRequest("https://radar.example/api/products/radar/spec/ask?q=test"), context);
    expect(response.status).toBe(200);
    expect(answerSpecQuestion).toHaveBeenCalledWith(9, "test");
  });

  it("returns 404 for logged-in users without access instead of leaking the demo fallback", async () => {
    requireAccess.mockResolvedValue(null);
    const response = await GET(new NextRequest("https://radar.example/api/products/radar/spec/ask?q=test"), context);
    expect(response.status).toBe(404);
    expect(answerSpecQuestion).not.toHaveBeenCalled();
  });

  it("reports an uncovered question instead of erroring on an empty query", async () => {
    vi.mocked(answerSpecQuestion).mockResolvedValue(UNCOVERED);
    const response = await GET(new NextRequest("https://radar.example/api/products/radar/spec/ask"), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as typeof UNCOVERED;
    expect(payload.status).toBe("uncovered");
    expect(payload.notice).toContain("未覆盖");
    expect(answerSpecQuestion).toHaveBeenCalledWith(3, "");
  });
});
