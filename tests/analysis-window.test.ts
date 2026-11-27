import { describe, expect, it } from "vitest";
import { analysisWindow } from "../lib/analysis-window";
import type { ChangeContext } from "../lib/code-hosting";

const change: ChangeContext = {
  message: "feat: gift wallet",
  committedAt: "2026-11-01T00:00:00Z",
  url: "",
  files: [
    { path: "scripts/deploy.sh", status: "modified", patch: "+ echo deploy" },
    { path: "lib/auth.ts", status: "modified", patch: "+ const token = sign(payload);" },
    { path: "lib/db/orders.sql.go", status: "modified", patch: "+type Order struct{}" },
  ],
} as unknown as ChangeContext;

describe("the analysis window after the planner's exclusions", () => {
  it("takes the planner's files out of the changed files, the behavioural paths and the unassigned paths", () => {
    const window = analysisWindow({
      change,
      behavioralPaths: ["lib/auth.ts", "lib/db/orders.sql.go", "scripts/deploy.sh"],
      unassignedBehavioralPaths: ["lib/db/orders.sql.go", "scripts/deploy.sh"],
      excludedPaths: new Set(["scripts/deploy.sh", "lib/db/orders.sql.go", "scripts/seed.ts"]),
    });
    expect(window.change.files.map((file) => file.path)).toEqual(["lib/auth.ts"]);
    expect(window.change.message).toBe("feat: gift wallet");
    expect(window.behavioralPaths).toEqual(["lib/auth.ts"]);
    expect(window.unassignedBehavioralPaths).toEqual([]);
    // 原来的变更上下文没被改动。
    expect(change.files).toHaveLength(3);
  });

  it("leaves the unassigned paths undefined when there were none", () => {
    const window = analysisWindow({ change, behavioralPaths: ["lib/auth.ts"], unassignedBehavioralPaths: undefined, excludedPaths: new Set(["scripts/deploy.sh"]) });
    expect(window.unassignedBehavioralPaths).toBeUndefined();
  });

  it("changes nothing when the planner excluded nothing", () => {
    const window = analysisWindow({ change, behavioralPaths: ["lib/auth.ts"], unassignedBehavioralPaths: undefined, excludedPaths: new Set() });
    expect(window.change).toBe(change);
    expect(window.behavioralPaths).toEqual(["lib/auth.ts"]);
    expect(window.unassignedBehavioralPaths).toBeUndefined();
  });
});
