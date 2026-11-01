import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { requiredEnv } from "./env";
import type { SessionUser } from "./types";

export const SESSION_COOKIE = "radar_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const sessionSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
});

function sessionKey() {
  return new TextEncoder().encode(requiredEnv("SESSION_SECRET"));
}

export async function createSession(user: SessionUser) {
  const token = await new SignJWT({ email: user.email, name: user.name, picture: user.picture })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.sub)
    .setIssuer("radar")
    .setAudience("radar-web")
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(sessionKey());

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !process.env.SESSION_SECRET) return null;

  try {
    const { payload } = await jwtVerify(token, sessionKey(), {
      issuer: "radar",
      audience: "radar-web",
    });
    return sessionSchema.parse(payload);
  } catch {
    return null;
  }
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
