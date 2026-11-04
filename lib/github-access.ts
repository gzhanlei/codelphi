import { getInstallationAccessToken } from "./github-app";
import { getConnectionWithApp } from "./github-integrations";
import { requiredEnv } from "./env";
import type { RepositoryAccess } from "./code-hosting/types";

export type GitHubAccess = RepositoryAccess;

interface Connection {
  installationId: number;
  status: string;
  clientId: string;
  pem: string;
}

interface Dependencies {
  loadConnection: (id: number, organizationId: number) => Promise<Connection>;
  issueToken: (app: Connection, installationId: number) => Promise<{ token: string; expiresAt: string }>;
}

const defaultDependencies: Dependencies = {
  loadConnection: async (id, organizationId) => {
    const connection = await getConnectionWithApp(id, organizationId);
    if (!connection) throw new Error("GitHub installation was not found");
    return connection;
  },
  issueToken: getInstallationAccessToken,
};

const cache = new Map<string, { token: string; expiresAt: number }>();

export function clearGitHubTokenCache() {
  cache.clear();
}

async function installationToken(connectionId: number, organizationId: number, dependencies: Dependencies) {
  const cacheKey = `${organizationId}:${connectionId}`;
  const cached = cache.get(cacheKey);
  const connection = await dependencies.loadConnection(connectionId, organizationId);
  if (connection.status !== "active") throw new Error("GitHub installation is disconnected");
  if (cached && cached.expiresAt - Date.now() > 300_000) return cached.token;
  const issued = await dependencies.issueToken(connection, connection.installationId);
  cache.set(cacheKey, { token: issued.token, expiresAt: Date.parse(issued.expiresAt) });
  return issued.token;
}

export async function resolveGitHubToken(access: GitHubAccess = {}, dependencies: Dependencies = defaultDependencies) {
  if (access.token) return access.token;
  if (access.connectionId !== undefined && access.connectionId !== null) {
    if (!Number.isInteger(access.organizationId) || (access.organizationId ?? 0) <= 0) throw new Error("GitHub installation organization is required");
    return installationToken(access.connectionId, access.organizationId!, dependencies);
  }
  return requiredEnv("GITHUB_TOKEN");
}
