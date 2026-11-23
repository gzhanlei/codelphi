import { describe, expect, it, vi } from "vitest";

// 脚本顶部加载 .env：测试里不需要，也不应把本地环境变量带进测试进程。
vi.mock("dotenv/config", () => ({}));

import { runPresentationBackfill } from "../scripts/generate-product-presentations";

const targets = [
  { id: 3, slug: "codelphi", name: "CoDelphi", features: 294 },
  { id: 20, slug: "airecord", name: "AIRecord", features: 1024 },
];

function deps(outcomes: Array<"generated" | "unchanged" | "failed" | "deferred">) {
  const resolve = vi.fn(async () => targets);
  const refresh = vi.fn(async (productId: number) => ({ outcome: outcomes[targets.findIndex((target) => target.id === productId)], detail: { journeys: 5 } }));
  return { resolve, refresh };
}

describe("generate-product-presentations script", () => {
  it("rejects argument combinations that name no target", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await runPresentationBackfill([], deps([]))).toBe(2);
      expect(await runPresentationBackfill(["--product"], deps([]))).toBe(2);
      expect(await runPresentationBackfill(["--product", "x", "--org", "abc"], deps([]))).toBe(2);
      expect(await runPresentationBackfill(["--wat"], deps([]))).toBe(2);
    } finally {
      log.mockRestore();
    }
  });

  it("dry-run lists the targets without calling the model", async () => {
    const { resolve, refresh } = deps([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runPresentationBackfill(["--public-demo", "--dry-run"], { resolve, refresh })).toBe(0);
      expect(resolve).toHaveBeenCalledWith({ product: undefined, org: undefined, publicDemo: true, all: false, dryRun: true, force: false });
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("refreshes every target in order and reports the tally", async () => {
    const { resolve, refresh } = deps(["generated", "failed"]);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")); });
    try {
      // 未改规格的产品重跑是幂等的：调度器判定未变化，不花模型调用
      expect(await runPresentationBackfill(["--product", "codelphi", "--org", "2"], { resolve, refresh })).toBe(1);
    } finally {
      log.mockRestore();
    }
    expect(resolve).toHaveBeenCalledWith({ product: "codelphi", org: 2, publicDemo: false, all: false, dryRun: false, force: false });
    // 默认不强制：规格没变的产品由调度器判定「未变化」，零模型调用——脚本可以放心重复执行
    expect(refresh.mock.calls).toEqual([[3, false], [20, false]]);
    expect(lines.at(-1)).toContain('"generated":1');
    expect(lines.at(-1)).toContain('"failed":1');
  });

  it("exits cleanly when nothing needs a refresh", async () => {
    const { resolve, refresh } = deps(["unchanged", "deferred"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runPresentationBackfill(["--all"], { resolve, refresh })).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it("passes --force through so maintainers can deliberately refresh existing presentations", async () => {
    const { resolve, refresh } = deps(["generated", "generated"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runPresentationBackfill(["--all", "--force"], { resolve, refresh })).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ all: true, force: true }));
    expect(refresh.mock.calls).toEqual([[3, true], [20, true]]);
  });

  it("surfaces an empty target set without calling anything", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runPresentationBackfill(["--public-demo"], { resolve: async () => [], refresh: vi.fn() })).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});
