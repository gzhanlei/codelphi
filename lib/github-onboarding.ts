import { convertManifestCode, getAppInstallation, type GitHubAppIdentity } from "./github-app";
import { getLatestGitHubApp, saveGitHubApp, saveInstallation } from "./github-integrations";
import { manifestCallbackAllowed } from "./github-manifest";

interface ManifestDependencies {
  convert: typeof convertManifestCode;
  save: (credentials: Awaited<ReturnType<typeof convertManifestCode>>) => Promise<unknown>;
}

export async function completeManifest(code: string | null, state: string | null, expectedState: string | undefined, dependencies: ManifestDependencies = { convert: convertManifestCode, save: saveGitHubApp }) {
  if (!manifestCallbackAllowed({ code, state, expectedState })) return "manifest_state";
  try {
    await dependencies.save(await dependencies.convert(code!));
    return null;
  } catch {
    return "conversion_failed";
  }
}

interface InstallationDependencies {
  getLatest: () => Promise<(GitHubAppIdentity & { id: number }) | null>;
  getInstallation: (app: GitHubAppIdentity, installationId: number) => Promise<{ id: number; account: { login: string; type: string } }>;
  save: (appId: number, installation: { id: number; account: { login: string; type: string } }, organizationId: number) => Promise<unknown>;
}

export async function completeInstallationSetup(installationId: number, organizationOrDependencies: number | InstallationDependencies = 1, maybeDependencies?: InstallationDependencies) {
  const organizationId = typeof organizationOrDependencies === "number" ? organizationOrDependencies : 1;
  const dependencies = typeof organizationOrDependencies === "number" ? maybeDependencies! : organizationOrDependencies;
  if (!Number.isInteger(installationId) || installationId <= 0) return "installation_id";
  try {
    const app = await dependencies.getLatest();
    if (!app) return "app_missing";
    const installation = await dependencies.getInstallation(app, installationId);
    await dependencies.save(app.id, installation, organizationId);
    return null;
  } catch {
    return "installation_failed";
  }
}
