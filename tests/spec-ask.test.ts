import { describe, expect, it, vi } from "vitest";
import { answerSpecQuestion } from "../lib/spec-ask";
import type { Execute } from "../lib/db";
import type { SpecSearchResult } from "../lib/spec-search";

/** 一个真实形状的规格切片：回答必须是这里的原文，不允许改写。 */
const FIXTURE: SpecSearchResult = {
  features: [
    { id: 1, name: "文件上传", summary: "上传附件，限制数量与大小" },
    { id: 2, name: "统一登录", summary: "OAuth 登录与会话" },
    { id: 3, name: "通知分发", summary: "Slack 与邮件通知" },
  ],
  scenarios: [
    { id: 11, featureId: 1, featureName: "文件上传", reference: "HP-1", context: "用户在上传框选择附件", action: "一次选择不超过 10 个文件", outcome: "系统接受并进入上传队列" },
    { id: 12, featureId: 1, featureName: "文件上传", reference: "EC-1", context: "单个文件超过 20MB", action: "继续上传", outcome: "系统拒绝并提示文件过大" },
    { id: 21, featureId: 2, featureName: "统一登录", reference: "ER-1", context: "OAuth 回调失败", action: "重试登录", outcome: "显示错误信息并停留登录页" },
    { id: 31, featureId: 3, featureName: "通知分发", reference: "HP-1", context: "分析完成且存在行为变化", action: "触发通知", outcome: "Slack 与邮件各发送一次" },
  ],
};

/** 模拟 MySQL LIKE：按参数里的检索词过滤，行为与 lib/spec-search.ts 的 SQL 一致。 */
const execute: Execute = async (statement, parameters) => {
  const pattern = String(parameters[1] ?? "");
  const term = pattern.slice(1, -1).replace(/\\(.)/g, "$1");
  const sql = String(statement);
  if (sql.includes("FROM features f")) {
    return [FIXTURE.features.filter((feature) => `${feature.name}${feature.summary}`.includes(term))];
  }
  if (sql.includes("FROM scenarios s")) {
    return [FIXTURE.scenarios.filter((scenario) => `${scenario.reference}${scenario.featureName}${scenario.context}${scenario.action}${scenario.outcome}`.includes(term))];
  }
  return [[]];
};

describe("ask spec (B2.1 retrieval-style answers)", () => {
  it("answers a natural-language question with the spec's own wording", async () => {
    const answer = await answerSpecQuestion(3, "上传文件最多几个？单个文件最大多大？", execute);
    expect(answer.status).toBe("matched");
    expect(answer.scenarios.map((scenario) => scenario.reference)).toContain("HP-1");
    expect(answer.scenarios.some((scenario) => scenario.outcome === "系统接受并进入上传队列")).toBe(true);
    expect(answer.notice).toContain("规格原文");
  });

  it("says the spec does not cover a question instead of guessing", async () => {
    const answer = await answerSpecQuestion(3, "怎么配置 SSO 单点登录？", execute);
    expect(answer.status).toBe("uncovered");
    expect(answer.features).toEqual([]);
    expect(answer.scenarios).toEqual([]);
    expect(answer.notice).toContain("未覆盖");
  });

  it("does not touch the database for a blank question", async () => {
    const spy = vi.fn(execute);
    const answer = await answerSpecQuestion(3, "   ", spy);
    expect(spy).not.toHaveBeenCalled();
    expect(answer.status).toBe("uncovered");
  });
});
