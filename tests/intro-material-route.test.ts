import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecute, loadMaterial, saveMaterial, updatePpt, createPptJob, getPptJobStatus, getProductDetails, requestStructuredCompletion } = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  loadMaterial: vi.fn(),
  saveMaterial: vi.fn(),
  updatePpt: vi.fn(),
  createPptJob: vi.fn(),
  getPptJobStatus: vi.fn(),
  getProductDetails: vi.fn(),
  requestStructuredCompletion: vi.fn(),
}));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute }) }));
vi.mock("../lib/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("../lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("../lib/rate-limit", () => ({ enforceExportRateLimit: vi.fn(async () => null) }));
vi.mock("../lib/product-details", () => ({ getProductDetails: getProductDetails }));
vi.mock("../lib/ai", () => ({ requestStructuredCompletion: requestStructuredCompletion }));
vi.mock("../lib/intro-material-service", () => ({
  loadIntroMaterial: loadMaterial,
  saveIntroMaterial: saveMaterial,
  updatePptFields: updatePpt,
}));
vi.mock("../lib/ppt-partner", () => {
  class PptPartnerError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
  }
  return {
    createPptJob: createPptJob,
    getPptJobStatus: getPptJobStatus,
    getPptDownload: vi.fn(),
    PptPartnerError,
    requirePptPartnerConfig: vi.fn(() => {
      if (!process.env.PPT_PARTNER_KEY) throw new PptPartnerError("not_configured", "PPT 服务未配置（缺 PPT_PARTNER_KEY）");
      return { url: "https://ppt.example/mcp", key: "test-key", orgId: null, memberId: null };
    }),
  };
});

import { GET, POST } from "../app/api/products/[slug]/intro-material/route";
import { GET as pptGET, POST as pptPOST } from "../app/api/products/[slug]/intro-material/ppt/route";
import { GET as downloadGET } from "../app/api/products/[slug]/intro-material/ppt/download/route";
import { getSessionUser } from "../lib/session";
import { requireProductAccess } from "../lib/product-access";

const access = {
  product: { id: 1, slug: "aivlog", name: "AI视频小程序", description: "d", organizationId: 7 },
  organization: { id: 7, slug: "team", name: "Team", role: "owner" },
  role: "owner",
  via: "organization",
} as const;

const details = {
  product: { id: 1, slug: "aivlog", name: "AI视频小程序", description: "面向景区的写真小程序", descriptionSource: "generated", positioning: { audience: "景区商户", differentiation: "现场出片快", tone: "克制" } },
  repository: { owner: "x", name: "y", defaultBranch: "main" },
  latestRun: { status: "succeeded" },
  features: [{ id: 1, name: "写真生成", summary: "上传自拍生成写真", source: "generated", staleSince: null }],
  scenarios: [{ featureId: 1, source: "generated", evidence: [{ path: "lib/a.ts" }] }],
  releases: [{ id: 5, title: "国风模板", summary: "新增模板", sha: "abc", url: null, committedAt: new Date(), specVersionId: 42 }],
  releaseTotal: 1,
  changes: [],
  behaviorChanges: [{ id: 9, releaseId: 5, kind: "added", entityType: "scenario", featureName: "写真生成", scenarioReference: "HP-1", summary: "新增国风模板", highlightType: "News", highlightReason: null, before: null, after: null }],
  regressionTasks: [],
  foldedChanges: [],
  coverage: { coverageRatio: 0.421, implFilesAssembled: 12, implFilesTotal: 28, partitionsUsed: 3, partitionsCapped: false },
  completeness: null,
  driftCount: 0,
} as never;

const materialRow = {
  id: 3,
  specVersionId: 42,
  draft: {
    specVersionId: 42,
    slides: [
      { slideType: "COVER", section: "", title: "AI视频小程序", keyPoints: [], notes: "开场。", anchors: [] },
      { slideType: "CONTENT", section: "能力", title: "写真生成", keyPoints: ["上传自拍生成写真"], notes: "能力讲稿。", anchors: [{ kind: "feature", id: 1 }] },
      { slideType: "BACK_COVER", section: "", title: "来源", keyPoints: [], notes: "收尾。", anchors: [] },
    ],
  },
  status: "draft",
  pptProjectId: "pp-1",
  pptJobId: "cd-intro-3-1",
  pptStatus: "COMPLETED",
  pptError: null,
  updatedAt: new Date(),
};

