function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function manifestDocument(manifest: unknown, state: string) {
  const json = escapeHtml(JSON.stringify(manifest));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>创建 Radar GitHub App</title></head><body style="font-family:system-ui;max-width:640px;margin:80px auto;padding:24px"><h1>创建 Radar GitHub App</h1><p>将继续到 GitHub 创建应用。Radar 请求 Contents 和 Metadata 读取权限用于分析代码规格；请求 Pull requests 权限用于在 PR 中预演受影响的规格，并接收所选仓库的 Push 与 Pull request 通知。</p><form action="https://github.com/settings/apps/new?state=${escapeHtml(encodeURIComponent(state))}" method="post"><input type="hidden" name="manifest" value="${json}"><button type="submit" style="padding:12px 18px">前往 GitHub 创建 App</button></form></body></html>`;
}

export function manifestCallbackAllowed({ code, state, expectedState }: { code: string | null; state: string | null; expectedState?: string }) {
  return Boolean(code && state && expectedState && state === expectedState);
}
