import { ZodError, type z } from "zod";
import { queueAnalysis } from "./analysis";
import { getDb } from "./db";
import { getCodeHostingAdapter, type CodeHostingAdapter, type HostedRepository } from "./code-hosting";
import type { productInputSchema } from "./product-input";

type ProductInput = z.infer<typeof productInputSchema>;
export type RepositoryRegistrationAdapter = Pick<CodeHostingAdapter, "provider" | "parseRepository" | "getRepository" | "getBranchHead" | "explainRegistrationError">;

export async function resolveRepositoryRegistration(
  input: ProductInput & { organizationId?: number },
  adapter: RepositoryRegistrationAdapter = getCodeHostingAdapter(input.provider),
) {
  const repository = adapter.parseRepository(input.repository);
  const access = { connectionId: input.connectionId, organizationId: input.organizationId ?? 1 };
  try {
    const metadata = await adapter.getRepository(repository, access);
    const defaultBranch = input.defaultBranch || metadata.defaultBranch;
    const afterSha = await adapter.getBranchHead({ ...repository, defaultBranch }, access);
    return { repository: { ...repository, provider: adapter.provider }, defaultBranch, afterSha };
  } catch (error) {
    throw adapter.explainRegistrationError?.(error, access) ?? error;
  }
}

async function insertRegistration(input: ProductInput & { organizationId?: number }, repository: HostedRepository, defaultBranch: string) {
  const connection = await getDb().getConnection();
  try {
    await connection.beginTransaction();
    const [productResult] = await connection.execute(
      "INSERT INTO products (slug, name, description, organization_id) VALUES (?, ?, ?, ?)",
      [input.slug, input.name, input.description, input.organizationId ?? 1],
    );
    const productId = Number((productResult as { insertId: number }).insertId);
    const [repositoryResult] = await connection.execute(
      "INSERT INTO repositories (product_id, provider, owner, name, default_branch, connection_id) VALUES (?, ?, ?, ?, ?, ?)",
      [productId, repository.provider, repository.owner, repository.name, defaultBranch, input.connectionId],
    );
    await connection.commit();
    return Number((repositoryResult as { insertId: number }).insertId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function registerProduct(input: ProductInput & { organizationId?: number }) {
  const resolved = await resolveRepositoryRegistration(input);
  const repositoryId = await insertRegistration(input, resolved.repository, resolved.defaultBranch);
  return { slug: input.slug, analyze: input.analyze, repositoryId, afterSha: resolved.afterSha };
}

export async function queueRegistrationAnalysis(registration: { analyze: boolean; repositoryId: number; afterSha: string }) {
  if (!registration.analyze) return null;
  return queueAnalysis(registration.repositoryId, null, registration.afterSha, "manual");
}

export function registrationError(error: unknown) {
  if (error instanceof ZodError) {
    return { status: 400, message: error.issues[0]?.message ?? "输入无效" };
  }
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
    return { status: 409, message: "产品 Slug 或代码仓库已经注册" };
  }
  return {
    status: 400,
    message: error instanceof Error ? error.message : "添加产品失败，请检查仓库名称和访问权限",
  };
}
