import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "../app/page";
import { getDb } from "../lib/db";

const execute = vi.fn();
vi.mock("../lib/db", () => ({ getDb: () => ({ execute }) }));
vi.mock("../lib/session", () => ({ requireSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("../lib/organizations", () => ({ requireOrganization: vi.fn(async () => ({ id: 7, name: "Workspace" })) }));
vi.mock("../components/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("../components/analysis-status-refresh", async (importOriginal) => ({
  ...await importOriginal<typeof import("../components/analysis-status-refresh")>(),
  ProductListRefresh: () => null,
}));

const productRow = {
  id: 1,
  slug: "new-product",
  name: "New Product",
  description: "Description",
  featureCount: 0,
  releaseCount: 0,
  lastRelease: null,
  analysisStatus: "running",
  analysisRevision: "sha-1",
  architectureStatus: null,
  architectureRevision: null,
};

describe("dashboard page", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockImplementation(async () => [[]]);
  });

  it("queries readiness fields and renders a pending product without a detail link", async () => {
    execute.mockImplementationOnce(async () => [[productRow]]).mockImplementationOnce(async () => [[]]);
    const html = renderToStaticMarkup(await DashboardPage());
    expect(execute.mock.calls[0][0]).toContain("latest_run.after_sha AS analysisRevision");
    expect(execute.mock.calls[0][0]).toContain("latest_architecture.revision AS architectureRevision");
    expect(execute.mock.calls[0][1]).toEqual([7]);
    expect(html).toContain("分析中，请稍候");
    expect(html).not.toContain("href=\"/products/new-product\"");
  });

  it("renders a detail link after the same revision has an accepted architecture", async () => {
    execute.mockImplementationOnce(async () => [[{ ...productRow, analysisStatus: "succeeded", architectureStatus: "accepted", architectureRevision: "sha-1" }]]).mockImplementationOnce(async () => [[]]);
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain("href=\"/products/new-product\"");
    expect(html).not.toContain("分析中，请稍候");
  });

  it("totals feature and release counts across products", async () => {
    const ready = { ...productRow, analysisStatus: "succeeded", architectureStatus: "accepted", architectureRevision: "sha-1" };
    execute.mockImplementationOnce(async () => [[
      { ...ready, featureCount: 2, releaseCount: 4 },
      { ...ready, id: 2, slug: "second", featureCount: 3, releaseCount: 5 },
    ]]).mockImplementationOnce(async () => [[]]);
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain("<strong>5</strong>");
    expect(html).toContain("<strong>9</strong>");
  });
});
