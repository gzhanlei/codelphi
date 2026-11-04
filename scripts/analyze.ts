import "dotenv/config";
import { getDb } from "../lib/db";
import { queueAnalysis, runAnalysis } from "../lib/analysis";
import { resolveManualAnalysis } from "../lib/manual-analysis";

function targetSlug() {
  return process.argv[2] ?? "radar";
}

function errorSuffix(errorMessage?: string) {
  return errorMessage ? `: ${errorMessage}` : "";
}

async function reportResult(runId: number) {
  const [runs] = await getDb().execute("SELECT status, error_message AS errorMessage FROM analysis_runs WHERE id = ?", [runId]);
  const run = (runs as Array<{ status: string; errorMessage?: string }>)[0];
  console.log(`Analysis ${run.status}${errorSuffix(run.errorMessage)}`);
  if (run.status !== "succeeded") process.exitCode = 1;
}

async function analyze() {
  const slug = targetSlug();
  const db = getDb();
  try {
    const analysis = await resolveManualAnalysis(slug);
    if (!analysis) throw new Error(`No repository registered for ${slug}; run npm run db:seed first`);
    const runId = await queueAnalysis(analysis.repositoryId, null, analysis.afterSha, "manual");
    console.log(`Analysis run ${runId} started for ${slug}@${analysis.afterSha.slice(0, 7)}`);
    await runAnalysis(runId);
    await reportResult(runId);
  } finally {
    await db.end();
  }
}

analyze().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
