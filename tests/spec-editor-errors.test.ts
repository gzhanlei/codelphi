import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { SpecEditorError, specEditorErrorInfo } from "../lib/spec-editor-service";

describe("spec editor errors", () => {
  it("maps domain, validation, duplicate and unexpected errors", () => {
    expect(specEditorErrorInfo(new SpecEditorError(404, "不存在"))).toEqual({ status: 404, message: "不存在" });
    expect(specEditorErrorInfo(new ZodError([]))).toEqual({ status: 400, message: "输入无效" });
    expect(specEditorErrorInfo(new ZodError([{ code: "custom", path: [], message: "第一条" }, { code: "custom", path: [], message: "第二条" }]))).toEqual({ status: 400, message: "第一条" });
    expect(specEditorErrorInfo(new ZodError([{ code: "custom", path: [], message: "" }]))).toEqual({ status: 400, message: "输入无效" });
    expect(specEditorErrorInfo(null)).toEqual({ status: 500, message: "保存失败，请重试" });
    expect(specEditorErrorInfo({ code: "OTHER" })).toEqual({ status: 500, message: "保存失败，请重试" });
    expect(specEditorErrorInfo({ code: "ER_DUP_ENTRY" })).toEqual({ status: 409, message: "功能或场景已经存在" });
    expect(specEditorErrorInfo(new Error("db down"))).toEqual({ status: 500, message: "保存失败，请重试" });
  });
});
