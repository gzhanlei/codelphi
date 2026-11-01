import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requiredEnv } from "./env";
import { createSessionToken, hasSessionCredentials, verifySessionToken } from "./session-token";
import type { SessionUser } from "./types";

export const SESSION_COOKIE = "radar_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export async function createSession(user: SessionUser) {
  const token = await createSessionToken(user, requiredEnv("SESSION_SECRET"), SESSION_MAX_AGE);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

function sessionCookieValue(jar: { get(name: string): { value: string } | undefined }) {
  return jar.get(SESSION_COOKIE)?.value;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = sessionCookieValue(jar);
  if (!hasSessionCredentials(token, process.env.SESSION_SECRET)) return null;
  return verifySessionToken(token!, process.env.SESSION_SECRET!);
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
