import { describe, expect, it, vi } from "vitest";
import { architectureArtifactPath, architectureSpecPath, artifactAbsolutePathForRecord, getArchitectureDocument, getLatestArchitectureDocument, productArchitecturePath, safeArtifactAbsolutePath, saveArchitectureDocument } from "../lib/architecture-store";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

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

describe("architecture store", () => {
  it("creates managed paths and rejects traversal", () => {
    expect(architectureSpecPath("radar", 7)).toBe("artifacts/products/radar/7/architecture.json");
    expect(productArchitecturePath("radar", 7)).toBe("/products/radar/architecture/7");
    expect(architectureArtifactPath("radar", 7)).toBe("artifacts/products/radar/7/architecture.html");
    expect(() => architectureArtifactPath("../etc", 7)).toThrow();
    expect(safeArtifactAbsolutePath(record.artifactPath, "/tmp/radar")).toBe("/tmp/radar/artifacts/products/radar/7/architecture.html");
    expect(() => safeArtifactAbsolutePath("artifacts/products/../../etc/passwd", "/tmp/radar")).toThrow("outside managed artifact directory");
    expect(() => artifactAbsolutePathForRecord({ ...record, artifactPath: "artifacts/products/other/7/architecture.html" }, "/tmp/radar")).toThrow("does not match document identity");
  });

  it("upserts one immutable architecture document per spec version", async () => {
    const execute = vi.fn(async () => [{}]);
    vi.mocked(getDb).mockReturnValue({ execute } as never);
    await saveArchitectureDocument(record);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("ON DUPLICATE KEY UPDATE"), expect.arrayContaining([4, 7, record.revision, "accepted", record.specJson, record.specSha256, record.artifactPath]));
  });

  it("writes SQL null for absent receipts", async () => {
    const execute = vi.fn(async (_sql: string, _parameters: unknown[]) => [{}]);
    vi.mocked(getDb).mockReturnValue({ execute } as never);
    await saveArchitectureDocument({ ...record, validationReceipt: undefined, visualReceipt: undefined });
    const parameters = execute.mock.calls[0][1] as unknown[];
    expect(parameters[8]).toBeNull();
    expect(parameters[9]).toBeNull();
  });

  it("loads the latest architecture document for a product", async () => {
    const execute = vi.fn(async () => [[{ ...record, validation_receipt: "{}", visual_receipt: "{}" }]]);
    vi.mocked(getDb).mockReturnValue({ execute } as never);
    expect(await getLatestArchitectureDocument(4)).toMatchObject({ specVersionId: 7 });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("WHERE d.product_id = ? ORDER BY d.id DESC LIMIT 1"), [4]);
    const empty = vi.fn(async () => [[]]);
    vi.mocked(getDb).mockReturnValue({ execute: empty } as never);
    expect(await getLatestArchitectureDocument(4)).toBeUndefined();
  });

  it("loads a document with its product identity and decoded receipts", async () => {
    const execute = vi.fn(async () => [[{ ...record, validation_receipt: JSON.stringify({ ok: true }), visual_receipt: JSON.stringify({ ok: true }) }]]);
    vi.mocked(getDb).mockReturnValue({ execute } as never);
    const result = await getArchitectureDocument(7);
    expect(result).toMatchObject({ productSlug: "radar", specVersionId: 7, status: "accepted", validationReceipt: { ok: true }, visualReceipt: { ok: true } });
  });
});
