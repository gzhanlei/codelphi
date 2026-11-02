import { describe, expect, it, vi } from "vitest";
import { finalizeExplainer } from "../lib/archify-cli";

describe("Explainer CLI", () => {
  it("finalizes with repository evidence and browser checking", async () => {
    const runner = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true, command: "finalize" }), stderr: "" }));
    await finalizeExplainer({ input: "/tmp/candidate.archify.md", output: "/tmp/product.html", repoRoot: "/tmp/repo", browserCheck: true, outDir: "/tmp/receipts", bin: "/opt/archify/bin.mjs" }, runner);
    expect(runner).toHaveBeenCalledWith(process.execPath, ["/opt/archify/bin.mjs", "finalize", "explainer", "/tmp/candidate.archify.md", "/tmp/product.html", "--repo-root", "/tmp/repo", "--browser-check", "--out-dir", "/tmp/receipts", "--json"], expect.objectContaining({ shell: false, timeout: 300_000 }));
  });

  it("honors an explicit zero timeout", async () => {
    const runner = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true }), stderr: "" }));
    await finalizeExplainer({ input: "/tmp/candidate.archify.md", output: "/tmp/product.html", bin: "/opt/archify/bin.mjs", timeoutMs: 0 }, runner);
    expect(runner).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({ timeout: 0 }));
  });

  it("omits optional repository and browser flags", async () => {
    const runner = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true, command: "finalize" }), stderr: "" }));
    await finalizeExplainer({ input: "/tmp/candidate.archify.md", output: "/tmp/product.html", bin: "/opt/archify/bin.mjs" }, runner);
    expect(runner).toHaveBeenCalledWith(process.execPath, ["/opt/archify/bin.mjs", "finalize", "explainer", "/tmp/candidate.archify.md", "/tmp/product.html", "--json"], expect.any(Object));
  });
});
