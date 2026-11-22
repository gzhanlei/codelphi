import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertChandlerAllowed } from "@/lib/chandler";
import { ChandlerAuthError, chandlerAuthStatus, chandlerProfileFromAuthUser, establishCodelphiSession, registerChandlerUser } from "@/lib/chandler-auth";
import { allowedEmails } from "@/lib/env";
import { resolveTurnstileSiteKey } from "@/lib/turnstile-site-key";
import { AUTH_ERRORS } from "@/lib/ui-strings/dashboard";
import { pick } from "@/lib/ui-locale";

// display_name 上限 100 字节（CJK 3 字节/字）→ 33 字符保守上限，超限由 Chandler 复核
const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  code: z.string().trim().min(4).max(10),
  password: z.string().min(8).max(255),
  displayName: z.string().trim().max(33).optional().default(""),
  agreePolicies: z.boolean().optional().default(false),
  turnstileToken: z.string().max(2048).optional().default(""),
});

export async function POST(request: NextRequest) {
  const parsed = registerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS.invalid_input), code: "invalid_input" }, { status: 400 });
  if ((await resolveTurnstileSiteKey()) && !parsed.data.turnstileToken) {
    return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS.missing_turnstile_token), code: "missing_turnstile_token" }, { status: 400 });
  }

  try {
    const outcome = await registerChandlerUser({
      email: parsed.data.email,
      password: parsed.data.password,
      displayName: parsed.data.displayName || undefined,
      emailCode: parsed.data.code,
      turnstileToken: parsed.data.turnstileToken,
      agreePolicies: parsed.data.agreePolicies,
    });
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
