import { beforeEach, describe, expect, it, vi } from "vitest";

const PATCHBody = (body: unknown, route: { PATCH: (request: never) => Promise<Response> }) =>
  route.PATCH({ json: async () => body } as never).then(async (result) => ({ status: result.status, body: await (result as Response).json() as unknown as Record<string, unknown> }));

vi.mock("@/lib/session", () => ({ requireSessionUser: vi.fn(async () => ({ id: 1 })) }));
const { updateLanguageDefault, getLanguageDefault, requireOrganization } = vi.hoisted(() => ({
  updateLanguageDefault: vi.fn(async () => undefined),
  getLanguageDefault: vi.fn(async (): Promise<string> => "zh-CN"),
  requireOrganization: vi.fn(),
}));
vi.mock("@/lib/organizations", () => ({ requireOrganization: (...args: unknown[]) => requireOrganization(...args) }));
vi.mock("@/lib/analysis-trigger", () => ({
  updateWorkspaceOutputLanguageDefault: updateLanguageDefault,
  getWorkspaceOutputLanguageDefault: getLanguageDefault,
}));

const { PATCH, GET } = await import("@/app/api/settings/output-language-default/route");

beforeEach(() => {
  vi.clearAllMocks();
  requireOrganization.mockResolvedValue({ id: 7, slug: "ws", name: "WS", role: "editor" });
});

describe("PATCH /api/settings/output-language-default", () => {
  it("updates the workspace default for workspace editors", async () => {
    const { status, body } = await PATCHBody({ language: "en" }, { PATCH });
    expect(status).toBe(200);
    expect(body).toEqual({ status: "updated", language: "en" });
    expect(updateLanguageDefault).toHaveBeenCalledWith(7, "en");
  });

  it("rejects viewers with 403", async () => {
    requireOrganization.mockRejectedValue(new Error("forbidden"));
    const { status } = await PATCHBody({ language: "en" }, { PATCH });
    expect(status).toBe(403);
    expect(updateLanguageDefault).not.toHaveBeenCalled();
  });

  it("validates the language enum", async () => {
    const { status } = await PATCHBody({ language: "fr" }, { PATCH });
    expect(status).toBe(400);
    expect(updateLanguageDefault).not.toHaveBeenCalled();
  });
});

describe("GET /api/settings/output-language-default", () => {
  it("returns the current default for viewers", async () => {
    requireOrganization.mockResolvedValue({ id: 7, role: "viewer" });
    getLanguageDefault.mockResolvedValue("en");
    const result = await GET();
    expect(result.status).toBe(200);
    expect(await (result as Response).json()).toEqual({ status: "ok", language: "en" });
  });
});
