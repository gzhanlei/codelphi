import { getAppInstallation } from "./github-app";
import { getConnectionWithApp, saveInstallation, setConnectionStatus } from "./github-integrations";

/**
 * 仅权威性「安装已不存在/被吊销」错误才置 disconnected：appApiFetch 的错误首行带状态码
 * （`GitHub App API {status}: …`），suspended 是显式安装态。瞬时故障（超时/5xx/本地 DB
 * 错误）保持原状态——一旦误标 disconnected，installationToken 的发放校验会封锁该工作区
 * 全部 push/手动分析，且没有自动恢复路径。
 */
function isAuthoritativeInstallationGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /GitHub App API (401|404):/i.test(message) || /installation is suspended/i.test(message);
}

export async function checkGitHubConnection(id: number, organizationId: number) {
  const connection = await getConnectionWithApp(id, organizationId);
  if (!connection) return { status: 404, body: { error: "connection_not_found" } };
  try {
    const installation = await getAppInstallation(connection, connection.installationId);
    await saveInstallation(connection.id, installation, connection.organizationId);
    return { status: 200, body: { status: "active" } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "connection_check_failed";
    if (isAuthoritativeInstallationGone(error)) {
      await setConnectionStatus(connection.connectionId, "disconnected", organizationId);
      return { status: 503, body: { status: "disconnected", error: message } };
    }
    // 瞬时故障：如实回传当前存储状态，不改变连接生命周期
    return { status: 503, body: { status: connection.status, error: message } };
  }
}
