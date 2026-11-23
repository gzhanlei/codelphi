import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractLegacyGuardAnchors,
  type GuardAnchor,
} from "../lib/legacy-analysis/guard-anchors";

function anchors(content: string, path = "fixture.ts"): GuardAnchor[] {
  return extractLegacyGuardAnchors({ path, content });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("legacy guard anchors", () => {
  it("extracts a CB-18 style if/throw guard with raw condition, throw text and real lines", () => {
    const source = [
      "export async function runAnalysis(run: { id: string }, latestRunId: string) {",
      "  if (latestRunId !== run.id) throw new Error(\"Analysis superseded\");",
      "  return run;",
      "}",
    ].join("\n");
    const extracted = anchors(source);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toEqual({
      kind: "GUARD",
      path: "fixture.ts",
      symbol: "runAnalysis",
      condition: "latestRunId !== run.id",
      outcome: "throw new Error(\"Analysis superseded\")",
      extraction: "complete",
      evidence: { path: "fixture.ts", startLine: 2, endLine: 2 },
    });
  });

  it("ignores return-error guards and positive activation conditions", () => {
    expect(anchors([
      "export function guard(user: unknown) {",
      "  if (!isAuthorized(user)) return forbidden();",
      "}",
    ].join("\n"))).toEqual([]);
    expect(anchors([
      "export async function promote(run: unknown) {",
      "  if (isLatestRun(run)) await activate(run);",
      "}",
    ].join("\n"))).toEqual([]);
  });

  it("records cross-file guard conditions as raw expression text without interpreting them", () => {
    const source = [
      "import { isLatestRun } from \"./runs\";",
      "export async function activate(run: unknown) {",
      "  if (!isLatestRun(run)) throw new Error(\"Stale run\");",
      "}",
    ].join("\n");
    const extracted = anchors(source);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({
      kind: "GUARD",
      symbol: "activate",
      condition: "!isLatestRun(run)",
      outcome: "throw new Error(\"Stale run\")",
      extraction: "complete",
    });
    expect(Object.keys(extracted[0]!)).not.toContain("resolution");
  });

  it("marks guards inside anonymous functions as partial", () => {
    const source = [
      "export function start(stopped: boolean) {",
      "  setInterval(() => {",
      "    if (stopped) throw new Error(\"Worker stopped\");",
      "  }, 1000);",
      "}",
    ].join("\n");
    const extracted = anchors(source);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({
      kind: "GUARD",
      symbol: "<anonymous>",
      condition: "stopped",
      extraction: "partial",
      evidence: { path: "fixture.ts", startLine: 3, endLine: 3 },
    });
  });

  it("returns no anchors and records syntax errors for the whole file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(anchors("export function broken( {")).toEqual([]);
    expect(warn).toHaveBeenCalledWith("[legacy-guard-anchors] file skipped", expect.objectContaining({ path: "fixture.ts", reason: "syntax_error" }));
  });

  it("returns no anchors and records files over one million UTF-8 bytes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(anchors("a".repeat(1_000_001))).toEqual([]);
    expect(warn).toHaveBeenCalledWith("[legacy-guard-anchors] file skipped", expect.objectContaining({ path: "fixture.ts", reason: "file_too_large" }));
  });
});
