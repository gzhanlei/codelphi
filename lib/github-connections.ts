import { getAppInstallation } from "./github-app";
import { getConnectionWithApp, saveInstallation, setConnectionStatus } from "./github-integrations";

export async function checkGitHubConnection(id: number, organizationId: number) {
  const connection = await getConnectionWithApp(id, organizationId);
  if (!connection) return { status: 404, body: { error: "connection_not_found" } };
  try {
    const installation = await getAppInstallation(connection, connection.installationId);
    await saveInstallation(connection.id, installation, connection.organizationId);
    return { status: 200, body: { status: "active" } };
  } catch (error) {
    await setConnectionStatus(connection.connectionId, "disconnected", organizationId);
    return { status: 503, body: { status: "disconnected", error: error instanceof Error ? error.message : "connection_check_failed" } };
  }
}
