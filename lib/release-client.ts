import type { BehaviorChangeRow, ChangeRow, ReleaseRow } from "./types";

/** 发布变化列表的分页大小：首屏与每次「加载更多」各取一页。 */
export const RELEASE_PAGE_SIZE = 10;

export interface ReleasePagePayload {
  total: number;
  releases: ReleaseRow[];
  changes: ChangeRow[];
  behaviorChanges: BehaviorChangeRow[];
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** 发布变化页的「加载更多」：按 offset 取下一页（服务端已完成证据与改名装饰）。 */
export async function loadMoreReleases(slug: string, offset: number, fetcher: Fetcher = fetch): Promise<ReleasePagePayload> {
  const response = await fetcher(`/api/products/${slug}/releases?offset=${offset}&limit=${RELEASE_PAGE_SIZE}`, { cache: "no-store" });
  const data = await response.json() as ReleasePagePayload & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "加载更多发布失败");
  return data;
}
