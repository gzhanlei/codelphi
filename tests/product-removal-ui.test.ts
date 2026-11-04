import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { deleteProduct } from "../lib/product-client";
import { handleProductRemoval, RemoveProductControl } from "../components/remove-product-button";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));

describe("product removal UI", () => {
  it("requests deletion and surfaces server errors", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "deleted" }), { status: 200 }));
    await expect(deleteProduct("namedict", fetcher)).resolves.toBe("deleted");
    expect(fetcher).toHaveBeenCalledWith("/api/products/namedict", { method: "DELETE" });
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: "当前产品正在分析，请完成后再移除" }), { status: 409 }));
    await expect(deleteProduct("namedict", fetcher)).rejects.toThrow("当前产品正在分析，请完成后再移除");
    fetcher.mockResolvedValue(new Response(JSON.stringify({ status: "unexpected" }), { status: 200 }));
    await expect(deleteProduct("namedict", fetcher)).rejects.toThrow("移除产品失败");
    fetcher.mockResolvedValue(new Response(JSON.stringify({ status: "unexpected", error: "" }), { status: 200 }));
    await expect(deleteProduct("namedict", fetcher)).rejects.toMatchObject({ message: "" });
    fetcher.mockResolvedValue(new Response(JSON.stringify({ status: "deleted", error: "HTTP 异常" }), { status: 500 }));
    await expect(deleteProduct("namedict", fetcher)).rejects.toThrow("HTTP 异常");
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: "" }), { status: 400 }));
    await expect(deleteProduct("namedict", fetcher)).rejects.toMatchObject({ message: "" });
  });

  it("navigates only after confirmed removal succeeds", async () => {
    const setPending = vi.fn();
    const setError = vi.fn();
    const onRemoved = vi.fn();
    await handleProductRemoval("namedict", { setPending, setError, onRemoved }, vi.fn(async () => "deleted" as const));
    expect(setPending.mock.calls.map(([value]) => value)).toEqual([true, false]);
    expect(setError).toHaveBeenCalledWith("");
    expect(onRemoved).toHaveBeenCalledOnce();

    onRemoved.mockClear();
    await handleProductRemoval("namedict", { setPending, setError, onRemoved }, vi.fn(async () => { throw new Error("无法移除"); }));
    expect(setError).toHaveBeenLastCalledWith("无法移除");
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("renders a two-step warning that preserves GitHub resources", () => {
    const initial = renderToStaticMarkup(createElement(RemoveProductControl, { name: "NameDict", confirming: false, pending: false, error: "", onStart: vi.fn(), onCancel: vi.fn(), onConfirm: vi.fn() }));
    expect(initial).toContain("移除产品");
    expect(initial).not.toContain("确认移除");
    const confirmation = renderToStaticMarkup(createElement(RemoveProductControl, { name: "NameDict", confirming: true, pending: false, error: "无法移除", onStart: vi.fn(), onCancel: vi.fn(), onConfirm: vi.fn() }));
    expect(confirmation).toContain("移除 NameDict？");
    expect(confirmation).toContain("GitHub 仓库和连接会保留");
    expect(confirmation).toContain("确认移除");
    expect(confirmation).toContain("取消");
    expect(confirmation).toContain("无法移除");
    const pending = renderToStaticMarkup(createElement(RemoveProductControl, { name: "NameDict", confirming: true, pending: true, error: "", onStart: vi.fn(), onCancel: vi.fn(), onConfirm: vi.fn() }));
    expect(pending).toContain("移除中…");
  });
});
