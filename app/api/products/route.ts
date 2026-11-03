import { after, NextRequest, NextResponse } from "next/server";
import { runAnalysis } from "@/lib/analysis";
import { productInputSchema } from "@/lib/product-input";
import { queueRegistrationAnalysis, registerProduct, registrationError } from "@/lib/product-registration";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export const runtime = "nodejs";
export const maxDuration = 300;

function scheduleAnalysis(runId: number | null) {
  if (runId) after(() => runAnalysis(runId));
}

export async function POST(request: NextRequest) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  try {
    const registration = await registerProduct({ ...productInputSchema.parse(await request.json()), organizationId: organization.id });
    const runId = await queueRegistrationAnalysis(registration);
    scheduleAnalysis(runId);
    return NextResponse.json({ slug: registration.slug, runId }, { status: 201 });
  } catch (error) {
    const { status, message } = registrationError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
