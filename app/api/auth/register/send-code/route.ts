import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ChandlerAuthError, chandlerAuthStatus, sendChandlerRegisterCode } from "@/lib/chandler-auth";
import { AUTH_ERRORS } from "@/lib/ui-strings/dashboard";
import { pick } from "@/lib/ui-locale";

const sendCodeSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
});

export async function POST(request: NextRequest) {
  const parsed = sendCodeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS.invalid_input), code: "invalid_input" }, { status: 400 });
  try {
    await sendChandlerRegisterCode(parsed.data.email);
    return NextResponse.json({ status: "sent" });
  } catch (error) {
    if (error instanceof ChandlerAuthError) {
      return NextResponse.json({ error: pick("zh-CN", AUTH_ERRORS[error.code] ?? AUTH_ERRORS.unavailable), code: error.code }, { status: chandlerAuthStatus(error.code) });
    }
    throw error;
  }
}
