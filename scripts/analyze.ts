import "dotenv/config";
import { getDb } from "../lib/db";
import { queueAnalysis, runAnalysis } from "../lib/analysis";
import { getBranchHead, getRepository } from "../lib/github";

async function analyze() {
  const slug = process.argv[2] ?? "radar";
  const db = getDb();
  try {
    const [rows] = await db.execute(
      `SELECT r.id, r.owner, r.name, r.default_branch AS defaultBranch
       FROM repositories r JOIN products p ON p.id = r.product_id WHERE p.slug = ? LIMIT 1`,
      [slug],
    );
    const repository = (rows as Array<{ id: number; owner: string; name: string; defaultBranch: string }>)[0];
    if (!repository) throw new Error(`No repository registered for ${slug}; run npm run db:seed first`);

    const metadata = await getRepository(repository);
    const afterSha = await getBranchHead({ ...repository, ...metadata });
    const runId = await queueAnalysis(repository.id, null, afterSha, "manual");
    console.log(`Analysis run ${runId} started for ${slug}@${afterSha.slice(0, 7)}`);
    await runAnalysis(runId);
    const [runs] = await db.execute("SELECT status, error_message AS errorMessage FROM analysis_runs WHERE id = ?", [runId]);
    const run = (runs as Array<{ status: string; errorMessage?: string }>)[0];
    console.log(`Analysis ${run.status}${run.errorMessage ? `: ${run.errorMessage}` : ""}`);
    if (run.status !== "succeeded") process.exitCode = 1;
  } finally {
    await db.end();
  }
}

analyze().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
