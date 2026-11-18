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
});
