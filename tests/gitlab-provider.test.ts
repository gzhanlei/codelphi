import { describe, expect, it, vi, afterEach } from "vitest";
import { parseGitlabRepository, verifyGitlabSignature, getGitlabChangeContext, getGitlabBranchHead } from "../lib/gitlab";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const access = { token: "glpat-test" };

describe("gitlab provider (C2 接入层)", () => {
  it("parses owner/name repository refs", () => {
    expect(parseGitlabRepository("group/project")).toEqual({ owner: "group", name: "project", defaultBranch: "main" });
    expect(parseGitlabRepository("a/b/c")).toEqual({ owner: "a", name: "b/c", defaultBranch: "main" });
  });

  it("verifies webhooks by constant-time secret-token comparison (GitLab 验签差异：非 HMAC)", () => {
    expect(verifyGitlabSignature("body", "secret-1", "secret-1")).toBe(true);
    expect(verifyGitlabSignature("body", "secret-1", "secret-2")).toBe(false);
    expect(verifyGitlabSignature("body", null, "secret-1")).toBe(false);
  });

  it("maps the compare API to ChangeContext (files from diffs, commit meta from last commit)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      commits: [
        { id: "c1", title: "first", message: "first", committed_date: "2026-11-08T00:00:00Z", web_url: "https://gitlab.com/g/p/-/commit/c1" },
        { id: "c2", title: "second", message: "second fix", committed_date: "2026-11-09T00:00:00Z", web_url: "https://gitlab.com/g/p/-/commit/c2" },
      ],
      diffs: [
        { old_path: "lib/a.ts", new_path: "lib/a.ts", diff: "@@ -1 +1 @@\n-x\n+y", new_file: false, deleted_file: false, renamed_file: false },
        { old_path: "", new_path: "lib/new.ts", diff: "+new", new_file: true, deleted_file: false, renamed_file: false },
      ],
    }), { status: 200 })));
    const context = await getGitlabChangeContext({ owner: "g", name: "p", defaultBranch: "main" }, "before-sha", "after-sha", access);
    expect(context.message).toBe("second fix");
    expect(context.url).toBe("https://gitlab.com/g/p/-/commit/c2");
    expect(context.files).toEqual([
      { path: "lib/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-x\n+y" },
      { path: "lib/new.ts", status: "added", patch: "+new" },
    ]);
  });

  it("reads the branch head from the branches API", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      expect(String(input)).toContain("/repository/branches/main");
      return new Response(JSON.stringify({ commit: { id: "head-sha" } }), { status: 200 });
    }));
    expect(await getGitlabBranchHead({ owner: "g", name: "p", defaultBranch: "main" }, access)).toBe("head-sha");
  });
});
