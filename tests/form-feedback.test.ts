import { describe, expect, it } from "vitest";
import { submitLabel, analysisButtonLabel } from "../components/form-feedback";

describe("form feedback", () => {
  it("describes the current submission action", () => {
    expect(submitLabel(false, true)).toBe("添加并开始分析");
    expect(submitLabel(false, false)).toBe("添加产品");
    expect(submitLabel(true, true)).toBe("正在验证并添加…");
    expect(analysisButtonLabel(false)).toBe("立即分析");
    expect(analysisButtonLabel(true)).toBe("正在提交…");
  });
});
