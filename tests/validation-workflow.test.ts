import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runValidationWorkflow, executionWorkingDirectory } from "../lib/validation-impact/workflow";

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "validation-workflow-"));
  await mkdir(join(root, "ios", "Tests"), { recursive: true });
  await writeFile(join(root, "ios", "Tests", "README.md"), [
    "```bash",
    "SRC=Tingfeng",
    "swiftc $SRC/DSP/A.swift Tests/a/main.swift -o /tmp/t1 && /tmp/t1",
    "swiftc $SRC/DSP/B.swift Tests/b/main.swift -o /tmp/t2 && /tmp/t2",
    "swiftc $SRC/DSP/C.swift Tests/c/main.swift -o /tmp/t3 && /tmp/t3",
    "```",
  ].join("\n"));
  return root;
}

describe("validation workflow", () => {
  it("deduplicates multiple targets and reports unexpected failures", async () => {
    const root = await repo();
    const result = await runValidationWorkflow(root, [
      { path: "ios/Tingfeng/DSP/A.swift", requires: ["ios/Tingfeng/DSP/B.swift"] },
      { path: "ios/Tingfeng/DSP/B.swift", requires: ["ios/Tingfeng/DSP/D.swift"] },
    ], {
      execute: async ({ id }) => ({ returnCode: id === "b" ? 1 : 0, output: id === "b" ? "error: failed" : "PASS" }),
    });
    expect(result.predicted).toEqual(["a", "b"]);
    expect(result.actual.filter((item) => item.failed).map((item) => item.id)).toEqual(["b"]);
    expect(result.missingPredictions).toEqual([]);
    expect(result.falsePositives).toEqual([]);
  });

  it("computes false positives only when failure is expected", async () => {
    const root = await repo();
    const result = await runValidationWorkflow(root, [
      { path: "ios/Tingfeng/DSP/A.swift", requires: ["ios/Tingfeng/DSP/B.swift"] },
    ], {
      expectFailures: true,
      execute: async () => ({ returnCode: 0, output: "PASS" }),
    });
    expect(result.falsePositives).toEqual(["a"]);
    expect(result.missingPredictions).toEqual([]);
  });
});


describe("validation execution working directory", () => {
  it("runs Swift commands from ios and Vitest from the web root", () => {
    expect(executionWorkingDirectory("swiftc_readme", "/repo")).toBe("/repo/ios");
    expect(executionWorkingDirectory("typescript_relative_imports", "/repo/web")).toBe("/repo/web");
  });
});
