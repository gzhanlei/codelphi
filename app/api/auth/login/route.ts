import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertChandlerAllowed } from "@/lib/chandler";
import { ChandlerAuthError, chandlerAuthStatus, chandlerProfileFromAuthUser, establishCodelphiSession, loginChandlerUser } from "@/lib/chandler-auth";
import { allowedEmails } from "@/lib/env";
import { turnstileEnforced, verifyTurnstileToken } from "@/lib/turnstile-verify";
import { AUTH_ERRORS } from "@/lib/ui-strings/dashboard";
import { pick } from "@/lib/ui-locale";

const loginSchema = z.object({
  account: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(255),
  // CoDelphi 自有 Turnstile 启用时必带（客户端 widget 产出）；未启用时无此字段
  turnstileToken: z.string().max(2048).optional().default(""),
});

function clientIp(request: NextRequest): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || undefined;
}

export async function POST(request: NextRequest) {
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS.invalid_input), code: "invalid_input" }, { status: 400 });

  // 页面人机验证（信任合作伙伴模式）：CoDelphi 自有 widget 启用时在本路由 siteverify
  if (turnstileEnforced()) {
    const verdict = await verifyTurnstileToken(parsed.data.turnstileToken, "login", clientIp(request));
    if (!verdict.ok) {
      const status = verdict.code === "turnstile_unavailable" ? 503 : 403;
      return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS[verdict.code!]), code: verdict.code }, { status });
    }
  }

  try {
    const outcome = await loginChandlerUser({ account: parsed.data.account, password: parsed.data.password });
    if (outcome.mfaRequired) return NextResponse.json({ ok: false, mfaRequired: true, mfaToken: outcome.mfaToken });
    const profile = chandlerProfileFromAuthUser(outcome.user!);
    assertChandlerAllowed(profile.email, allowedEmails());
    await establishCodelphiSession(profile, outcome.tokens!);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ChandlerAuthError) {
      return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS[error.code] ?? AUTH_ERRORS.unavailable), code: error.code }, { status: chandlerAuthStatus(error.code) });
    }
    if (error instanceof Error && error.message === "forbidden") {
      return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS.forbidden), code: "forbidden" }, { status: 403 });
    }
    throw error;
  }
}
