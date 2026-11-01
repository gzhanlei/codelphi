import { describe, expect, it } from "vitest";
import { editorAction, routeEntityId } from "../lib/editor-route";
import { SpecEditorError, specEditorErrorInfo } from "../lib/spec-editor-service";

describe("editor routes", () => {
  it("accepts positive integer ids and rejects malformed ids", () => {
    expect(routeEntityId("1")).toBe(1);
    expect(routeEntityId("42")).toBe(42);
    expect(() => routeEntityId("abc")).toThrow("无效的资源 ID");
    expect(() => routeEntityId("0")).toThrow("无效的资源 ID");
    expect(() => routeEntityId("1.5")).toThrow("无效的资源 ID");
  });

  it("returns action results and maps malformed JSON to 400", async () => {
    const success = await editorAction(async () => ({ id: 1 }));
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ id: 1 });
    const created = await editorAction(async () => ({ id: 2 }), 201);
    expect(created.status).toBe(201);
    const malformed = await editorAction(async () => { throw new SyntaxError("Unexpected token"); });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "请求 JSON 无效" });
    const missing = await editorAction(async () => { throw new SpecEditorError(404, "不存在"); });
    expect(missing.status).toBe(404);
  });

  it("maps syntax errors at the service boundary", () => {
    expect(specEditorErrorInfo(new SyntaxError("bad json"))).toEqual({ status: 400, message: "请求 JSON 无效" });
  });
});
