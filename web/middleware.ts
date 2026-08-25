import { NextRequest, NextResponse } from "next/server";
import { COOKIE_AT } from "@/lib/session";

const publicPaths = ["/login", "/auth/callback", "/auth/start", "/auth/logout", "/auth/dev"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (publicPaths.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/_next") || pathname.startsWith("/media") || pathname.includes(".")) {
    return NextResponse.next();
  }
  if (!req.cookies.get(COOKIE_AT)?.value) {
    const origin = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;
    return NextResponse.redirect(new URL("/login", origin));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
