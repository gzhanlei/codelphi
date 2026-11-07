import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { randomToken } from "./oauth";

const installationStateSchema = z.object({ organizationId: z.number().int().positive(), appId: z.number().int().positive() });

function key(secret: string) {
  return new TextEncoder().encode(secret);
}

export function createGitHubInstallationState(organizationId: number, appId: number, secret: string) {
  return new SignJWT({ organizationId, appId, nonce: randomToken(12) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("codelphi")
    .setAudience("codelphi-github-installation")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key(secret));
}

export async function verifyGitHubInstallationState(
  state: string | null,
  expectedState: string | undefined,
  organizationId: number,
  appId: number,
  secret: string,
) {
  if (!state || !expectedState || state !== expectedState) return false;
  try {
    const { payload } = await jwtVerify(state, key(secret), { issuer: "codelphi", audience: "codelphi-github-installation" });
    const verified = installationStateSchema.parse(payload);
    return verified.organizationId === organizationId && verified.appId === appId;
  } catch {
    return false;
  }
}
