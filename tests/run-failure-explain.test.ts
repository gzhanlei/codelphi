import { describe, expect, it } from "vitest";
import { explainRunFailure, runFailureSignature } from "../lib/run-failure-explain";

describe("run failure explanation (页面人话 + GitHub 上报分类)", () => {
  it("maps run-289 zod shape drift to ai_output_format with an actionable message", () => {
    const run289 = [
      '[\n  {\n    "expected": "array",\n    "code": "invalid_type",\n    "path": [\n      "features"',
      '    ],\n    "message": "Invalid input: expected array, received undefined"\n  }\n]',
    ].join("\n");
    const explanation = explainRunFailure(run289);
    expect(explanation.technicalClass).toBe("ai_output_format");
    expect(explanation.reportable).toBe(true);
    expect(explanation.userMessage).toContain("AI 返回的数据结构");
    expect(explanation.userMessage).not.toContain("invalid_type");
  });

  it("classifies broken-JSON, db-schema, credential, timeout and network failures", () => {
    expect(explainRunFailure("AI response did not contain a JSON object").technicalClass).toBe("ai_output_format");
    expect(explainRunFailure("Unknown column 'step_order' in 'field list'\n    at i (/data/www/…)").technicalClass).toBe("db_schema");
    expect(explainRunFailure("Access denied for user 'radar'@'172.19.32.3' (using password: YES)").technicalClass).toBe("credential");
    expect(explainRunFailure("TimeoutError: The operation was aborted due to timeout").technicalClass).toBe("timeout");
    expect(explainRunFailure("fetch failed\n    at async Promise.all (index 1)").technicalClass).toBe("network");
  });

  it("marks superseded runs as not reportable and keeps technical jargon off the page", () => {
    const explanation = explainRunFailure("Analysis superseded by run 290");
    expect(explanation.technicalClass).toBe("superseded");
    expect(explanation.reportable).toBe(false);
    expect(explanation.userMessage).toContain("被更新的分析取代");
    expect(explanation.userMessage).not.toContain("run 290");
  });

  it("falls back to a generic reportable message for unknown errors", () => {
    const explanation = explainRunFailure("TypeError: x is not a function\n    at …");
    expect(explanation.technicalClass).toBe("unknown");
    expect(explanation.reportable).toBe(true);
    expect(explanation.userMessage).toContain("意外错误");
  });

  it("builds a stable dedup signature from the first zod issue path+code", () => {
    const run289 = '[\n  {\n    "expected": "array",\n    "code": "invalid_type",\n    "path": [\n      "features"\n    ],\n    "message": "Invalid input: expected array, received undefined"\n  }\n]';
    expect(runFailureSignature(run289)).toBe("ai_output_format: features/invalid_type");
    expect(runFailureSignature("Unknown column 'step_order' in 'field list'\n    at i")).toBe("db_schema: Unknown column 'step_order' in 'field list'");
  });

  it("caps non-zod signature detail at 120 chars", () => {
    const long = "x".repeat(300);
    expect(runFailureSignature(long).length).toBeLessThanOrEqual("unknown: ".length + 120);
  });
});
