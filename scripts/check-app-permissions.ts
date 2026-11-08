import "dotenv/config";
import { createAppJwt } from "../lib/github-app";
import { getLatestGitHubApp } from "../lib/github-integrations";

/**
 * 运维检查：用 App JWT 查询每个安装当前已批准的权限（GET /app/installations）。
 * 用于权限升级（如 Checks: write）后确认安装方是否已完成 Accept：
 * Save 后未 Accept 的安装，permissions 里不会出现新权限。
 */
async function main() {
  const app = await getLatestGitHubApp();
  if (!app) throw new Error("No GitHub App registered");
  const response = await fetch("https://api.github.com/app/installations?per_page=100", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${await createAppJwt(app)}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "codelphi-chandler",
    },
  });
  if (!response.ok) throw new Error(`GitHub App API ${response.status}: ${await response.text()}`);
  const installations = (await response.json()) as Array<{
    id: number;
    app_slug: string;
    account: { login: string; type: string };
    permissions?: Record<string, string>;
    suspended_at?: string | null;
  }>;
  if (installations.length === 0) {
    console.log("没有任何安装。");
    return;
  }
  for (const installation of installations) {
    const granted = installation.permissions ?? {};
    console.log(`${installation.account.login}（${installation.account.type}）installation=${installation.id} slug=${installation.app_slug}${installation.suspended_at ? " · 已被暂停" : ""}`);
    console.log(`  已批准权限: ${JSON.stringify(granted)}`);
    console.log(`  checks: ${granted.checks ?? "未授予 —— 说明安装方尚未 Accept 新权限（入口见 README PR 预演权限升级节）"}`);
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
