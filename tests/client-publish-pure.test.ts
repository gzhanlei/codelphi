import { describe, expect, it } from "vitest";
import type { PrivacyHit } from "../lib/privacy-scan";
import { PLACEHOLDER_PATCH } from "../lib/client-proposal/adapt";
import { providerOfHost, repositoryIdentityOf } from "../lib/client-publish/identity";
import { decidePublish } from "../lib/client-publish/state";
import { parseUnifiedDiff, windowOf } from "../lib/client-publish/window";
import { prunePrivacyHits } from "../lib/client-publish/prune";

describe("repositoryIdentityOf", () => {
  const local = { repositoryId: null, provider: "local", host: null, owner: null, name: "notes" };

  it("reads GitHub, public GitLab and Gitee addresses in their scp-like and https forms", () => {
    const github = { repositoryId: null, provider: "github", host: "github.com", owner: "acme", name: "api" };
    for (const remote of ["git@github.com:acme/api.git", "https://github.com/acme/api", "https://github.com/acme/api.git", "ssh://git@github.com/acme/api.git"]) {
      expect(repositoryIdentityOf(remote, "api"), remote).toEqual(github);
    }
    expect(repositoryIdentityOf("https://gitlab.com/team/api.git", "api")).toEqual({ repositoryId: null, provider: "gitlab", host: "gitlab.com", owner: "team", name: "api" });
    expect(repositoryIdentityOf("git@gitee.com:u/r.git", "r")).toEqual({ repositoryId: null, provider: "gitee", host: "gitee.com", owner: "u", name: "r" });
  });

  it("keeps the host of a self-hosted instance and drops the port", () => {
    expect(repositoryIdentityOf("ssh://git@gitlab.corp.com:2222/team/api.git", "api")).toEqual({ repositoryId: null, provider: "gitlab", host: "gitlab.corp.com", owner: "team", name: "api" });
    expect(repositoryIdentityOf("https://git.example.com/team/api", "api", { provider: "gitea" })).toEqual({ repositoryId: null, provider: "gitea", host: "git.example.com", owner: "team", name: "api" });
  });

  it("never lets a token in the address become part of the identity", () => {
    const identity = repositoryIdentityOf("https://x-access-token:ghs_aVerySecretToken@github.com/acme/api.git", "api");
    expect(JSON.stringify(identity)).not.toContain("ghs_aVerySecretToken");
    expect(identity).toEqual({ repositoryId: null, provider: "github", host: "github.com", owner: "acme", name: "api" });
  });

  it("treats GitLab subgroups as part of the owner", () => {
    expect(repositoryIdentityOf("https://gitlab.com/team/group/api.git", "api")).toMatchObject({ owner: "team/group", name: "api" });
  });

  it("falls back to the directory name when the remote names a host but no repository path", () => {
    for (const remote of ["https://github.com/", "git@github.com:.git"]) {
      expect(repositoryIdentityOf(remote, "fallback"), remote).toEqual({ repositoryId: null, provider: "github", host: "github.com", owner: null, name: "fallback" });
    }
  });

  it("is a local repository when there is no remote", () => {
    for (const remote of [null, undefined, "", "   "]) expect(repositoryIdentityOf(remote, "notes")).toEqual(local);
  });

  it("guesses the provider from the host and lets the caller correct it", () => {
    expect(providerOfHost("git.corp.internal")).toBe("gitlab");
    expect(providerOfHost("git.mycompany.com")).toBe("gitlab");
    expect(repositoryIdentityOf("https://git.corp.internal/team/api", "api", { provider: "gitea" }).provider).toBe("gitea");
  });
});

