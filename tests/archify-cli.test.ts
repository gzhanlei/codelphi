import { describe, expect, it, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverArchify, visualCheckArchify } from "../lib/archify-cli";

const delivered = { ok: true, command: "deliver", validation: { checksPassed: 9 } };

function preparedRuntime() {
  const root = mkdtempSync(join(tmpdir(), "radar-archify-cli-"));
  const archive = join(root, "archify-v3.2.0.zip");
  writeFileSync(archive, "pinned archive");
  const sha256 = createHash("sha256").update("pinned archive").digest("hex");
  writeFileSync(join(root, "release.json"), JSON.stringify({ version: "3.2.0", license: "MIT", archive: "archify-v3.2.0.zip", sha256, source: "https://example.com/archify.zip", licenseSource: "https://example.com/LICENSE" }));
  const bin = join(root, "runtime", "archify", "bin", "archify.mjs");
  mkdirSync(join(root, "runtime", "archify", "bin"), { recursive: true });
  writeFileSync(bin, "cli");
  writeFileSync(join(root, "runtime", ".archify-sha256"), sha256);
  return { root, bin };
}

afterEach(() => vi.unstubAllEnvs());

describe("Archify CLI", () => {
  it("delivers with the pinned runtime and safe argument arrays", async () => {
    const runner = vi.fn(async () => ({ stdout: JSON.stringify(delivered), stderr: "" }));
    const receipt = await deliverArchify({ type: "architecture", input: "/tmp/spec.json", output: "/tmp/diagram.html", repoRoot: "/tmp/repo", bin: "/opt/archify/bin.mjs" }, runner);
    expect(receipt).toEqual(delivered);
    expect(runner).toHaveBeenCalledWith(process.execPath, ["/opt/archify/bin.mjs", "deliver", "architecture", "/tmp/spec.json", "/tmp/diagram.html", "--repo-root", "/tmp/repo", "--quality", "showcase", "--json"], expect.objectContaining({ shell: false, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }));
  });

  it("omits repo-root for source specifications already verified at a remote revision", async () => {
    const runner = vi.fn(async () => ({ stdout: JSON.stringify(delivered), stderr: "" }));
    await deliverArchify({ type: "architecture", input: "/tmp/spec.json", output: "/tmp/diagram.html", bin: "/opt/archify/bin.mjs" }, runner);
    expect(runner).toHaveBeenCalledWith(process.execPath, ["/opt/archify/bin.mjs", "deliver", "architecture", "/tmp/spec.json", "/tmp/diagram.html", "--quality", "showcase", "--json"], expect.objectContaining({ shell: false }));
  });

  it("runs visual-check with JSON output and a bounded timeout", async () => {
    const runner = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true, command: "visual-check" }), stderr: "" }));
    await visualCheckArchify({ artifact: "/tmp/diagram.html", bin: "/opt/archify/bin.mjs" }, runner);
    expect(runner).toHaveBeenCalledWith(process.execPath, ["/opt/archify/bin.mjs", "visual-check", "/tmp/diagram.html", "--json"], expect.objectContaining({ shell: false, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }));
  });

  it("falls back to the pinned runtime for an empty bin", async () => {
    const { root, bin } = preparedRuntime();
    vi.stubEnv("ARCHIFY_HOME", root);
    const runner = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true }), stderr: "" }));
    await deliverArchify({ type: "architecture", input: "/tmp/spec.json", output: "/tmp/diagram.html", repoRoot: "/tmp/repo", bin: "" }, runner);
    await visualCheckArchify({ artifact: "/tmp/diagram.html", bin: "" }, runner);
    expect(runner).toHaveBeenNthCalledWith(1, process.execPath, [bin, "deliver", "architecture", "/tmp/spec.json", "/tmp/diagram.html", "--repo-root", "/tmp/repo", "--quality", "showcase", "--json"], expect.any(Object));
    expect(runner).toHaveBeenNthCalledWith(2, process.execPath, [bin, "visual-check", "/tmp/diagram.html", "--json"], expect.any(Object));
  });

  it("surfaces structured validation diagnostics", async () => {
    const receipt = { ok: false, command: "validate", diagnostics: [{ code: "layout/constraint", message: "Label overlaps component" }] };
    const runner = vi.fn(async () => ({ stdout: JSON.stringify(receipt), stderr: "" }));
    await expect(deliverArchify({ type: "architecture", input: "/tmp/spec.json", output: "/tmp/diagram.html", repoRoot: "/tmp/repo", bin: "/opt/archify/bin.mjs" }, runner)).rejects.toThrow("Label overlaps component");
  });

  it("uses explicit zero timeouts and reports errors without diagnostics", async () => {
    const runner = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true }), stderr: "" }));
    await deliverArchify({ type: "architecture", input: "/tmp/spec.json", output: "/tmp/diagram.html", repoRoot: "/tmp/repo", bin: "/opt/archify/bin.mjs", timeoutMs: 0 }, runner);
    await visualCheckArchify({ artifact: "/tmp/diagram.html", bin: "/opt/archify/bin.mjs", timeoutMs: 0 }, runner);
    expect(runner).toHaveBeenNthCalledWith(1, process.execPath, expect.any(Array), expect.objectContaining({ timeout: 0 }));
    expect(runner).toHaveBeenNthCalledWith(2, process.execPath, expect.any(Array), expect.objectContaining({ timeout: 0 }));
    const failure = vi.fn(async () => ({ stdout: JSON.stringify({ ok: false, error: "Failed without diagnostics", diagnostics: [] }), stderr: "" }));
    await expect(visualCheckArchify({ artifact: "/tmp/diagram.html", bin: "/opt/archify/bin.mjs" }, failure)).rejects.toThrow("Failed without diagnostics");
  });

  it("preserves errors that do not carry a valid receipt", async () => {
    for (const failure of [
      new Error("plain"),
      "primitive",
      null,
      Object.assign(new Error("numeric stdout"), { stdout: 42 }),
      Object.assign(new Error("invalid json"), { stdout: "not-json" }),
      Object.assign(new Error("invalid receipt"), { stdout: JSON.stringify({ ok: "yes" }) }),
    ]) {
      const runner = vi.fn(async () => { throw failure; });
      await expect(visualCheckArchify({ artifact: "/tmp/diagram.html", bin: "/opt/archify/bin.mjs" }, runner)).rejects.toBe(failure);
    }
  });

  it("reads receipts from a non-zero CLI exit", async () => {
    const failure = Object.assign(new Error("exit 1"), { stdout: JSON.stringify({ ok: false, error: "Viewport overflow" }), stderr: "" });
    const runner = vi.fn(async () => { throw failure; });
    await expect(visualCheckArchify({ artifact: "/tmp/diagram.html", bin: "/opt/archify/bin.mjs" }, runner)).rejects.toThrow("Viewport overflow");
  });
});
