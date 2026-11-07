import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requiredEnv } from "./env";
import { createSessionToken, verifySessionToken } from "./session-token";
import type { SessionUser } from "./types";

export const SESSION_COOKIE = "codelphi_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

/** CoDelphi 下发的浏览器 cookie 统一属性：HttpOnly + 生产环境 Secure + Lax。 */
export function secureCookieOptions(maxAge: number, path = "/") {
  return {
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path,
    maxAge,
  };
}

export async function createSession(user: SessionUser) {
  const token = await createSessionToken(user, requiredEnv("SESSION_SECRET"), SESSION_MAX_AGE);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, secureCookieOptions(SESSION_MAX_AGE));
}

function sessionCookieValue(jar: { get(name: string): { value: string } | undefined }) {
  return jar.get(SESSION_COOKIE)?.value;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = sessionCookieValue(jar);
  const secret = process.env.SESSION_SECRET;
  if (!token || !secret) return null;
  return verifySessionToken(token, secret);
}

export async function requireSessionUser() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}
