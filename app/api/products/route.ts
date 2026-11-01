import { after, NextRequest, NextResponse } from "next/server";
import { runAnalysis } from "@/lib/analysis";
import { productInputSchema } from "@/lib/product-input";
import { queueRegistrationAnalysis, registerProduct, registrationError } from "@/lib/product-registration";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 300;

function scheduleAnalysis(runId: number | null) {
  if (runId) after(() => runAnalysis(runId));
}

export async function POST(request: NextRequest) {
  await requireSessionUser();
  try {
    const registration = await registerProduct(productInputSchema.parse(await request.json()));
    const runId = await queueRegistrationAnalysis(registration);
    scheduleAnalysis(runId);
    return NextResponse.json({ slug: registration.slug, runId }, { status: 201 });
  } catch (error) {
    const { status, message } = registrationError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
