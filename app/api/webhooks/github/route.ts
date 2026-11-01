import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requiredEnv } from "@/lib/env";
import { verifyGitHubSignature } from "@/lib/github";
import { queueAnalysis, runAnalysis } from "@/lib/analysis";

export const runtime = "nodejs";
export const maxDuration = 300;
const pushSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  repository: z.object({ full_name: z.string() }),
});

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyGitHubSignature(rawBody, signature, requiredEnv("GITHUB_WEBHOOK_SECRET"))) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  if (event === "ping") return NextResponse.json({ ok: true });
  if (event !== "push") return NextResponse.json({ ignored: true }, { status: 202 });

  const payload = pushSchema.parse(JSON.parse(rawBody));
  if (/^0+$/.test(payload.after)) return NextResponse.json({ ignored: "branch_deleted" }, { status: 202 });
  const [owner, name] = payload.repository.full_name.split("/");
  const db = getDb();
  const [rows] = await db.execute(
    "SELECT id, default_branch AS defaultBranch FROM repositories WHERE owner = ? AND name = ? LIMIT 1",
    [owner, name],
  );
  const repository = (rows as Array<{ id: number; defaultBranch: string }>)[0];
  if (!repository || payload.ref !== `refs/heads/${repository.defaultBranch}`) {
    return NextResponse.json({ ignored: "unregistered_repository_or_branch" }, { status: 202 });
  }

  const runId = await queueAnalysis(repository.id, payload.before, payload.after, "push");
  after(() => runAnalysis(runId));
  return NextResponse.json({ accepted: true, runId }, { status: 202 });
}
