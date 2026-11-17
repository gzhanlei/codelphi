import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitlabSourceBackend } from "../lib/remote-source-index/gitlab-backend";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const access = { token: "glpat-test" };
const ref = { owner: "g", repo: "p", revision: "sha-1" };

function treeResponse(entries: unknown[], nextPage: string | null) {
  const headers = new Headers();
  if (nextPage) headers.set("x-next-page", nextPage);
  return new Response(JSON.stringify(entries), { status: 200, headers });
}

describe("GitLab source backend tree listing", () => {
  it("follows x-next-page pagination so repositories over 100 entries are fully indexed", async () => {
    // GitLab tree API 每页上限 100：只取第一页且伪造 truncated:false 会让 >100 条目的
    // 仓库索引静默缺失（切片规划/证据覆盖全部建立在残缺文件集上且 status 仍标 indexed）
    const page1 = Array.from({ length: 100 }, (_, index) => ({ id: `s-${index}`, name: `f${index}.ts`, type: "blob", path: `src/f${index}.ts` }));
    const page2 = [{ id: "s-tail", name: "tail.ts", type: "blob", path: "src/tail.ts" }];
    const urls: string[] = [];
    vi.stubEnv("GITLAB_TOKEN", "glpat-env");
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      urls.push(String(input));
      if (String(input).includes("page=1&")) return treeResponse(page1, "2");
      return treeResponse(page2, null);
    }));
    const backend = createGitlabSourceBackend({ access });
    const result = await backend.listWholeTree?.(ref, "tree-sha");
    expect(result?.entries).toHaveLength(101);
    expect(result?.entries.at(-1)?.path).toBe("src/tail.ts");
    expect(result?.truncated).toBe(false);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("recursive=1");
    expect(urls[1]).toContain("page=2&");
  });

  it("paginates per-directory listings too", async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => ({ id: `s-${index}`, name: `f${index}.ts`, type: "blob", path: `lib/f${index}.ts` }));
    const page2 = [{ id: "s-end", name: "end.ts", type: "blob", path: "lib/end.ts" }];
    vi.stubEnv("GITLAB_TOKEN", "glpat-env");
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      if (String(input).includes("page=1&")) return treeResponse(page1, "2");
      return treeResponse(page2, null);
    }));
    const backend = createGitlabSourceBackend({ access });
    const result = await backend.listTree?.(ref, "tree-sha", "lib");
    expect(result?.entries).toHaveLength(101);
    expect(result?.truncated).toBe(false);
  });
});
