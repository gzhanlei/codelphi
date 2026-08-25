import { NextRequest, NextResponse } from "next/server";
import { COOKIE_AT, cookieOpts } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production" || process.env.DEV_AUTH !== "1") {
    return new NextResponse("not found", { status: 404 });
  }
  const res = NextResponse.redirect(new URL("/projects", req.nextUrl.origin));
  res.cookies.set(COOKIE_AT, "dev", cookieOpts());
  return res;
}