describe("decidePublish", () => {
  const base = { full: false };

  it("publishes a full analysis as a baseline when the ledger is empty", () => {
    expect(decidePublish({ ...base, hasLedger: false, relation: "unrelated" })).toEqual({ action: "publish", mode: "full", reason: "first", windowFrom: "parent" });
  });

  it("does nothing when the ledger already sits on the target commit, unless a full analysis is forced", () => {
    expect(decidePublish({ ...base, hasLedger: true, relation: "equal" })).toEqual({ action: "noop", reason: "already_published" });
    expect(decidePublish({ full: true, hasLedger: true, relation: "equal" })).toEqual({ action: "publish", mode: "full", reason: "forced", windowFrom: "base" });
  });

  it("would increment when the ledger commit is a strict ancestor, which is not available yet", () => {
    expect(decidePublish({ ...base, hasLedger: true, relation: "ledger_is_ancestor" })).toMatchObject({ action: "refuse", reason: "incremental_not_available" });
    expect(decidePublish({ full: true, hasLedger: true, relation: "ledger_is_ancestor" })).toEqual({ action: "publish", mode: "full", reason: "forced", windowFrom: "base" });
  });

  it("refuses to publish onto a ledger that is already ahead of the local commit", () => {
    expect(decidePublish({ ...base, hasLedger: true, relation: "target_is_ancestor" })).toMatchObject({ action: "refuse", reason: "ledger_ahead" });
    expect(decidePublish({ full: true, hasLedger: true, relation: "target_is_ancestor" }).action).toBe("refuse");
  });

  it("asks for confirmation when the two commits are not related", () => {
    expect(decidePublish({ ...base, hasLedger: true, relation: "unrelated" })).toMatchObject({ action: "refuse", reason: "needs_full_flag" });
    expect(decidePublish({ full: true, hasLedger: true, relation: "unrelated" })).toEqual({ action: "publish", mode: "full", reason: "diverged_with_full", windowFrom: "base" });
  });

  it("asks for confirmation when the ledger's commit is missing, then analyzes the target's own window", () => {
    expect(decidePublish({ full: false, hasLedger: true, relation: "missing" })).toMatchObject({ action: "refuse", reason: "ledger_commit_missing" });
    expect(decidePublish({ full: true, hasLedger: true, relation: "missing" })).toEqual({ action: "publish", mode: "full", reason: "diverged_with_full", windowFrom: "parent" });
  });
});

