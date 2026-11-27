import { describe, expect, it, vi } from "vitest";
import { generateDraft } from "../lib/release-notes-client";

const respond = (status: number, body: unknown) => vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
const draft = { noteId: 5, status: "draft", shareToken: "tok", publicUrl: "https://codelphi.example/share/notes/tok" };

describe("generating a release-notes draft from the page", () => {
  it("posts the selection and reports whether the copy rewrite is on its way", async () => {
    expect(await generateDraft("salesbuddy", 9, [11], "", respond(200, { ...draft, copyRewrite: "scheduled" }))).toBe("generated");
    // 工作区没配模型时草稿照常生成，只是没有 AI 润色：页面要换一句话说。
    expect(await generateDraft("salesbuddy", 9, [11], "", respond(200, { ...draft, copyRewrite: "skipped" }))).toBe("generated_without_copy");
  });

  it("surfaces the server's reason", async () => {
    await expect(generateDraft("salesbuddy", 9, [11], "", respond(409, { error: "已发布只读：先下线才能重新生成" }))).rejects.toThrow("已发布只读");
    await expect(generateDraft("salesbuddy", 9, [11], "", respond(500, {}))).rejects.toThrow("生成发布稿失败");
  });
});
