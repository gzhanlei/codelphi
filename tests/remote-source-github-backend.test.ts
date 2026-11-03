import { describe, expect, it, vi } from "vitest";
import { createGitHubSourceBackend } from "../lib/remote-source-index/github-backend";

const ref = { owner: "gzhanlei", repo: "commerce", revision: "a".repeat(40) };

describe("GitHub source backend", () => {
  it("resolves revisions, lists trees, and fetches base64 blobs", async () => {
    const requests: string[] = [];
    const backend = createGitHubSourceBackend({
      access: { token: "test-token" },
      fetchImpl: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith(`/git/trees/${ref.revision}`)) {
          return Response.json({ sha: "tree-root", truncated: false, tree: [] });
        }
        if (url.endsWith("/git/trees/tree-root")) {
          return Response.json({ sha: "tree-root", truncated: false, tree: [{ path: "README.md", type: "blob", sha: "blob-sha", size: 8 }] });
        }
        return Response.json({ sha: "blob-sha", content: Buffer.from("content").toString("base64"), encoding: "base64" });
      },
    });
    expect(await backend.resolveRevision(ref)).toEqual({ rootTreeSha: "tree-root" });
    expect(await backend.listTree(ref, "tree-root", "")).toEqual({
      entries: [{ path: "README.md", type: "blob", sha: "blob-sha", size: 8 }],
      truncated: false,
    });
    expect(new TextDecoder().decode(await backend.fetchBlob(ref, "README.md", "blob-sha"))).toBe("content");
    expect(requests).toEqual([
      `https://api.github.com/repos/gzhanlei/commerce/git/trees/${ref.revision}`,
      "https://api.github.com/repos/gzhanlei/commerce/git/trees/tree-root",
      "https://api.github.com/repos/gzhanlei/commerce/git/blobs/blob-sha",
    ]);
  });

  it("falls back to GITHUB_TOKEN when access options are omitted", async () => {
    vi.stubEnv("GITHUB_TOKEN", "environment-token");
    const headers: Record<string, string>[] = [];
    const backend = createGitHubSourceBackend({ access: {}, fetchImpl: async (_url, init) => {
      headers.push(init?.headers as Record<string, string>);
      return Response.json({ sha: "root", truncated: false, tree: [{ path: "README.md", type: "blob", sha: "blob", mode: "100644", size: 3 }] });
    } });
    expect(await backend.resolveRevision(ref)).toEqual({ rootTreeSha: "root" });
    expect(await backend.listTree(ref, "root", "")).toEqual({ entries: [{ path: "README.md", type: "blob", sha: "blob", mode: "100644", size: 3 }], truncated: false });
    expect(headers[0].Authorization).toBe("Bearer environment-token");
    vi.unstubAllEnvs();
  });

  it("surfaces GitHub API failures as source index errors", async () => {
    const backend = createGitHubSourceBackend({ access: { token: "test-token" }, fetchImpl: async () => new Response("rate limited", { status: 403 }) });
    await expect(backend.resolveRevision(ref)).rejects.toThrow("GitHub API 403: rate limited");
    await expect(backend.listTree(ref, "tree-root", "")).rejects.toThrow("GitHub API 403: rate limited");
    await expect(backend.fetchBlob(ref, "README.md", "blob-sha")).rejects.toThrow("GitHub API 403: rate limited");
  });

  it("supports UTF-8 blob responses", async () => {
    const backend = createGitHubSourceBackend({
      access: { token: "test-token" },
      fetchImpl: async () => Response.json({ sha: "blob-sha", content: "content", encoding: "utf-8" }),
    });
    expect(new TextDecoder().decode(await backend.fetchBlob(ref, "README.md", "blob-sha"))).toBe("content");
  });
});
