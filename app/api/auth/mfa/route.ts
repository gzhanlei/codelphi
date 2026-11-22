import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertChandlerAllowed } from "@/lib/chandler";
import { ChandlerAuthError, chandlerAuthStatus, chandlerProfileFromAuthUser, establishCodelphiSession, verifyChandlerMfa } from "@/lib/chandler-auth";
import { allowedEmails } from "@/lib/env";
import { AUTH_ERRORS } from "@/lib/ui-strings/dashboard";
import { pick } from "@/lib/ui-locale";

const mfaSchema = z.object({
  mfaToken: z.string().min(1).max(512),
  code: z.string().trim().min(4).max(10),
});

export async function POST(request: NextRequest) {
  const parsed = mfaSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS.invalid_input), code: "invalid_input" }, { status: 400 });
  try {
    const outcome = await verifyChandlerMfa({ mfaToken: parsed.data.mfaToken, code: parsed.data.code });
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