const aiDraft = {
  slides: [
    { slideType: "COVER", section: "", title: "AI视频小程序", keyPoints: [], notes: "开场讲稿。", anchors: [] },
    { slideType: "CONTENT", section: "能力", title: "写真生成", keyPoints: ["上传自拍生成写真"], notes: "能力讲稿。", anchors: [{ kind: "feature", id: 1 }] },
    { slideType: "BACK_COVER", section: "可信度", title: "来源与口径", keyPoints: ["覆盖率 42.1%"], notes: "收尾讲稿。", anchors: [{ kind: "manual", id: 0 }] },
  ],
};

function request(path: string, method: "GET" | "POST", body?: unknown) {
  return new NextRequest(`https://codelphi.example/api/products/aivlog/intro-material${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
}

describe("intro material routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PPT_PARTNER_KEY = "test-key";
    vi.mocked(getSessionUser).mockResolvedValue({ id: 3, sub: "user-1", email: "a@b.c", name: "A", picture: "" } as never);
    vi.mocked(requireProductAccess).mockResolvedValue(access as never);
    getProductDetails.mockResolvedValue(details);
    saveMaterial.mockResolvedValue(3);
    updatePpt.mockResolvedValue(undefined);
    createPptJob.mockResolvedValue({ projectId: "pp-new", status: "queued", message: null });
    getPptJobStatus.mockResolvedValue({ projectId: "pp-1", status: "COMPLETED", pptxUrl: "https://ppt/x", error: null });
  });

  it("GET returns positioning, coverage note, and stored material", async () => {
    loadMaterial.mockResolvedValue(materialRow);
    const response = await GET(request("", "GET"), { params: Promise.resolve({ slug: "aivlog" }) });
    const data = await response.json();
    expect(data.positioning.audience).toBe("景区商户");
    expect(data.coverageNote).toContain("42.1%");
    expect(data.material.slides).toHaveLength(3);
    expect(data.material.ppt.status).toBe("COMPLETED");
  });

  it("POST generates via AI, validates anchors, and persists with call_kind intro_material billing context", async () => {
    loadMaterial.mockResolvedValue(null);
    requestStructuredCompletion.mockResolvedValue(JSON.stringify(aiDraft));
    const response = await POST(request("", "POST", {}), { params: Promise.resolve({ slug: "aivlog" }) });
    expect(response.status).toBe(200);
    expect(saveMaterial).toHaveBeenCalledTimes(1);
    const call = requestStructuredCompletion.mock.calls[0];
    expect(call[1]).toEqual({ runId: null, accountId: null, chargeComponent: "main", callKind: "intro_material" });
  });

  it("POST refuses to persist a draft whose anchors dangle (生成侧引用校验)", async () => {
    loadMaterial.mockResolvedValue(null);
    requestStructuredCompletion.mockResolvedValue(JSON.stringify({ slides: aiDraft.slides.map((slide, index) => (index === 1 ? { ...slide, anchors: [{ kind: "feature", id: 999 }] } : slide)) }));
    const response = await POST(request("", "POST", {}), { params: Promise.resolve({ slug: "aivlog" }) });
    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.error).toContain("锚定校验");
    expect(saveMaterial).not.toHaveBeenCalled();
  });

  it("PPT POST requires partner config (501 when unconfigured)", async () => {
    delete process.env.PPT_PARTNER_KEY;
    loadMaterial.mockResolvedValue(materialRow);
    const response = await pptPOST(request("/ppt", "POST", {}), { params: Promise.resolve({ slug: "aivlog" }) });
    expect(response.status).toBe(501);
    expect(createPptJob).not.toHaveBeenCalled();
  });

  it("PPT POST submits confirmed_outline job and GET polls status", async () => {
    loadMaterial.mockResolvedValue(materialRow);
    const submitted = await pptPOST(request("/ppt", "POST", {}), { params: Promise.resolve({ slug: "aivlog" }) });
    expect(submitted.status).toBe(200);
    expect(createPptJob).toHaveBeenCalledTimes(1);
    const createArgs = createPptJob.mock.calls[0][1];
    expect(createArgs.outline[1].type).toBe("CONTENT");
    expect(createArgs.outline[1].keyPoints.length).toBeGreaterThan(0);
    expect(createArgs.outline.every((slide: { notes?: string }) => slide.notes && slide.notes.length > 0)).toBe(true);
    expect(updatePpt).toHaveBeenCalled();

    const polled = await pptGET(request("/ppt", "GET"), { params: Promise.resolve({ slug: "aivlog" }) });
    const data = await polled.json();
    expect(data.status).toBe("COMPLETED");
    expect(data.ready).toBe(true);
  });

  it("download 404s when no PPT job exists", async () => {
    dbExecute.mockResolvedValue([[], []]);
    loadMaterial.mockResolvedValue(null);
    const response = await downloadGET(request("/ppt/download", "GET"), { params: Promise.resolve({ slug: "aivlog" }) });
    expect(response.status).toBe(404);
  });
});
