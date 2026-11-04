import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { analyze, reportResult, targetSlug } from "../scripts/analyze";
import { resolveManualAnalysis } from "../lib/manual-analysis";
import { queueAnalysis, runAnalysis } from "../lib/analysis";

const execute = vi.fn();
const end = vi.fn(async () => undefined);
vi.mock("../lib/db", () => ({ getDb: () => ({ execute, end }) }));
vi.mock("../lib/manual-analysis", () => ({ resolveManualAnalysis: vi.fn() }));
vi.mock("../lib/analysis", () => ({ queueAnalysis: vi.fn(), runAnalysis: vi.fn() }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

afterAll(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
});

describe("analysis CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.argv = [...originalArgv];
    process.exitCode = 0;
  });

  it("uses the default slug only when no argument is supplied", () => {
    process.argv = [originalArgv[0], originalArgv[1]];
    expect(targetSlug()).toBe("radar");
    process.argv = [originalArgv[0], originalArgv[1], "shop"];
    expect(targetSlug()).toBe("shop");
    process.argv[2] = "";
    expect(targetSlug()).toBe("");
  });

  it("reports succeeded and failed run states", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    execute.mockResolvedValue([[{ status: "failed", errorMessage: "denied" }]]);
    await reportResult(9);
    expect(log).toHaveBeenCalledWith("Analysis failed: denied");
    expect(process.exitCode).toBe(1);
    execute.mockResolvedValue([[{ status: "succeeded", errorMessage: null }]]);
    await reportResult(9);
    expect(log).toHaveBeenCalledWith("Analysis succeeded");
    log.mockRestore();
  });

  it("runs manual analysis with the resolved HEAD and closes the database", async () => {
    process.argv[2] = "radar";
    vi.mocked(resolveManualAnalysis).mockResolvedValue({ repositoryId: 9, afterSha: "1234567890abcdef" });
    vi.mocked(queueAnalysis).mockResolvedValue(55);
    execute.mockResolvedValue([[{ status: "succeeded", errorMessage: null }]]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await analyze();
    expect(queueAnalysis).toHaveBeenCalledWith(9, null, "1234567890abcdef", "manual");
    expect(runAnalysis).toHaveBeenCalledWith(55);
    expect(log).toHaveBeenCalledWith("Analysis run 55 started for radar@1234567");
    expect(end).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("fails clearly for an unknown product and still closes the database", async () => {
    process.argv[2] = "missing";
    vi.mocked(resolveManualAnalysis).mockResolvedValue(null);
    await expect(analyze()).rejects.toThrow("No repository registered for missing");
    expect(end).toHaveBeenCalledOnce();
  });
});
