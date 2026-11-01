import { getInstallationAccessToken } from "./github-app";
import { getConnectionWithApp } from "./github-integrations";
import { requiredEnv } from "./env";

export interface GitHubAccess {
  token?: string;
  connectionId?: number | null;
}

interface Connection {
  installationId: number;
  status: string;
  clientId: string;
  pem: string;
}

interface Dependencies {
  loadConnection: (id: number) => Promise<Connection>;
  issueToken: (app: Connection, installationId: number) => Promise<{ token: string; expiresAt: string }>;
}

const defaultDependencies: Dependencies = {
  loadConnection: async (id) => {
    const connection = await getConnectionWithApp(id);
    if (!connection) throw new Error("GitHub installation was not found");
    return connection;
  },
  issueToken: getInstallationAccessToken,
};

const cache = new Map<number, { token: string; expiresAt: number }>();

export function clearGitHubTokenCache() {
  cache.clear();
}

async function installationToken(connectionId: number, dependencies: Dependencies) {
  const cached = cache.get(connectionId);
  if (cached && cached.expiresAt - Date.now() > 300_000) return cached.token;
  const connection = await dependencies.loadConnection(connectionId);
  if (connection.status !== "active") throw new Error("GitHub installation is disconnected");
  const issued = await dependencies.issueToken(connection, connection.installationId);
  cache.set(connectionId, { token: issued.token, expiresAt: Date.parse(issued.expiresAt) });
  return issued.token;
}

export async function resolveGitHubToken(access: GitHubAccess = {}, dependencies: Dependencies = defaultDependencies) {
  if (access.token) return access.token;
  if (access.connectionId !== undefined && access.connectionId !== null) {
    return installationToken(access.connectionId, dependencies);
  }
  return requiredEnv("GITHUB_TOKEN");
}
