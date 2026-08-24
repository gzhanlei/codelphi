import { NextRequest, NextResponse } from "next/server";
import { COOKIE_AT, COOKIE_ORG } from "@/lib/session";

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await ctx.params, undefined);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await ctx.params, await req.arrayBuffer());
}

async function proxy(req: NextRequest, params: { path: string[] }, body?: ArrayBuffer) {
  const token = req.cookies.get(COOKIE_AT)?.value;
  if (!token) {
    return NextResponse.json({ error: { code: "missing_token", message: "未登录" } }, { status: 401 });
  }
  const gw = process.env.GATEWAY_URL || "http://127.0.0.1:18080";
  const path = "/" + params.path.join("/");
  const search = req.nextUrl.search;
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  const org = req.headers.get("x-org-id") || req.cookies.get(COOKIE_ORG)?.value;
  if (org) headers.set("X-Org-Id", org);
  const ct = req.headers.get("content-type");
  if (ct) headers.set("Content-Type", ct);
  const res = await fetch(`${gw}${path}${search}`, {
    method: req.method,
    headers,
    body: body && req.method !== "GET" ? body : undefined,
    cache: "no-store",
  });
  const outHeaders = new Headers();
  const resCT = res.headers.get("content-type");
  if (resCT) outHeaders.set("content-type", resCT);
  return new NextResponse(res.body, { status: res.status, headers: outHeaders });
}
