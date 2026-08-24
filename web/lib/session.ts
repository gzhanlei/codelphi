import { cookies } from "next/headers";

export const COOKIE_AT = "cd_at";
export const COOKIE_RT = "cd_rt";
export const COOKIE_ORG = "cd_org";
export const COOKIE_PKCE = "cd_pkce";
export const COOKIE_STATE = "cd_state";

const week = 60 * 60 * 24 * 7;

export function cookieOpts(maxAge = week) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export async function getAccessToken(): Promise<string | undefined> {
  return (await cookies()).get(COOKIE_AT)?.value;
}

export async function getOrgId(): Promise<string | undefined> {
  return (await cookies()).get(COOKIE_ORG)?.value;
}
