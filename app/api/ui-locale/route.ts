import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { UI_LOCALE_COOKIE } from "@/lib/ui-locale";

export const runtime = "nodejs";

const schema = z.object({
  locale: z.enum(["zh-CN", "en"]),
  // 反斜杠必须显式拒绝：WHATWG URL 在 special scheme 下把 `\` 归一为 `/`，
  // `/\evil.com` 会绕过 `^(?!//)` 校验变成跨站重定向（开放重定向钓鱼跳板）
  redirectTo: z.string().regex(/^\/(?!\/)/, "redirect target must be a same-origin path").refine((v) => !v.includes("\\"), "redirect target must be a same-origin path").max(2_000),
});

/** 界面语言切换：写 cookie（一年期、非 HttpOnly、SameSite=Lax）并重定向回原页。
 *  与分析输出语言无关——这是浏览器侧的界面偏好。 */
export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid locale switch" }, { status: 400 });
  const response = NextResponse.redirect(new URL(parsed.data.redirectTo, request.nextUrl.origin), { status: 303 });
  response.cookies.set(UI_LOCALE_COOKIE, parsed.data.locale, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
