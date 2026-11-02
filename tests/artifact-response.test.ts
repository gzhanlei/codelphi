import { describe, expect, it, vi } from "vitest";
import { architectureArtifactResponse } from "../lib/artifact-response";

const record = {
  productId: 4,
  productSlug: "radar",
  productName: "Radar",
  specVersionId: 7,
  revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
  status: "accepted" as const,
  specJson: "{}",
  specSha256: "a".repeat(64),
  artifactPath: "artifacts/products/radar/7/architecture.html",
  artifactSha256: "b".repeat(64),
  validationReceipt: { ok: true },
  visualReceipt: { ok: true },
  errorMessage: null,
};

describe("architecture artifact response", () => {
  it("serves accepted HTML with a restrictive sandbox and private cache", async () => {
    const reader = vi.fn(async () => "<html>architecture</html>");
    const response = await architectureArtifactResponse(record, "/tmp/radar", reader);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>architecture</html>");
    expect(reader).toHaveBeenCalledWith("/tmp/radar/artifacts/products/radar/7/architecture.html", "utf8");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts allow-downloads");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("rejects unaccepted documents without reading the filesystem", async () => {
    const reader = vi.fn();
    const response = await architectureArtifactResponse({ ...record, status: "rendered" }, "/tmp/radar", reader);
    expect(response.status).toBe(409);
    expect(reader).not.toHaveBeenCalled();
  });

  it("rethrows non-object reader failures", async () => {
    for (const failure of ["primitive", null]) {
      const reader = vi.fn(async () => { throw failure; });
      await expect(architectureArtifactResponse(record, "/tmp/radar", reader)).rejects.toBe(failure);
    }
  });

  it("returns 404 when the accepted artifact is missing", async () => {
    const reader = vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    const response = await architectureArtifactResponse(record, "/tmp/radar", reader);
    expect(response.status).toBe(404);
  });
});
