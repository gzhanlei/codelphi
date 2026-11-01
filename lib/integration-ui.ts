export function integrationFeedback(error: string | undefined, success: string | undefined, messages: Record<string, string>) {
  const key = error ?? success;
  return { text: key ? messages[key] : undefined, isError: Boolean(error) };
}

export function integrationMessageClass(isError: boolean) {
  return `integration-message ${isError ? "error" : "success"}`;
}

export function manifestCallbackPath(error: string | null) {
  return error ? `/integrations?error=${error}` : "/integrations/github/install";
}

export function connectionStatusLabel(status: string) {
  return status === "active" ? "已连接" : "已断开";
}

export function hasProductCredentials(connections: Array<{ id: number }>, hasServerToken: boolean) {
  return hasServerToken || connections.length > 0;
}

function stateFor<T>(condition: boolean, positive: T, negative: T) {
  return condition ? positive : negative;
}

export function patPresentation(configured: boolean) {
  return stateFor(configured,
    { disabled: false, className: "connection-status active", label: "已配置", optionLabel: "Personal Access Token 回退" },
    { disabled: true, className: "connection-status disconnected", label: "未配置", optionLabel: "选择 GitHub App 安装" },
  );
}

export function parseConnectionId(value: string) {
  return value ? Number(value) : null;
}
