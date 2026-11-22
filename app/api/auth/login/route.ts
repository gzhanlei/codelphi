import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertChandlerAllowed } from "@/lib/chandler";
import { ChandlerAuthError, chandlerAuthStatus, chandlerProfileFromAuthUser, establishCodelphiSession, loginChandlerUser } from "@/lib/chandler-auth";
import { allowedEmails } from "@/lib/env";
import { resolveTurnstileSiteKey } from "@/lib/turnstile-site-key";
import { AUTH_ERRORS } from "@/lib/ui-strings/dashboard";
import { pick } from "@/lib/ui-locale";

const loginSchema = z.object({
  account: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(255),
  turnstileToken: z.string().max(2048).optional().default(""),
});

export async function POST(request: NextRequest) {
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS.invalid_input), code: "invalid_input" }, { status: 400 });
  if ((await resolveTurnstileSiteKey()) && !parsed.data.turnstileToken) {
    return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS.missing_turnstile_token), code: "missing_turnstile_token" }, { status: 400 });
  }

  try {
    const outcome = await loginChandlerUser(parsed.data);
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
