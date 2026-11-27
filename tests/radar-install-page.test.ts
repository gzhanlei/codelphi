import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RadarInstallPage from "../app/skills/codelphi-radar/page";

const mockLocale = vi.hoisted(() => ({ value: "zh-CN" as "zh-CN" | "en" }));
vi.mock("../lib/ui-locale-server", () => ({ resolveUiLocale: async () => mockLocale.value }));
vi.mock("../components/public-shell", () => ({ PublicShell: ({ children }: { children: React.ReactNode }) => createElement("div", null, children) }));

describe("codelphi radar installation page", () => {
  it("offers one-sentence install/usage and host-native usage", async () => {
    mockLocale.value = "zh-CN";
    const html = renderToStaticMarkup(await RadarInstallPage());

    expect(html).toContain("codelphi-radar");
    expect(html).toContain("https://github.com/gzhanlei/codelphi/releases/latest/download/codelphi-radar.zip");
    expect(html).toContain("用 codelphi radar skill 分析 https://github.com/owner/repo");
    expect(html).toContain("CODELPHI_SKILL_HOST=claude-code");
    expect(html).toContain("complete");
    expect(html).toContain("prepare");
    expect(html).toContain("finalize");
    expect(html).toContain("--scope");
    expect(html).toContain("--language");
    expect(html).toContain("/path/to/repo");
    expect(html).toContain("standalone");
    // 失效的仓库锚点链接不再出现
    expect(html).not.toContain("#codelphi-radar");
  });

  it("renders English utterances with no Chinese leakage in the en locale", async () => {
    mockLocale.value = "en";
    const html = renderToStaticMarkup(await RadarInstallPage());

    expect(html).toContain("Install this skill: https://github.com/gzhanlei/codelphi/releases/latest/download/codelphi-radar.zip");
    expect(html).toContain("Use the codelphi radar skill to analyze https://github.com/owner/repo");
    expect(html).not.toContain("安装");
    expect(html).not.toContain("这个 skill");
    expect(html).not.toContain("用 codelphi radar skill 分析");
  });

  it("documents publishing an analysis to CoDelphi, including the two-step form, in the language of the page", async () => {
    mockLocale.value = "zh-CN";
    const html = renderToStaticMarkup(await RadarInstallPage());
    // 页面里的尖括号会被转义，所以占位符按转义后的样子找。
    for (const text of ["snapshot.cjs config", "snapshot.cjs publish /path/to/repo --slug &lt;product-slug&gt;", "--workdir .codelphi-publish --prepare", "--workdir .codelphi-publish --finalize", "源码文件、补丁和源码摘录都不离开本机", "不经过 CoDelphi"]) expect(html).toContain(text);

    mockLocale.value = "en";
    const english = renderToStaticMarkup(await RadarInstallPage());
    for (const text of ["Publish an analysis to CoDelphi", "Source files, patches, and source excerpts never leave the machine", "not through CoDelphi", "--finalize only uploads and does not call a model"]) expect(english).toContain(text);
    expect(english).not.toContain("客户端分析");
    expect(english).not.toContain("不离开本机");
  });
});
