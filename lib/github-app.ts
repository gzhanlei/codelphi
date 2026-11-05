import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";
import { z } from "zod";

export interface GitHubAppIdentity {
  clientId: string;
  pem: string;
}

interface GitHubAppCredentials extends GitHubAppIdentity {
  appId: number;
  slug: string;
  clientSecret: string;
  webhookSecret?: string;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function webhookConfiguration(appUrl: string) {
  const baseUrl = appUrl.replace(/\/$/, "");
  return { hook_attributes: { url: `${baseUrl}/api/webhooks/github`, active: true }, default_events: ["push"] };
}

export function radarManifest(appUrl: string) {
  const redirectUrl = `${appUrl}/integrations/github/callback`;
  return {
    name: "Radar Product Observer",
    description: "Read product code and maintain traceable specifications and behavior changes.",
    url: appUrl,
    public: false,
    redirect_url: redirectUrl,
    callback_urls: [redirectUrl],
    setup_url: `${appUrl}/integrations/github/setup`,
    ...webhookConfiguration(appUrl),
    default_permissions: { contents: "read", metadata: "read" },
  };
}

const conversionSchema = z.object({
  id: z.number(),
  slug: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
  pem: z.string(),
  webhook_secret: z.string().optional().nullable(),
});

export async function convertManifestCode(code: string, fetcher: Fetcher = fetch): Promise<GitHubAppCredentials> {
  const response = await fetcher(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST" });
  if (!response.ok) throw new Error(`GitHub App conversion failed: ${response.status}`);
  const data = conversionSchema.parse(await response.json());
  return {
    appId: data.id,
    slug: data.slug,
    clientId: data.client_id,
    clientSecret: data.client_secret,
    pem: data.pem,
    webhookSecret: data.webhook_secret ?? undefined,
  };
}

export async function createAppJwt(app: GitHubAppIdentity, now = Math.floor(Date.now() / 1000)) {
  const key = createPrivateKey(app.pem);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(app.clientId)
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 540)
    .sign(key);
}

async function appApiFetch(app: GitHubAppIdentity, path: string, init: RequestInit = {}, fetcher: Fetcher = fetch) {
  const response = await fetcher(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${await createAppJwt(app)}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub App API ${response.status}: ${await response.text()}`);
  return response.json() as Promise<unknown>;
}

const installationTokenSchema = z.object({ token: z.string(), expires_at: z.string() });

export async function getInstallationAccessToken(app: GitHubAppIdentity, installationId: number, fetcher: Fetcher = fetch) {
  const data = installationTokenSchema.parse(await appApiFetch(app, `/app/installations/${installationId}/access_tokens`, { method: "POST" }, fetcher));
  return { token: data.token, expiresAt: data.expires_at };
}

const installationSchema = z.object({
  id: z.number(),
  account: z.object({ login: z.string(), type: z.string() }),
  suspended_at: z.string().nullable().optional(),
});

export async function getAppInstallation(app: GitHubAppIdentity, installationId: number, fetcher: Fetcher = fetch) {
  const installation = installationSchema.parse(await appApiFetch(app, `/app/installations/${installationId}`, {}, fetcher));
  if (installation.suspended_at) throw new Error("GitHub installation is suspended");
  return installation;
}
