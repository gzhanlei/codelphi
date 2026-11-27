/**
 * 状态判定（修订稿 §5.3）。纯函数：和 git 的祖先关系由调用方算好交进来，这里只做决定，所以能一张表测完。
 *
 * 账本当前提交与目标提交的关系        不带 --full            带 --full
 * 没有账本                           全量（首次）          全量（首次）
 * 相等                               空操作                全量（带基线）
 * 账本提交是目标提交的严格祖先        （第 1 期：要求 --full） 全量（带基线）
 * 互不为祖先                         要求 --full           全量（带基线）
 * 账本提交不在本地                   要求 --full           全量（目标自身窗口）
 * 账本领先于本地                     不发布                不发布
 *
 * 「祖先」一律指严格祖先：一个提交是它自己的祖先，所以「相等」必须排在「是祖先」前面。
 */
export type CommitRelation = "equal" | "ledger_is_ancestor" | "target_is_ancestor" | "unrelated" | "missing";

export type PublishDecision =
  | { action: "publish"; mode: "full"; reason: "first" | "forced" | "diverged_with_full"; windowFrom: "parent" | "base" }
  | { action: "noop"; reason: "already_published" }
  | { action: "refuse"; reason: "incremental_not_available" | "needs_full_flag" | "ledger_ahead" | "ledger_commit_missing" };

export function decidePublish(input: { hasLedger: boolean; relation: CommitRelation; full: boolean }): PublishDecision {
  const { full } = input;
  if (!input.hasLedger) return { action: "publish", mode: "full", reason: "first", windowFrom: "parent" };
  switch (input.relation) {
    case "equal":
      return full ? { action: "publish", mode: "full", reason: "forced", windowFrom: "base" } : { action: "noop", reason: "already_published" };
    case "ledger_is_ancestor":
      // 增量分析在第 2 期。在那之前，新提交只能带 --full 发全量。
      return full ? { action: "publish", mode: "full", reason: "forced", windowFrom: "base" } : { action: "refuse", reason: "incremental_not_available" };
    case "target_is_ancestor":
      return { action: "refuse", reason: "ledger_ahead" };
    case "unrelated":
      return full ? { action: "publish", mode: "full", reason: "diverged_with_full", windowFrom: "base" } : { action: "refuse", reason: "needs_full_flag" };
    case "missing":
      // 缺失的 base 不能用于 git diff；显式全量确认后按首次发布的口径读取目标提交自身窗口。
      return full ? { action: "publish", mode: "full", reason: "diverged_with_full", windowFrom: "parent" } : { action: "refuse", reason: "ledger_commit_missing" };
  }
}

export const REFUSAL_TEXT = {
  incremental_not_available: { zh: "账本落后于本地提交。增量分析还没有提供，请带 --full 做一次全量分析。", en: "The ledger is behind the local commit. Incremental analysis is not available yet: run again with --full." },
  needs_full_flag: { zh: "账本记录的提交和本地提交不在同一条历史上（比如切换了分支）。确认要以本地为准后，带 --full 发布。", en: "The ledger's commit and the local commit are not on the same line of history (a branch switch, perhaps). Run again with --full if the local commit should win." },
  ledger_ahead: { zh: "账本已经领先于本地提交。先把远端的变化拉到本地，再发布。", en: "The ledger is already ahead of the local commit. Pull the remote changes first." },
  ledger_commit_missing: { zh: "账本记录的提交不在本地仓库里（可能是浅克隆，或者仓库被重写过）。补齐历史，或确认后带 --full 发布。", en: "The commit recorded in the ledger is not in the local repository (a shallow clone, or history was rewritten). Fetch the history, or run again with --full if you are sure." },
} as const;
