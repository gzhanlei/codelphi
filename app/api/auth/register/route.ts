import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertChandlerAllowed } from "@/lib/chandler";
import { ChandlerAuthError, chandlerAuthStatus, chandlerProfileFromAuthUser, establishCodelphiSession, registerChandlerUser } from "@/lib/chandler-auth";
import { allowedEmails } from "@/lib/env";
import { turnstileEnforced, verifyTurnstileToken } from "@/lib/turnstile-verify";
import { AUTH_ERRORS } from "@/lib/ui-strings/dashboard";
import { pick } from "@/lib/ui-locale";

// display_name 上限 100 字节（CJK 3 字节/字）→ 33 字符保守上限，超限由 Chandler 复核
const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  code: z.string().trim().min(4).max(10),
  password: z.string().min(8).max(255),
  displayName: z.string().trim().max(33).optional().default(""),
  agreePolicies: z.boolean().optional().default(false),
  // CoDelphi 自有 Turnstile 启用时必带（客户端 widget 产出）；未启用时无此字段
  turnstileToken: z.string().max(2048).optional().default(""),
});

function clientIp(request: NextRequest): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || undefined;
}

export async function POST(request: NextRequest) {
  const parsed = registerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS.invalid_input), code: "invalid_input" }, { status: 400 });

  // 页面人机验证（信任合作伙伴模式）：CoDelphi 自有 widget 启用时在本路由 siteverify
  if (turnstileEnforced()) {
    const verdict = await verifyTurnstileToken(parsed.data.turnstileToken, "register", clientIp(request));
    if (!verdict.ok) {
      const status = verdict.code === "turnstile_unavailable" ? 503 : 403;
      return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS[verdict.code!]), code: verdict.code }, { status });
    }
  }

  try {
    const outcome = await registerChandlerUser({
      email: parsed.data.email,
      password: parsed.data.password,
      displayName: parsed.data.displayName || undefined,
      emailCode: parsed.data.code,
      agreePolicies: parsed.data.agreePolicies,
    });
    const profile = chandlerProfileFromAuthUser(outcome.user!);
    assertChandlerAllowed(profile.email, allowedEmails());
    await establishCodelphiSession(profile, outcome.tokens!);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ChandlerAuthError) {
      // 注册链路的 invalid_credentials = 邮箱验证码错误/过期（Chandler 防枚举复用同一哨兵，
      // auth/service.go Register → otpSvc.Verify）；密码强度、邮箱占用各有专属错误码
      if (error.code === "invalid_credentials") {
        return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS.email_code_invalid), code: "email_code_invalid" }, { status: 400 });
      }
      return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS[error.code] ?? AUTH_ERRORS.unavailable), code: error.code }, { status: chandlerAuthStatus(error.code) });
    }
    if (error instanceof Error && error.message === "forbidden") {
      return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS.forbidden), code: "forbidden" }, { status: 403 });
    }
    throw error;
  }
}
