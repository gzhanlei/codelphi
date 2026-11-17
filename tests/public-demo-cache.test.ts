import { describe, expect, it, vi } from "vitest";
import { createPublicDemoCache } from "../lib/public-demo";

describe("public demo detail cache", () => {
  it("coalesces concurrent reads and reuses a fresh value", async () => {
    const cached = createPublicDemoCache({ ttlMs: 15_000 });
    const loader = vi.fn(async () => ({ value: "details" }));

    const [first, second] = await Promise.all([
      cached("org-1:product:overview", loader),
      cached("org-1:product:overview", loader),
    ]);
    const third = await cached("org-1:product:overview", loader);

    expect(first).toEqual({ value: "details" });
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("keeps workspaces and views in separate entries", async () => {
    const cached = createPublicDemoCache({ ttlMs: 15_000 });
    const loader = vi.fn(async (key: string) => key);

    const orgOne = await cached("org-1:product:overview", () => loader("org-1"));
    const orgTwo = await cached("org-2:product:overview", () => loader("org-2"));
    const changes = await cached("org-1:product:changes", () => loader("changes"));

    expect([orgOne, orgTwo, changes]).toEqual(["org-1", "org-2", "changes"]);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("reloads after the TTL expires", async () => {
    let now = 1_000;
    const cached = createPublicDemoCache({ ttlMs: 10, now: () => now });
    const loader = vi.fn(async () => loader.mock.calls.length);

    await expect(cached("product", loader)).resolves.toBe(1);
    now += 11;
    await expect(cached("product", loader)).resolves.toBe(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed read", async () => {
    const cached = createPublicDemoCache({ ttlMs: 15_000 });
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce("recovered");

    await expect(cached("product", loader)).rejects.toThrow("database unavailable");
    await expect(cached("product", loader)).resolves.toBe("recovered");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
