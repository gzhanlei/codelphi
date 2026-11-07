import { describe, expect, it } from "vitest";
import { evidenceUrl } from "../lib/evidence-url";

const repo = { owner: "gzhanlei", name: "codelphi" };
const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

describe("evidenceUrl", () => {
  it("builds a blob URL with a single-line anchor", () => {
    expect(evidenceUrl(repo, sha, { path: "lib/analysis.ts", startLine: 24 })).toBe(
      `https://github.com/gzhanlei/codelphi/blob/${sha}/lib/analysis.ts#L24`,
    );
  });

  it("builds a line-range anchor when endLine follows startLine", () => {
    expect(evidenceUrl(repo, sha, { path: "lib/analysis.ts", startLine: 24, endLine: 35 })).toBe(
      `https://github.com/gzhanlei/codelphi/blob/${sha}/lib/analysis.ts#L24-L35`,
    );
  });

  it("omits the anchor without line numbers and reverses ignored ranges", () => {
    expect(evidenceUrl(repo, sha, { path: "README.md" })).toBe(`https://github.com/gzhanlei/codelphi/blob/${sha}/README.md`);
    expect(evidenceUrl(repo, sha, { path: "README.md", startLine: 9, endLine: 2 })).toBe(
      `https://github.com/gzhanlei/codelphi/blob/${sha}/README.md#L9`,
    );
  });

  it("encodes path segments but keeps slashes", () => {
    expect(evidenceUrl(repo, sha, { path: "docs/a b.md" })).toBe(`https://github.com/gzhanlei/codelphi/blob/${sha}/docs/a%20b.md`);
  });

  it("returns null for invalid paths and revisions", () => {
    expect(evidenceUrl(repo, sha, { path: "" })).toBeNull();
    expect(evidenceUrl(repo, sha, { path: "../secrets" })).toBeNull();
    expect(evidenceUrl(repo, sha, { path: "a/../../etc" })).toBeNull();
    expect(evidenceUrl(repo, sha, { path: "/absolute" })).toBeNull();
    expect(evidenceUrl(repo, sha, { path: "lib\\win.ts" })).toBeNull();
    expect(evidenceUrl(repo, "", { path: "lib/analysis.ts" })).toBeNull();
    expect(evidenceUrl(repo, "not-a-sha", { path: "lib/analysis.ts" })).toBeNull();
    expect(evidenceUrl(repo, `${sha}extra`, { path: "lib/analysis.ts" })).toBeNull();
  });
});
