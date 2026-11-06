import { describe, expect, it } from "vitest";
import { aggregateImplementationFiles } from "../lib/feature-implementation";

function scenario(reference: string, evidence: unknown) {
  return { id: 1, featureId: 1, reference, context: "c", action: "a", outcome: "o", category: "happy" as const, source: "generated" as const, evidence };
}

describe("aggregateImplementationFiles", () => {
  it("merges evidence from multiple scenarios by path with merged line spans", () => {
    const files = aggregateImplementationFiles([
      scenario("HP-1", [{ path: "lib/a.ts", startLine: 10, endLine: 20 }]),
      scenario("EC-1", [{ path: "lib/a.ts", startLine: 15, endLine: 25 }, { path: "lib/b.ts", startLine: 1 }]),
      scenario("ER-1", [{ path: "lib/a.ts", startLine: 30, endLine: 32 }]),
    ]);
    expect(files).toEqual([
      { path: "lib/a.ts", lines: 19, references: ["EC-1", "ER-1", "HP-1"], url: undefined },
      { path: "lib/b.ts", lines: 1, references: ["EC-1"], url: undefined },
    ]);
  });

  it("carries over the first decorated url and skips invalid evidence", () => {
    const files = aggregateImplementationFiles([
      scenario("HP-1", [{ path: "lib/a.ts", startLine: 3, url: "https://example.com/blob/a" }]),
      scenario("EC-1", [{ path: "", startLine: 1 }, "junk", { startLine: 2 }]),
    ]);
    expect(files).toEqual([{ path: "lib/a.ts", lines: 1, references: ["HP-1"], url: "https://example.com/blob/a" }]);
  });

  it("returns empty for scenarios without evidence", () => {
    expect(aggregateImplementationFiles([scenario("HP-1", []), scenario("HP-2", "not json")])).toEqual([]);
  });
});
