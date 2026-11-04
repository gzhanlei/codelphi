import { z } from "zod";
import { queueAnalysis } from "./analysis";
import { getDb } from "./db";
import { verifyGitHubSignature } from "./github";

const pushSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  repository: z.object({ full_name: z.string() }),
});

interface WebhookInput {
  rawBody: string;
  event: string | null;
  signature: string | null;
  secret: string;
}

interface RepositoryTarget {
  id: number;
  defaultBranch: string;
}

interface WebhookDependencies {
  verify: (rawBody: string, signature: string | null, secret: string) => boolean;
  findRepository: (owner: string, name: string) => Promise<RepositoryTarget | undefined>;
  queue: (repositoryId: number, before: string, after: string) => Promise<number>;
}

async function findRepository(owner: string, name: string) {
  const [rows] = await getDb().execute("SELECT id, default_branch AS defaultBranch FROM repositories WHERE provider = 'github' AND owner = ? AND name = ? LIMIT 1", [owner, name]);
  return (rows as RepositoryTarget[])[0];
}

const defaultDependencies: WebhookDependencies = {
  verify: verifyGitHubSignature,
  findRepository,
  queue: (repositoryId, before, after) => queueAnalysis(repositoryId, before, after, "push"),
};

export async function processGitHubWebhook(input: WebhookInput, dependencies: WebhookDependencies = defaultDependencies) {
  if (!dependencies.verify(input.rawBody, input.signature, input.secret)) {
    return { status: 401, body: { error: "invalid_signature" } };
  }
  if (input.event === "ping") return { status: 200, body: { ok: true } };
  if (input.event !== "push") return { status: 202, body: { ignored: true } };

  const payload = pushSchema.parse(JSON.parse(input.rawBody));
  if (/^0+$/.test(payload.after)) return { status: 202, body: { ignored: "branch_deleted" } };
  const [owner, name] = payload.repository.full_name.split("/");
  const repository = await dependencies.findRepository(owner, name);
  if (!repository || payload.ref !== `refs/heads/${repository.defaultBranch}`) {
    return { status: 202, body: { ignored: "unregistered_repository_or_branch" } };
  }

  const runId = await dependencies.queue(repository.id, payload.before, payload.after);
  return { status: 202, body: { accepted: true, runId }, runId };
}
