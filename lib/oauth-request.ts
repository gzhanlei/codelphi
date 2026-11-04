import { safeNextPath } from "./oauth";

interface OAuthCallbackValues {
  code: string | null;
  state: string | null;
  expectedState?: string;
  verifier?: string;
  next: string | null | undefined;
}

export function parseOAuthCallback(values: OAuthCallbackValues) {
  if (!values.code || !values.verifier) return null;
  const invalid = [
    !values.state,
    !values.expectedState,
    values.state !== values.expectedState,
  ];
  if (invalid.some(Boolean)) return null;
  return { code: values.code, verifier: values.verifier, next: safeNextPath(values.next) };
}

export function oauthErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return ["invalid_oauth_state", "token_exchange_failed", "userinfo_failed"].includes(message) ? message : "userinfo_failed";
}

export function requireOAuthCallback(values: OAuthCallbackValues) {
  const input = parseOAuthCallback(values);
  if (!input) throw new Error("invalid_oauth_state");
  return input;
}

export function oauthFailurePath(error: unknown) {
  if (error instanceof Error && error.message === "forbidden") return "/forbidden";
  return `/login?error=${oauthErrorCode(error)}`;
}
