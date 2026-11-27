import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "../app/api/products/[slug]/route";
import { MODEL_NOT_CONFIGURED_RESPONSE_MESSAGE, ModelNotConfiguredError, switchAnalysisExecutor } from "../lib/analysis-executor";
import { updateProductIdentity } from "@/lib/product-rename";
import { updateProductDescription } from "@/lib/product-description";

vi.mock("@/lib/analysis-executor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysis-executor")>()),
  switchAnalysisExecutor: vi.fn(),
}));
vi.mock("@/lib/product-rename", () => ({ updateProductIdentity: vi.fn(async () => ({ status: "renamed", slug: "radar", name: "Radar" })) }));
vi.mock("@/lib/product-description", () => ({ updateProductDescription: vi.fn(async () => true) }));
vi.mock("@/lib/session", () => ({ requireSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("@/lib/product-access", () => ({
  requireProductAccess: vi.fn(async () => ({
    product: { id: 2, slug: "radar", name: "Radar", description: "", organizationId: 7 },
    organization: { id: 7, slug: "team", name: "Team", role: "editor" },
    role: "editor",
    via: "organization",
  })),
}));

const patch = (body: unknown) => PATCH(new NextRequest("http://localhost/api/products/radar", { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ slug: "radar" }) });

describe("switching how a product is analysed through the product route", () => {
  beforeEach(() => {
    vi.mocked(switchAnalysisExecutor).mockReset();
    vi.mocked(switchAnalysisExecutor).mockResolvedValue(undefined);
  });

  it("switches the product and says updated", async () => {
    const response = await patch({ analysisExecutor: "server" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "updated", slug: "radar", name: "Radar", organizationSlug: "team" });
    expect(switchAnalysisExecutor).toHaveBeenCalledWith(2, "server");
  });

  it("answers 409 with the reason when the workspace has no model of its own", async () => {
    vi.mocked(switchAnalysisExecutor).mockRejectedValue(new ModelNotConfiguredError());
    const response = await patch({ analysisExecutor: "server" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "model_not_configured", message: MODEL_NOT_CONFIGURED_RESPONSE_MESSAGE });
  });

  it("can be saved together with other settings, and refuses values it does not know", async () => {
    const response = await patch({ analysisExecutor: "client", name: "Radar 2" });
    expect(response.status).toBe(200);
    expect(switchAnalysisExecutor).toHaveBeenCalledWith(2, "client");
    expect(updateProductIdentity).toHaveBeenCalled();
    expect((await patch({ analysisExecutor: "elsewhere" })).status).toBe(400);
    expect(switchAnalysisExecutor).toHaveBeenCalledTimes(1);
    expect(updateProductDescription).not.toHaveBeenCalled();
  });
});
