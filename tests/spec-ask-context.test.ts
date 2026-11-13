import { describe, expect, it, vi } from "vitest";
import {
  decorateSpecAnswer,
  type DecoratedSpecAnswer,
  loadSpecAnswerContext,
  type SpecAnswer,
  type SpecAnswerContext,
} from "../lib/spec-ask";

const fakeExecute = (rows: Array<{ owner: string; name: string }>) =>
  vi.fn(async () => [rows, undefined] as unknown as [unknown, unknown]);

describe("loadSpecAnswerContext", () => {
  it("returns the spec version, repo and sha when all are present", async () => {
    const loadVerification = vi.fn(async () => ({ specVersionId: 7, sha: "abc1234" }));
    const execute = fakeExecute([{ owner: "acme", name: "radar" }]);
    const ctx = await loadSpecAnswerContext(3, execute, loadVerification);
    expect(ctx).toEqual({ specVersionId: 7, repo: { owner: "acme", name: "radar" }, sha: "abc1234" });
  });

  it("falls back to null ids when no verification spec exists", async () => {
    const loadVerification = vi.fn(async () => null);
    const execute = fakeExecute([{ owner: "acme", name: "radar" }]);
    const ctx = await loadSpecAnswerContext(3, execute, loadVerification);
    expect(ctx.specVersionId).toBeNull();
    expect(ctx.sha).toBeNull();
    expect(ctx.repo).toEqual({ owner: "acme", name: "radar" });
  });

  it("falls back to a null repo when no repository row exists", async () => {
    const loadVerification = vi.fn(async () => ({ specVersionId: 7, sha: "abc1234" }));
    const execute = fakeExecute([]);
    const ctx = await loadSpecAnswerContext(3, execute, loadVerification);
    expect(ctx.repo).toBeNull();
    expect(ctx.specVersionId).toBe(7);
  });
});

describe("decorateSpecAnswer", () => {
  const matched: SpecAnswer = {
    status: "matched",
    question: "上传文件最多几个？",
    terms: ["上传"],
    features: [{ id: 1, name: "文件上传", summary: "上传附件，限制数量与大小", stableKey: "文件上传" }],
    scenarios: [{
      id: 11, featureId: 1, featureName: "文件上传", featureStableKey: "文件上传", reference: "HP-1",
      context: "用户在上传框选择附件", action: "一次选择不超过 10 个文件", outcome: "系统接受并进入上传队列",
      evidence: [{ path: "src/upload.ts", startLine: 42 }],
    }],
    notice: "以下为规格原文摘录，非 AI 生成；点击条目可查看完整功能与代码证据。",
  };
  const uncovered: SpecAnswer = {
    status: "uncovered", question: "怎么配置 SSO？", terms: ["SSO"],
    features: [], scenarios: [],
    notice: "当前规格未覆盖此问题，未覆盖部分不产生结论。可换用更贴近功能名称的词，或前往规格页查看。",
  };
  const ctx: SpecAnswerContext = { specVersionId: 7, repo: { owner: "acme", name: "radar" }, sha: "abc1234" };

  it("adds the spec version id to an uncovered answer without touching results", () => {
    const decorated = decorateSpecAnswer(uncovered, ctx);
    expect(decorated.specVersionId).toBe(7);
    expect(decorated.status).toBe("uncovered");
  });

  it("links evidence to the source blob for a matched answer", () => {
    const decorated = decorateSpecAnswer(matched, ctx) as DecoratedSpecAnswer;
    expect(decorated.scenarios[0].evidence[0].url).toBe("https://github.com/acme/radar/blob/abc1234/src/upload.ts#L42");
  });

  it("leaves evidence untouched when repo or sha is missing", () => {
    const decorated = decorateSpecAnswer(matched, { specVersionId: 7, repo: null, sha: null }) as DecoratedSpecAnswer;
    expect(decorated.scenarios[0].evidence[0].url).toBeUndefined();
  });

  it("keeps an AI-supplied evidence url instead of overwriting it", () => {
    const withUrl: SpecAnswer = {
      ...matched,
      scenarios: [{ ...matched.scenarios[0], evidence: [{ path: "src/upload.ts", startLine: 42, url: "https://ai.example/blob/x.ts#L1" }] }],
    };
    const decorated = decorateSpecAnswer(withUrl, ctx) as DecoratedSpecAnswer;
    expect(decorated.scenarios[0].evidence[0].url).toBe("https://ai.example/blob/x.ts#L1");
  });
});
