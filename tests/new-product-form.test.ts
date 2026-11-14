import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { handleProductCreation, NewProductForm } from "../components/new-product-form";
import { productInputSchema } from "../lib/product-input";

const { push, refresh, createProductMock, useStateMock, stateSetters } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), createProductMock: vi.fn(), useStateMock: vi.fn(), stateSetters: [] as Array<ReturnType<typeof vi.fn>> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useState: useStateMock.mockImplementation((initial) => { const setter = vi.fn(); stateSetters.push(setter); return [initial, setter]; }) }));
vi.mock("../lib/product-client", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/product-client")>(), createProduct: createProductMock }));

const input = productInputSchema.parse({ name: "New Product", slug: "new-product", description: "", repository: "owner/repo", defaultBranch: "", analyze: true });

describe("new product submission", () => {
  it("returns to the product list only after registration succeeds", async () => {
    const setPending = vi.fn();
    const setError = vi.fn();
    const onCreated = vi.fn();
    await handleProductCreation(input, { setPending, setError, onCreated }, vi.fn(async () => "new-product"));
    expect(onCreated).toHaveBeenCalledOnce();
    expect(setPending).toHaveBeenCalledWith(true);
    expect(setPending).not.toHaveBeenCalledWith(false);
    expect(setError).toHaveBeenCalledWith("");
  });

  it("redirects the real form submission to the product list", async () => {
    createProductMock.mockResolvedValue("new-product");
    const form = NewProductForm({ connections: [], hasServerToken: false, defaultOutputLanguage: "en" }) as React.ReactElement<{ onSubmit: (event: { preventDefault: () => void }) => Promise<void> }>;
    await form.props.onSubmit({ preventDefault: vi.fn() });
    expect(createProductMock).toHaveBeenCalledOnce();
    expect(createProductMock.mock.calls[0][0]).toMatchObject({ outputLanguage: "en" });
    expect(push).toHaveBeenCalledWith("/");
    expect(push).not.toHaveBeenCalledWith(expect.stringContaining("/products/"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("initializes analysis and pending states and records manual slug edits", () => {
    useStateMock.mockClear();
    stateSetters.length = 0;
    const form = NewProductForm({ connections: [], hasServerToken: false, defaultOutputLanguage: "en" }) as React.ReactElement<{ onSubmit: (event: { preventDefault: () => void }) => Promise<void>; children: React.ReactElement[] }>;
    expect(useStateMock.mock.calls.map(([value]) => value)).toEqual(["", "", false, "", "", "", true, false, "", null, "en"]);
    const information = form.props.children[0] as React.ReactElement<{ onSlugChange: (value: string) => void; onOutputLanguageChange: (value: string) => void }>;
    information.props.onSlugChange("custom-slug");
    expect(stateSetters[1]).toHaveBeenCalledWith("custom-slug");
    expect(stateSetters[2]).toHaveBeenCalledWith(true);
    information.props.onOutputLanguageChange("zh-CN");
    expect(stateSetters[10]).toHaveBeenCalledWith("zh-CN");
  });

  it("renders the output language selector with both options and the workspace default preselected", () => {
    const html = renderToStaticMarkup(createElement(NewProductForm, { connections: [], hasServerToken: false, defaultOutputLanguage: "en" }));
    expect(html).toContain("输出语言");
    expect(html).toContain('value="zh-CN"');
    expect(html).toContain('value="en"');
    expect(html).toContain("English");
  });

  it("stays on the form and restores submission after a registration failure", async () => {
    const setPending = vi.fn();
    const setError = vi.fn();
    const onCreated = vi.fn();
    await handleProductCreation(input, { setPending, setError, onCreated }, vi.fn(async () => { throw new Error("仓库不可访问"); }));
    expect(onCreated).not.toHaveBeenCalled();
    expect(setError).toHaveBeenLastCalledWith("仓库不可访问");
    expect(setPending.mock.calls.map(([value]) => value)).toEqual([true, false]);
  });
});
