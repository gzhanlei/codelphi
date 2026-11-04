import "dotenv/config";
import { getDb } from "../lib/db";
import { queueAnalysis, runAnalysis } from "../lib/analysis";
import { getCodeHostingAdapter, type CodeHostingProvider } from "../lib/code-hosting";

function targetSlug() {
  return process.argv[2] ?? "radar";
}

async function findRepository(slug: string) {
  const [rows] = await getDb().execute(
    `SELECT r.id, r.provider, r.owner, r.name, r.default_branch AS defaultBranch
     FROM repositories r JOIN products p ON p.id = r.product_id WHERE p.slug = ? LIMIT 1`,
    [slug],
  );
  const repository = (rows as Array<{ id: number; provider: CodeHostingProvider; owner: string; name: string; defaultBranch: string }>)[0];
  if (!repository) throw new Error(`No repository registered for ${slug}; run npm run db:seed first`);
  return repository;
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
    const repository = await findRepository(slug);
    const adapter = getCodeHostingAdapter(repository.provider);
    const metadata = await adapter.getRepository(repository, {});
    const afterSha = await adapter.getBranchHead({ ...repository, ...metadata }, {});
    const runId = await queueAnalysis(repository.id, null, afterSha, "manual");
    console.log(`Analysis run ${runId} started for ${slug}@${afterSha.slice(0, 7)}`);
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
