import { after, NextRequest, NextResponse } from "next/server";
import { runAnalysis } from "@/lib/analysis";
import { processGitHubWebhook, resolveGitHubWebhookSecrets } from "@/lib/github-webhook";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const result = await processGitHubWebhook({
    rawBody: await request.text(),
    event: request.headers.get("x-github-event"),
    signature: request.headers.get("x-hub-signature-256"),
    secret: await resolveGitHubWebhookSecrets(),
  });
  const { runId } = result;
  if (runId) after(() => runAnalysis(runId));
  return NextResponse.json(result.body, { status: result.status });
}
