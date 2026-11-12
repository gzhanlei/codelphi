import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: () => ({ execute }) }));

import { reportRunFailureToGithub } from "../lib/run-failure-report";

const run289 = '[\n  {\n    "expected": "array",\n    "code": "invalid_type",\n    "path": [\n      "features"\n    ],\n    "message": "Invalid input: expected array, received undefined"\n  }\n]';

const runFactsRows = [
  [
    {
      triggerType: "push",
      beforeSha: "08a9afcfcdc0c6ec5389d38db5ba0fafc0659ec",
      afterSha: "6ec05753df282348f83cc96ab613c6b2c649b72a",
      productId: 7,
      orgSlug: "u-a8811be775",
      productSlug: "codelphi",
    },
  ],
];

function jsonResponse(payload: unknown, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

describe("run failure GitHub reporting", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue(runFactsRows);
    process.env.GITHUB_ISSUE_TOKEN = "test-token";
    delete process.env.GITHUB_ISSUE_REPO;
    process.env.APP_URL = "https://codelphi.com";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_ISSUE_TOKEN;
    delete process.env.APP_URL;
  });

  it("skips entirely without a token (feature off, zero side effects)", async () => {
    delete process.env.GITHUB_ISSUE_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await reportRunFailureToGithub({ runId: 289, errorMessage: run289 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("never reports superseded runs (not a technical failure)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await reportRunFailureToGithub({ runId: 290, errorMessage: "Analysis superseded by run 291" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a new issue with page URL, run identity and raw error", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/issues?labels=")) return jsonResponse([]);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await reportRunFailureToGithub({ runId: 289, errorMessage: run289 });
    const createCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/issues") && !String(url).includes("?")) as [string, { body: string }] | undefined;
    expect(createCall).toBeDefined();
    const payload = JSON.parse(createCall![1].body);
    expect(payload.title).toBe("[auto-analysis] ai_output_format: features/invalid_type");
    expect(payload.labels).toContain("analysis-failure");
    expect(payload.body).toContain("https://codelphi.com/products/u-a8811be775/codelphi");
    expect(payload.body).toContain("Run：#289");
    expect(payload.body).toContain("invalid_type");
  });

  it("appends a comment to the existing open issue instead of creating a duplicate", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/issues?labels=")) {
        return jsonResponse([{ number: 42, title: "[auto-analysis] ai_output_format: features/invalid_type" }]);
      }
      if (String(url).endsWith("/issues/42/comments")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({ id: 1 }, 201);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await reportRunFailureToGithub({ runId: 290, errorMessage: run289 });
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.some((url) => url.endsWith("/issues") && !url.includes("?"))).toBe(false);
    expect(calls.some((url) => url.endsWith("/issues/42/comments"))).toBe(true);
  });

  it("swallows its own failures so the run failure path is never disturbed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    await expect(reportRunFailureToGithub({ runId: 289, errorMessage: run289 })).resolves.toBeUndefined();
  });
});
