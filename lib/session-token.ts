import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { SessionUser } from "./types";

const sessionSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
});

function key(secret: string) {
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(user: SessionUser, secret: string, maxAge = 60 * 60 * 24 * 7) {
  return new SignJWT({ email: user.email, name: user.name, picture: user.picture })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.sub)
    .setIssuer("codelphi")
    .setAudience("codelphi-web")
    .setIssuedAt()
    .setExpirationTime(`${maxAge}s`)
    .sign(key(secret));
}

export async function verifySessionToken(token: string, secret: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: "codelphi", audience: "codelphi-web" });
    return sessionSchema.parse(payload);
  } catch {
    return null;
  }
}
