import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReleaseCard } from "../components/release-card";
import { clientProvenanceOf } from "../lib/version-provenance";
import type { ReleaseRow } from "../lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../components/demo-mode", () => ({ useDemoGuard: () => () => false }));

const release: ReleaseRow = { id: 7, title: "v1", summary: "摘要", sha: "abc1234def5678", url: "https://github.com/o/r/commit/abc", committedAt: new Date("2026-11-07T00:00:00Z"), specVersionId: 7 };

function render(overrides: Partial<ReleaseRow> = {}, locale: "zh-CN" | "en" = "zh-CN") {
  return renderToStaticMarkup(createElement(ReleaseCard, { slug: "codelphi", release: { ...release, ...overrides }, changes: [], behaviorChanges: [], tasks: [], canEdit: false, locale }));
}

describe("clientProvenanceOf", () => {
  it("reads the client-declared model out of a version's provenance and ignores anything that is not a client publish", () => {
    const stored = JSON.stringify({ server: { executor: "client", specVersionId: 40 }, client: { model: "tenant-model", clientVersion: "0.1.0" } });
    expect(clientProvenanceOf(stored)).toEqual({ executor: "client", model: "tenant-model", clientVersion: "0.1.0" });
    expect(clientProvenanceOf(JSON.parse(stored))).toEqual({ executor: "client", model: "tenant-model", clientVersion: "0.1.0" });
    for (const other of [null, undefined, "", "not json", {}, JSON.stringify({ server: { executor: "server" } })]) expect(clientProvenanceOf(other)).toBeNull();
  });
});

describe("release card provenance", () => {
  it("marks a version that came from the tenant's client analysis and calls the model client-declared", () => {
    const html = render({ provenance: { executor: "client", model: "tenant-model", clientVersion: "0.1.0" } });
    expect(html).toContain("tenant-model");
    expect(html).toContain("客户端声明");
    expect(html).toContain("本地分析");
    expect(html).toContain("文件级影响面");
    expect(render({ provenance: { executor: "client", model: "tenant-model", clientVersion: "0.1.0" } }, "en")).toContain("client-declared");
  });

  it("says nothing about provenance on a hosted version", () => {
    expect(render()).not.toContain("客户端声明");
    expect(render()).not.toContain("release-provenance");
  });

  it("does not render a link when the repository has no hosted address", () => {
    const html = render({ url: "", provenance: { executor: "client", model: "m", clientVersion: "1" } });
    expect(html).not.toContain('href=""');
    expect(html).toContain("abc1234");
  });
});
