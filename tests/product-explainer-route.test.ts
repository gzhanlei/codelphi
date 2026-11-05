import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/products/[slug]/explainer/route";
import { getProductDetails } from "../lib/product-details";
import { buildProductOverview } from "../lib/product-overview";
import { exportProductExplainer } from "../lib/explainer-export";
import { ArchifyCommandError } from "../lib/archify-cli";
import { readFile } from "node:fs/promises";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("../lib/product-access", () => ({
  requireProductAccess: vi.fn(async () => ({
    product: { id: 1, slug: "radar", name: "Radar", description: "", organizationId: 7 },
    organization: { id: 7, slug: "team", name: "Team", role: "owner" },
    role: "owner",
    via: "organization",
  })),
}));
vi.mock("../lib/product-details", () => ({ getProductDetails: vi.fn() }));
vi.mock("../lib/product-overview", () => ({ buildProductOverview: vi.fn() }));
vi.mock("../lib/explainer-export", () => ({ exportProductExplainer: vi.fn() }));
vi.mock("../lib/architecture-store", () => ({ safeArtifactAbsolutePath: vi.fn(() => "/tmp/explainer.html") }));
vi.mock("../lib/artifact-response", () => ({ artifactSandboxHeaders: vi.fn(() => ({ "Content-Security-Policy": "sandbox" })) }));
vi.mock("../lib/archify-cli", () => ({
  finalizeExplainer: vi.fn(),
  ArchifyCommandError: class ArchifyCommandError extends Error {
    receipt: { error?: string };
    constructor(receipt: { error?: string }) { super(receipt.error ?? "Archify command failed"); this.receipt = receipt; }
  },
}));

const request = new NextRequest("https://radar.chandler.work/api/products/radar/explainer");
const context = { params: Promise.resolve({ slug: "radar" }) };

describe("product Explainer route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProductDetails).mockResolvedValue({ product: { id: 1, slug: "radar" } } as never);
    vi.mocked(buildProductOverview).mockReturnValue({ headline: "Radar" } as never);
    vi.mocked(exportProductExplainer).mockResolvedValue({ artifactPath: "artifacts/products/radar/8/explainer.html" } as never);
    vi.mocked(readFile).mockResolvedValue("<html>explainer</html>");
  });

  it("returns 404 for an unknown product", async () => {
    vi.mocked(getProductDetails).mockResolvedValue(null);
    const response = await GET(request, context);
    expect(response.status).toBe(404);
    expect(exportProductExplainer).not.toHaveBeenCalled();
  });

  it("exports only product knowledge without architecture or repository evidence", async () => {
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>explainer</html>");
    expect(exportProductExplainer).toHaveBeenCalledWith({ productSlug: "radar", overview: { headline: "Radar" } }, expect.anything());
  });

  it("returns a safe export error", async () => {
    vi.mocked(exportProductExplainer).mockRejectedValue(new Error("write failed"));
    const response = await GET(request, context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "write failed", receipt: undefined });
  });

  it("includes an Archify receipt when finalization fails", async () => {
    vi.mocked(exportProductExplainer).mockRejectedValue(new ArchifyCommandError({ error: "finalize failed" } as never));
    const response = await GET(request, context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "finalize failed", receipt: { error: "finalize failed" } });
  });
});
