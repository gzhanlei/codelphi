import { getCodeHostingAdapter, type CodeHostingAdapter, type CodeHostingProvider, type RepositoryRef } from "./code-hosting";
import { getDb } from "./db";

type Execute = (sql: string, parameters: Array<string | number>) => Promise<unknown>;
type AdapterResolver = (provider: CodeHostingProvider) => CodeHostingAdapter;

interface ManualRepository extends RepositoryRef {
  id: number;
  provider: CodeHostingProvider;
  connectionId: number | null;
  organizationId: number;
}

interface ManualAnalysisDependencies {
  execute?: Execute;
  getAdapter?: AdapterResolver;
}

function repositoryQuery(slug: string, organizationId?: number) {
  const organizationFilter = organizationId === undefined ? "" : " AND p.organization_id = ?";
  return {
    sql: `SELECT r.id, r.provider, r.owner, r.name, r.default_branch AS defaultBranch,
                 r.connection_id AS connectionId, p.organization_id AS organizationId
          FROM repositories r JOIN products p ON p.id = r.product_id
          WHERE p.slug = ?${organizationFilter} LIMIT 1`,
    parameters: organizationId === undefined ? [slug] : [slug, organizationId],
  };
}

function databaseExecute(sql: string, parameters: Array<string | number>) {
  return getDb().execute(sql, parameters);
}

export async function resolveManualAnalysis(slug: string, organizationId?: number, dependencies: ManualAnalysisDependencies = {}) {
  const execute = dependencies.execute === undefined ? databaseExecute : dependencies.execute;
  const getAdapter = dependencies.getAdapter === undefined ? getCodeHostingAdapter : dependencies.getAdapter;
  const query = repositoryQuery(slug, organizationId);
  const [rows] = await execute(query.sql, query.parameters) as [ManualRepository[], unknown];
  const repository = (rows as ManualRepository[])[0];
  if (!repository) return null;
  const access = { connectionId: repository.connectionId, organizationId: repository.organizationId };
  const adapter = getAdapter(repository.provider);
  const metadata = await adapter.getRepository(repository, access);
  const afterSha = await adapter.getBranchHead({ ...repository, ...metadata }, access);
  return { repositoryId: repository.id, afterSha };
}
