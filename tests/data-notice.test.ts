import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("@/lib/ui-locale-server", () => ({ resolveUiLocale: vi.fn() }));

const { default: DataNoticePage } = await import("../app/data-notice/page");
const { resolveUiLocale } = await import("@/lib/ui-locale-server");

describe("the data notice", () => {
  it("tells readers, in both languages, that a workspace's own model key is stored encrypted and where server-side analysis sends code when one is configured", async () => {
    // 服务端组件是异步的：先把它跑完拿到元素树，再渲染成静态 HTML。
    const page = async (locale: "zh-CN" | "en") => {
      vi.mocked(resolveUiLocale).mockResolvedValue(locale);
      return renderToStaticMarkup(await DataNoticePage());
    };
    const zh = await page("zh-CN");
    expect(zh).toContain("工作区配置了自己的模型时，服务端分析所需的代码文件与 diff 发送到工作区指定的模型服务地址，不经过部署方的网关");
    expect(zh).toContain("工作区自己配置的模型 API key 加密存储，只用于替这个工作区调用它指定的模型服务");
    const en = await page("en");
    expect(en).toContain("When a workspace configures its own model, the code files and diffs needed for server-side analysis go to the model service address the workspace chose, not through the deployment&#x27;s gateway");
    expect(en).toContain("The API key of a workspace&#x27;s own model is stored encrypted and is used only to call the model service that workspace chose");
    // 静态 HTML 里撇号被转义成 &#x27;。
    // 更新日期跟着内容走。
    expect(zh).toContain("最后更新：2026-11-27");
  });
});