describe("parseUnifiedDiff", () => {
  const diff = [
    "diff --git a/lib/auth.ts b/lib/auth.ts",
    "index 1111111..2222222 100644",
    "--- a/lib/auth.ts",
    "+++ b/lib/auth.ts",
    "@@ -10,3 +12,4 @@ export function guard(",
    "-const attempts = 1;",
    "+const attempts = 2;",
    "+const delay = 10;",
    " const retry = true;",
    "diff --git a/lib/new.ts b/lib/new.ts",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/lib/new.ts",
    "@@ -0,0 +1,2 @@",
    "+export const a = 1;",
    "+export const b = 2;",
    "diff --git a/lib/old.ts b/lib/gone.ts",
    "deleted file mode 100644",
    "index 4444444..0000000",
    "--- a/lib/old.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-export const c = 3;",
    "-export const d = 4;",
    "diff --git a/lib/a.ts b/lib/b.ts",
    "similarity index 100%",
    "rename from lib/a.ts",
    "rename to lib/b.ts",
    "diff --git a/docs/guide.md b/docs/guide.md",
    "index 5555555..6666666 100644",
    "--- a/docs/guide.md",
    "+++ b/docs/guide.md",
    "@@ -1,2 +1,2 @@",
    "-# 旧标题",
    "+# 新标题",
    "",
    "正文",
    "diff --git a/assets/logo.png b/assets/logo.png",
    "index 7777777..8888888 100644",
    "Binary files a/assets/logo.png and b/assets/logo.png differ",
    "diff --git a/scripts/run.sh b/scripts/run.sh",
    "old mode 100644",
    "new mode 100755",
    "diff --git \"a/with space.txt\" \"b/with space.txt\"",
    "index 9999999..aaaaaaa 100644",
    "--- a/with space.txt",
    "+++ b/with space.txt",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");

  it("turns a unified diff into the same file items the hosted path gets from the compare API", () => {
    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "lib/auth.ts", previousPath: null, status: "modified", patch: "@@ -10,3 +12,4 @@ export function guard(\n-const attempts = 1;\n+const attempts = 2;\n+const delay = 10;\n const retry = true;" },
      { path: "lib/new.ts", previousPath: null, status: "added", patch: "@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;" },
      { path: "lib/old.ts", previousPath: null, status: "removed", patch: "@@ -1,2 +0,0 @@\n-export const c = 3;\n-export const d = 4;" },
      { path: "lib/b.ts", previousPath: "lib/a.ts", status: "renamed", patch: PLACEHOLDER_PATCH },
      { path: "docs/guide.md", previousPath: null, status: "modified", patch: "@@ -1,2 +1,2 @@\n-# 旧标题\n+# 新标题\n\n正文" },
      { path: "assets/logo.png", previousPath: null, status: "modified", patch: PLACEHOLDER_PATCH },
      { path: "scripts/run.sh", previousPath: null, status: "modified", patch: "old mode 100644\nnew mode 100755" },
      { path: "with space.txt", previousPath: null, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
    ]);
  });

  it("reads quoted paths the way git writes them when a file name needs quoting", () => {
    const quoted = ['diff --git "a/with \\"q\\\".txt" "b/with \\"q\\\".txt"', 'index 1111111..2222222 100644', '--- "a/with \\"q\\\".txt"', '+++ "b/with \\"q\\\".txt"', '@@ -1 +1 @@', '-a', '+b', 'diff --git a/scripts/run.sh b/scripts/run.sh', 'old mode 100644', 'new mode 100755', ''].join("\n");
    expect(parseUnifiedDiff(quoted).map((file) => file.path)).toEqual(['with "q".txt', "scripts/run.sh"]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("computes the behavioural set and the hunks with the same functions the hosted path uses", () => {
    const window = windowOf(parseUnifiedDiff(diff));
    // 和托管路径同一套判定：二进制、shell 脚本不在能识别注释的语言里，一律算行为变更；文档、只有注释的改动不算。
    expect([...window.behavioralPaths].sort()).toEqual(["assets/logo.png", "lib/auth.ts", "lib/new.ts", "lib/old.ts", "scripts/run.sh", "with space.txt"]);
    expect(window.files.find((file) => file.path === "lib/auth.ts")).toMatchObject({ status: "modified", behavioral: true, hunks: [{ oldStart: 10, oldCount: 3, newStart: 12, newCount: 4 }] });
    expect(window.files.find((file) => file.path === "docs/guide.md")).toMatchObject({ behavioral: false, hunks: [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 }] });
    // 纯改名没有行号区间；二进制文件没有区间但算行为变更。
    expect(window.files.find((file) => file.path === "lib/b.ts")).toMatchObject({ status: "renamed", behavioral: false, hunks: [] });
    expect(window.files.find((file) => file.path === "assets/logo.png")).toMatchObject({ behavioral: true, hunks: [] });
    expect(window.files.find((file) => file.path === "scripts/run.sh")).toMatchObject({ behavioral: true, hunks: [] });
  });
});

describe("prunePrivacyHits", () => {
  const fields = () => ({
    proposal: {
      product: { description: "账本", evidence: [] },
      release: { title: "发布", summary: "摘要" },
      changes: [{ featureName: "A", kind: "added", description: "d0", userImpact: "", evidence: [] }, { featureName: "B", kind: "changed", description: "d1", userImpact: "", evidence: [] }],
      features: [
        { name: "A", summary: "a", scenarios: [{ reference: "HP-1" }, { reference: "EC-1" }, { reference: "EC-2" }] },
        { name: "B", summary: "b", scenarios: [{ reference: "HP-1" }] },
        { name: "C", summary: "c", scenarios: [{ reference: "HP-1" }] },
      ],
    },
    flows: [{ featureStableKey: "a" }, { featureStableKey: "b" }, { featureStableKey: "c" }],
    presentation: { note: "说明" },
  });
  const hit = (path: string): PrivacyHit => ({ rule: "code_fragment", path, line: 1 });

  it("drops the scenario, flow, change or feature that carries a hit and nothing else", () => {
    const result = prunePrivacyHits(fields() as unknown as Record<string, unknown>, [
      hit("proposal.features[0].scenarios[0].outcome"),
      hit("proposal.features[0].scenarios[2].action"),
      hit("proposal.features[2].summary"),
      hit("flows[1].graph.nodes[0].title"),
      hit("proposal.changes[0].description"),
    ]);
    expect((result.fields.proposal as ReturnType<typeof fields>["proposal"]).features.map((feature) => feature.name)).toEqual(["A", "B"]);
    expect((result.fields.proposal as ReturnType<typeof fields>["proposal"]).features[0].scenarios.map((scenario) => scenario.reference)).toEqual(["EC-1"]);
    expect((result.fields.flows as unknown[]).map((flow) => (flow as { featureStableKey: string }).featureStableKey)).toEqual(["a", "c"]);
    expect((result.fields.proposal as ReturnType<typeof fields>["proposal"]).changes.map((change) => change.featureName)).toEqual(["B"]);
    expect(result.dropped.map((item) => item.path).sort()).toEqual(["flows[1].graph.nodes[0].title", "proposal.changes[0].description", "proposal.features[0].scenarios[0].outcome", "proposal.features[0].scenarios[2].action", "proposal.features[2].summary"]);
    expect(result.blocked).toEqual([]);
    // 别处的命中不动理解层。
    expect(result.fields.presentation).toEqual({ note: "说明" });
  });

  it("lists every rule a dropped field tripped, once per field", () => {
    const result = prunePrivacyHits(fields() as unknown as Record<string, unknown>, [
      { rule: "source_line", path: "proposal.features[1].scenarios[0].outcome", line: 1 },
      { rule: "code_fragment", path: "proposal.features[1].scenarios[0].outcome", line: 1 },
      { rule: "code_fragment", path: "proposal.features[1].scenarios[0].outcome", line: 2 },
      { rule: "code_run", path: "proposal.features[1].scenarios[0].outcome", line: 1 },
    ]);
    expect(result.dropped).toEqual([{ path: "proposal.features[1].scenarios[0].outcome", rules: ["source_line", "code_fragment", "code_run"] }]);
    // 剔掉的是那一条场景；功能本身留着（以后就没有场景了）。
    const features = (result.fields.proposal as ReturnType<typeof fields>["proposal"]).features;
    expect(features.map((feature) => feature.name)).toEqual(["A", "B", "C"]);
    expect(features[1].scenarios).toEqual([]);
  });

  it("treats a path that points past the end of a list as something it cannot drop", () => {
    const input = fields() as unknown as Record<string, unknown>;
    // flows 只有 3 项：下标 3 正好是长度，9 更在后面。两种都不能当成「可以剔除」。
    const result = prunePrivacyHits(structuredClone(input), [hit("flows[9].graph"), hit("flows[3].graph"), hit("proposal.features[7].scenarios[0].outcome")]);
    expect(result.blocked.map((item) => item.path)).toEqual(["flows[9].graph", "flows[3].graph", "proposal.features[7].scenarios[0].outcome"]);
    expect(result.fields).toEqual(input);
  });

  it("leaves everything untouched when a single hit cannot be dropped, even next to hits that could", () => {
    const input = fields() as unknown as Record<string, unknown>;
    const result = prunePrivacyHits(structuredClone(input), [hit("proposal.product.description"), hit("proposal.features[0].scenarios[0].outcome")]);
    expect(result.blocked.map((item) => item.path)).toEqual(["proposal.product.description"]);
    expect(result.dropped.map((item) => item.path)).toEqual(["proposal.features[0].scenarios[0].outcome"]);
    expect(result.fields).toEqual(input);
  });

  it("drops the whole presentation when any part of it carries a hit", () => {
    const result = prunePrivacyHits(fields() as unknown as Record<string, unknown>, [hit("presentation.note")]);
    expect(result.fields.presentation).toEqual({});
    expect(result.dropped).toHaveLength(1);
  });

  it("cannot drop what the ledger needs, so a hit there blocks the publish", () => {
    const result = prunePrivacyHits(fields() as unknown as Record<string, unknown>, [hit("proposal.release.summary"), hit("proposal.product.description")]);
    expect(result.blocked.map((item) => item.path)).toEqual(["proposal.release.summary", "proposal.product.description"]);
    expect(result.fields).toEqual(fields());
  });

  it("is a no-op without hits and returns the same content", () => {
    const input = fields() as unknown as Record<string, unknown>;
    const result = prunePrivacyHits(structuredClone(input), []);
    expect(result.fields).toEqual(input);
    expect(result.dropped).toEqual([]);
  });
});
