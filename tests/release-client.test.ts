import { beforeEach, describe, expect, it, vi } from "vitest";
import { RELEASE_PAGE_SIZE, loadMoreReleases } from "../lib/release-client";

const fetcher = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

const payload = {
  total: 29,
  releases: [{ id: 3, title: "t", summary: "s", sha: "abc1234def5678", url: "u", committedAt: "2026-11-07T00:00:00.000Z", specVersionId: 9 }],
  changes: [],
  behaviorChanges: [],
};

describe("load more releases", () => {
  it("fetches the next page with offset and returns the payload", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    const result = await loadMoreReleases("codelphi", 10, fetcher);
    expect(result).toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(`/api/products/codelphi/releases?offset=10&limit=${RELEASE_PAGE_SIZE}`, { cache: "no-store" });
  });

  it("throws the API error message when the response is not ok", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: "产品不存在或不属于当前工作区" }), { status: 404 }));
    await expect(loadMoreReleases("missing", 10, fetcher)).rejects.toThrow("产品不存在或不属于当前工作区");
  });
});
