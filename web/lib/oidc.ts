import { createHash, randomBytes } from "crypto";

const AUTHORIZE = "https://api.chandler.work/v1/oauth/authorize";
const TOKEN = "https://api.chandler.work/v1/oauth/token";

export function appURL() {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export function redirectURI() {
  return `${appURL()}/auth/callback`;
}

export function newPKCE() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  return { verifier, challenge, state };
}

export function authorizeURL(challenge: string, state: string) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: process.env.CHANDLER_CLIENT_ID || "",
    redirect_uri: redirectURI(),
    scope: "openid profile email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE}?${q.toString()}`;
}

export async function exchangeCode(code: string, verifier: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectURI(),
    client_id: process.env.CHANDLER_CLIENT_ID || "",
    client_secret: process.env.CHANDLER_CLIENT_SECRET || "",
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token exchange ${res.status}: ${text}`);
  }
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type: string;
  };
}
