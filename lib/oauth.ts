import { createHash, randomBytes } from "node:crypto";

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function safeNextPath(value: string | null | undefined) {
  if (!value) return "/";
  const invalid = [
    !value.startsWith("/"),
    value.startsWith("//"),
    value.includes("\\"),
    /[\r\n]/.test(value),
  ];
  if (invalid.some(Boolean)) return "/";
  const base = "https://codelphi.local";
  const parsed = new URL(value, base);
  return parsed.origin === base ? value : "/";
}
