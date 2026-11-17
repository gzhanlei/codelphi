import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RadarInstallPage from "../app/skills/codelphi-radar/page";

vi.mock("../lib/ui-locale-server", () => ({ resolveUiLocale: async () => "zh-CN" }));
vi.mock("../components/public-shell", () => ({ PublicShell: ({ children }: { children: React.ReactNode }) => createElement("div", null, children) }));

describe("codelphi radar installation page", () => {
  it("offers an independent bundle and host-native usage", async () => {
    const html = renderToStaticMarkup(await RadarInstallPage());

    expect(html).toContain("codelphi-radar");
    expect(html).toContain("npm run radar:package");
    expect(html).not.toContain("releases/latest/download");
    expect(html).toContain("prepare");
    expect(html).toContain("finalize");
    expect(html).toContain("--scope");
    expect(html).toContain("--language");
    expect(html).toContain("/path/to/repo");
    expect(html).toContain("https://github.com/owner/repo");
    expect(html).toContain("standalone");
  });
});
