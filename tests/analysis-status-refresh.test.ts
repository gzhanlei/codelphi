import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisStatusRefresh, analysisRefreshDelay } from "../components/analysis-status-refresh";

const { useEffect, refresh } = vi.hoisted(() => ({ useEffect: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useEffect }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("analysis status refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useEffect.mockClear();
    refresh.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it("polls only queued and running analyses", () => {
    expect(analysisRefreshDelay("queued")).toBe(3_000);
    expect(analysisRefreshDelay("running")).toBe(3_000);
    expect(analysisRefreshDelay("succeeded")).toBeNull();
    expect(analysisRefreshDelay("failed")).toBeNull();
  });

  it("refreshes every three seconds and cleans up its timer", () => {
    AnalysisStatusRefresh({ status: "running" });
    const effect = useEffect.mock.calls[0][0] as () => () => void;
    const cleanup = effect();
    vi.advanceTimersByTime(6_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    cleanup();
    vi.advanceTimersByTime(6_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not schedule work after a terminal state", () => {
    AnalysisStatusRefresh({ status: "succeeded" });
    const effect = useEffect.mock.calls[0][0] as () => undefined;
    expect(effect()).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
