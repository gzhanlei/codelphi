import { z } from "zod";
import { chandlerBaseUrl, requiredEnv } from "./env";
import type { SessionUser } from "./types";

const tokenSchema = z.object({ access_token: z.string().min(1) });
const profileSchema = z.object({
  sub: z.string().min(1),
  email: z.string().max(320).optional().nullable(),
  name: z.string().optional().nullable(),
  picture: z.string().optional().nullable(),
});

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface OAuthInput {
  code: string;
  verifier: string;
  redirectUri: string;
}

function unwrap(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "data" in value) {
    return (value as { data: unknown }).data;
  }
  return value;
}

export function isChandlerEmailAllowed(email: string | undefined, allowlist: Set<string>, isProduction: boolean) {
  if (allowlist.size === 0) return !isProduction;
  return Boolean(email && allowlist.has(email.toLowerCase()));
}

export function assertChandlerAllowed(email: string | undefined, allowlist: Set<string>, isProduction: boolean) {
  if (!isChandlerEmailAllowed(email, allowlist, isProduction)) throw new Error("forbidden");
}

export async function completeChandlerOAuth(input: OAuthInput, fetcher: Fetcher = fetch): Promise<SessionUser> {
  const tokenResponse = await fetcher(`${chandlerBaseUrl()}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: requiredEnv("CHANDLER_CLIENT_ID"),
      client_secret: requiredEnv("CHANDLER_CLIENT_SECRET"),
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) throw new Error("token_exchange_failed");
  const token = tokenSchema.parse(unwrap(await tokenResponse.json()));

  const userInfoResponse = await fetcher(`${chandlerBaseUrl()}/v1/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!userInfoResponse.ok) throw new Error("userinfo_failed");
  const profile = profileSchema.parse(unwrap(await userInfoResponse.json()));
  const email = profile.email?.trim() ? profile.email.trim().toLowerCase() : undefined;
  return {
    sub: profile.sub,
    email,
    name: profile.name ?? undefined,
    picture: profile.picture ?? undefined,
  };
}
