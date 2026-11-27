import { describe, expect, it } from "vitest";
import { mergeExclusions, summarizeExclusions } from "../lib/slice-planner/exclusions";
import type { SliceExclusion } from "../lib/slice-planner/types";

describe("exclusion records", () => {
  it("merges what every pass reports again and summarises by kind in a fixed order", () => {
    const merged = new Map<string, SliceExclusion>();
    mergeExclusions(merged, [
      // 遍历遇到的第三方目录：path 和 detail 都是目录；必选循环拦下的文件：detail 是目录。
      { kind: "vendored", path: "jni/libopus", detail: "jni/libopus", reason: "upstream_project" },
      { kind: "vendored", path: "jni/libopus/src/opus.c", detail: "jni/libopus" },
      { kind: "vendored", path: "vendor/x", detail: "vendor/x", reason: "foreign_license" },
    ]);
    mergeExclusions(merged, [
      { kind: "vendored", path: "jni/libopus", detail: "jni/libopus", reason: "upstream_project" },
      { kind: "tooling", path: "scripts/migrate.ts", detail: "scripts" },
      { kind: "tooling", path: "scripts/seed.ts", detail: "scripts" },
      { kind: "tooling", path: "apps/web/scripts/dev.ts", detail: "apps/web/scripts" },
      { kind: "generated", path: "api/user.ts", detail: "protoc" },
      { kind: "generated", path: "db/orders.sql.go", detail: "sqlc" },
      { kind: "generated", path: "db/users.sql.go", detail: "sqlc" },
      { kind: "duplicate", path: "lib/copy.ts", detail: "lib/a.ts" },
    ]);
    mergeExclusions(merged, undefined);
    expect([...merged.keys()]).toHaveLength(10);
    // 第三方副本按目录数，其余按文件数；列出的是目录、保留下来的那份、生成工具。
    expect(summarizeExclusions([...merged.values()])).toEqual([
      { kind: "vendored", count: 2, subjects: ["jni/libopus", "vendor/x"] },
      { kind: "tooling", count: 3, subjects: ["apps/web/scripts", "scripts"] },
      { kind: "duplicate", count: 1, subjects: ["lib/a.ts"] },
      { kind: "generated", count: 3, subjects: ["protoc", "sqlc"] },
    ]);
    expect(summarizeExclusions([])).toEqual([]);
  });
});
