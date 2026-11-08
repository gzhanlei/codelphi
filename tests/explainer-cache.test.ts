import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCachedExplainerHtml, saveExplainerCache } from "../lib/explainer-cache";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

const execute = vi.fn();

beforeEach(() => {
  execute.mockReset();
  vi.mocked(getDb).mockReturnValue({ execute } as never);
});

describe("explainer cache", () => {
  it("returns cached html keyed by product + latest spec version", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM spec_versions")) return [[{ id: 88 }]];
      if (sql.includes("FROM explainer_cache")) return [[{ html: "<html>cached</html>" }]];
      return [[]];
    });
    expect(await loadCachedExplainerHtml(4)).toBe("<html>cached</html>");
    expect(execute.mock.calls.find(([sql]) => String(sql).includes("FROM explainer_cache"))?.[1]).toEqual([4, 88]);
  });

  it("returns null when the product has no spec version yet", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM spec_versions")) return [[]];
      return [[]];
    });
    expect(await loadCachedExplainerHtml(4)).toBeNull();
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("FROM explainer_cache"))).toBe(false);
  });

  it("degrades to direct rendering when the cache read fails", async () => {
    execute.mockRejectedValue(new Error("read failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await loadCachedExplainerHtml(4)).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("writes the rendered html idempotently (ODKU) and survives write failures", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM spec_versions")) return [[{ id: 88 }]];
      return [{ affectedRows: 1 }];
    });
    await saveExplainerCache(4, "<html>fresh</html>");
    expect(execute.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO explainer_cache"))?.[1]).toEqual([4, 88, "<html>fresh</html>"]);

    execute.mockRejectedValue(new Error("write failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(saveExplainerCache(4, "<html>x</html>")).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
