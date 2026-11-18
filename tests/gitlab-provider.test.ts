import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { clearGitlabTokenCache, parseGitlabRepository, verifyGitlabSignature, getGitlabChangeContext, getGitlabBranchHead, gitlabToken } from "../lib/gitlab";
import { encryptSecret } from "../lib/secret-box";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

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

describe("gitlabToken resolution（连接令牌消费链）", () => {
  const SECRET = "session-secret-test";

  function connectionDb(rows: Array<Record<string, unknown>>) {
    // 尊重真实 SQL 语义：status = 'active' 过滤由 DB 完成，mock 按行状态重放
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes("status = 'active'")) return [rows.filter((row) => row.status === undefined || row.status === "active"), []];
      return [rows, []];
    });
    const getConnection = vi.fn(async () => ({
      execute,
      release: vi.fn(),
    }));
    return { getConnection, execute };
  }

  beforeEach(() => {
    vi.mocked(getDb).mockReset();
    clearGitlabTokenCache();
  });

  it("resolves an active connection's decrypted token by scoped (connectionId, organizationId)", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("GITLAB_TOKEN", "glpat-env-fallback");
    const db = connectionDb([{ token_encrypted: encryptSecret("glpat-stored", SECRET) }]);
    vi.mocked(getDb).mockReturnValue(db as never);
    expect(await gitlabToken({ connectionId: 9, organizationId: 7 })).toBe("glpat-stored");
    // 池级 execute（不 checkout 连接），SQL 内完成 (id, organization_id, active) 三重过滤
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(String(db.execute.mock.calls[0][0])).toContain("organization_id = ? AND status = 'active'");
  });

  it("falls back to the env token when the connection is missing, disconnected or org-mismatched", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("GITLAB_TOKEN", "glpat-env-fallback");
    for (const rows of [[], [{ token_encrypted: encryptSecret("x", SECRET), status: "disconnected" }]]) {
      const db = connectionDb(rows);
      vi.mocked(getDb).mockReturnValue(db as never);
      // organizationId 缺省即拒绝走连接通道（跨租户面），行过滤在 SQL 里兜底
      expect(await gitlabToken({ connectionId: 9 })).toBe("glpat-env-fallback");
      expect(await gitlabToken({ connectionId: 9, organizationId: 7 })).toBe("glpat-env-fallback");
    }
    // 无 connectionId：保持纯 env 口径
    expect(await gitlabToken({})).toBe("glpat-env-fallback");
  });

  it("caches the resolved token briefly so analysis runs do not hit the DB per API call", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const db = connectionDb([{ token_encrypted: encryptSecret("glpat-stored", SECRET) }]);
    vi.mocked(getDb).mockReturnValue(db as never);
    await gitlabToken({ connectionId: 9, organizationId: 7 });
    await gitlabToken({ connectionId: 9, organizationId: 7 });
    expect(db.execute).toHaveBeenCalledTimes(1);
    clearGitlabTokenCache();
    await gitlabToken({ connectionId: 9, organizationId: 7 });
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error when neither connection nor env token exists", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    delete process.env.GITLAB_TOKEN;
    const db = connectionDb([]);
    vi.mocked(getDb).mockReturnValue(db as never);
    await expect(gitlabToken({ connectionId: 9, organizationId: 7 })).rejects.toThrow("GITLAB_TOKEN is not configured");
  });
});
