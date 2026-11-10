import { describe, expect, it } from "vitest";
import { detectOutcomeConflicts } from "../lib/spec-consistency";

const scenario = (reference: string, outcome: string) => ({ reference, outcome });

describe("detectOutcomeConflicts", () => {
  it("flags negated vs affirmative statements of the same error token in one feature (L12 实测)", () => {
    const conflicts = detectOutcomeConflicts([
      {
        name: "数据库连接配置",
        scenarios: [
          scenario("HP-2", "连接创建成功，不再因 MissingOAuth2TokenError 或 OAuth2RedirectError 返回 422；权限在首次配置访问时同步。"),
          scenario("ER-2", "创建 OAuth2 数据库连接但缺失 token → 提交创建 → 返回 MissingOAuth2TokenError"),
        ],
      },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].token).toBe("MissingOAuth2TokenError");
    expect(conflicts[0].negated.reference).toBe("HP-2");
    expect(conflicts[0].affirmative.reference).toBe("ER-2");
  });

  it("requires tight adjacency for negation (否定别的动作不算否定 token)", () => {
    const conflicts = detectOutcomeConflicts([
      {
        name: "SQL Lab",
        scenarios: [
          scenario("HP-1", "查询超时 → 返回 504 与超时错误信息"),
          scenario("ER-1", "上游不可用 → 不再重试，直接返回 504"),
        ],
      },
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("does not flag when the same token appears only negated or only affirmative", () => {
    const conflicts = detectOutcomeConflicts([
      {
        name: "缓存层",
        scenarios: [
          scenario("HP-1", "查询超时 → 返回 504 与超时错误信息"),
          scenario("ER-1", "上游不可用 → 不再重试，直接返回 504"),
        ],
      },
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("does not cross features: same contradiction in different features is not a conflict", () => {
    const conflicts = detectOutcomeConflicts([
      { name: "A", scenarios: [scenario("HP-1", "不再抛出 ValidationError")] },
      { name: "B", scenarios: [scenario("HP-1", "抛出 ValidationError")] },
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("returns empty for specs without error tokens", () => {
    expect(detectOutcomeConflicts([{ name: "A", scenarios: [scenario("HP-1", "写入成功")] }])).toEqual([]);
  });
});
