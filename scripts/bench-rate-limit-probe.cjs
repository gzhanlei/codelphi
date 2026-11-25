#!/usr/bin/env node
/** Task 11 rate-limit 探针 v2：直接请求 GitHub API 仓库元数据端点，
 *  用 bench 库里 connection 行的 installation 记录换 App 安装令牌（走 lib 链路）。
 *  RATE-OK = 配额恢复；RATE-LIMITED = 仍在窗口内。不打印凭证。 */
async function main() {
  process.env.NODE_ENV = "production";
  const mod = await import("/data/www/codelphi-bench/app/lib/github-access.ts");
  const token = await mod.resolveGitHubToken({ organizationId: 1, connectionId: 1 });
  if (!token) {
    console.log("NO-TOKEN");
    process.exit(1);
  }
  const response = await fetch("https://api.github.com/repos/gzhanlei/codelphi", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  if (response.status === 200) {
    const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
    console.log(`RATE-OK remaining=${remaining} reset=${resetAt}`);
    process.exit(0);
  }
  const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
  console.log(`RATE-LIMITED status=${response.status} remaining=${remaining} reset=${resetAt}`);
  process.exit(1);
}
main().catch((error) => {
  console.log("PROBE-CRASHED:", String(error).slice(0, 160));
  process.exit(1);
});
