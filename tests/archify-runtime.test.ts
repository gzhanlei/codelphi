import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archifyRoot, prepareArchify, readArchifyRelease, verifyArchifyArchive } from "../lib/archify-runtime";

function fixture(license = "MIT") {
  const root = mkdtempSync(join(tmpdir(), "radar-archify-"));
  const archive = join(root, "archify-v3.2.0.zip");
  writeFileSync(archive, "pinned archive");
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(join(root, "release.json"), JSON.stringify({ version: "3.2.0", license, archive: "archify-v3.2.0.zip", sha256, source: "https://example.com/archify.zip", licenseSource: "https://example.com/LICENSE" }));
  return { root, archive, sha256 };
}

describe("Archify runtime", () => {
  it("reads the pinned MIT release and verifies archive bytes", () => {
    const { root, archive, sha256 } = fixture();
    expect(readArchifyRelease(root)).toMatchObject({ version: "3.2.0", license: "MIT", sha256 });
    expect(verifyArchifyArchive(root)).toBe(archive);
  });

  it("rejects archive drift and non-MIT metadata", () => {
    const drifted = fixture();
    writeFileSync(drifted.archive, "changed");
    expect(() => verifyArchifyArchive(drifted.root)).toThrow("SHA-256 mismatch");
    const apache = fixture("Apache-2.0");
    expect(() => readArchifyRelease(apache.root)).toThrow("MIT");
  });

  it("extracts once and reuses the prepared runtime", async () => {
    const { root } = fixture();
    const runner = vi.fn(async (_file: string, _args: string[]) => {
      mkdirSync(join(root, "runtime", "archify", "bin"), { recursive: true });
      writeFileSync(join(root, "runtime", "archify", "bin", "archify.mjs"), "cli");
      return { stdout: "", stderr: "" };
    });
    const bin = await prepareArchify(root, runner);
    expect(bin).toBe(join(root, "runtime", "archify", "bin", "archify.mjs"));
    expect(runner).toHaveBeenCalledWith("unzip", ["-q", join(root, "archify-v3.2.0.zip"), "-d", join(root, "runtime")], expect.objectContaining({ shell: false }));
    expect(await prepareArchify(root, runner)).toBe(bin);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("rejects archive drift even when a runtime was already prepared", async () => {
    const { root, archive, sha256 } = fixture();
    const bin = join(root, "runtime", "archify", "bin", "archify.mjs");
    mkdirSync(join(root, "runtime", "archify", "bin"), { recursive: true });
    writeFileSync(bin, "cli");
    writeFileSync(join(root, "runtime", ".archify-sha256"), sha256);
    writeFileSync(archive, "tampered");
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(prepareArchify(root, runner)).rejects.toThrow("SHA-256 mismatch");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rebuilds when the marker exists without a usable binary and removes stale files", async () => {
    const { root, sha256 } = fixture();
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(join(root, "runtime", ".archify-sha256"), sha256);
    writeFileSync(join(root, "runtime", "stale.txt"), "old");
    const runner = vi.fn(async () => {
      mkdirSync(join(root, "runtime", "archify", "bin"), { recursive: true });
      writeFileSync(join(root, "runtime", "archify", "bin", "archify.mjs"), "cli");
      return { stdout: "", stderr: "" };
    });
    await prepareArchify(root, runner);
    expect(runner).toHaveBeenCalledOnce();
    expect(existsSync(join(root, "runtime", "stale.txt"))).toBe(false);
  });

  it("fails when extraction does not provide the CLI binary", async () => {
    const { root } = fixture();
    await expect(prepareArchify(root, async () => ({ stdout: "", stderr: "" }))).rejects.toThrow("missing bin/archify.mjs");
  });

  it("resolves the runtime root from CODELPHI_HOME with ARCHIFY_HOME as the legacy fallback", () => {
    const previousHome = process.env.CODELPHI_HOME;
    const previousLegacy = process.env.ARCHIFY_HOME;
    try {
      delete process.env.CODELPHI_HOME;
      delete process.env.ARCHIFY_HOME;
      expect(archifyRoot()).toBe(join(process.cwd(), "vendor", "archify"));
      process.env.ARCHIFY_HOME = "/legacy/archify-home";
      expect(archifyRoot()).toBe("/legacy/archify-home");
      process.env.CODELPHI_HOME = "/new/codelphi-home";
      expect(archifyRoot()).toBe("/new/codelphi-home");
    } finally {
      if (previousHome === undefined) delete process.env.CODELPHI_HOME;else process.env.CODELPHI_HOME = previousHome;
      if (previousLegacy === undefined) delete process.env.ARCHIFY_HOME;else process.env.ARCHIFY_HOME = previousLegacy;
    }
  });
});
