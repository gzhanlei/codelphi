import { describe, expect, it } from "vitest";
import { exclusionsText } from "../lib/client-publish/exclusions-text";

describe("telling the person publishing what was left out", () => {
  it("says nothing when the planner excluded nothing", () => {
    expect(exclusionsText([])).toBeNull();
  });

  it("names the directories, the tooling directories and the generators, and counts files", () => {
    expect(exclusionsText([
      { kind: "vendored", count: 2, subjects: ["jni/libopus", "vendor/openssl"] },
      { kind: "tooling", count: 48, subjects: ["scripts", "server/scripts"] },
      { kind: "duplicate", count: 3, subjects: ["lib/a.ts", "lib/b.ts", "lib/c.ts"] },
      { kind: "generated", count: 51, subjects: ["sqlc"] },
    ])).toEqual({
      zh: "不进分析：第三方代码的副本 2 个目录（jni/libopus, vendor/openssl）；开发工具目录里的文件 48 个（scripts, server/scripts）；内容重复的文件 3 个；生成的代码 51 个（sqlc）。",
      en: "Left out of the analysis: 2 directories holding a copy of someone else's project (jni/libopus, vendor/openssl); 48 development tooling files (scripts, server/scripts); 3 duplicate files; 51 generated files (sqlc).",
    });
  });

  it("names all five when there are exactly five", () => {
    expect(exclusionsText([{ kind: "vendored", count: 5, subjects: ["a", "b", "c", "d", "e"] }])?.zh).toBe("不进分析：第三方代码的副本 5 个目录（a, b, c, d, e）。");
  });

  it("lists at most five and sums up the rest", () => {
    const text = exclusionsText([{ kind: "tooling", count: 9, subjects: ["a", "b", "c", "d", "e", "f", "g"] }]);
    expect(text?.zh).toBe("不进分析：开发工具目录里的文件 9 个（a, b, c, d, e …）。");
    expect(text?.en).toBe("Left out of the analysis: 9 development tooling files (a, b, c, d, e ...).");
  });
});
