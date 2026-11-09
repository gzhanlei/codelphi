import { ZodError, type z } from "zod";
import { queueAnalysis } from "./analysis";
import { getDb } from "./db";
import { getCodeHostingAdapter, type CodeHostingAdapter, type HostedRepository } from "./code-hosting";
import { BillingError } from "./billing/core";
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
    const organizationId = input.organizationId ?? 1;
    const [productResult] = await connection.execute(
      "INSERT INTO products (slug, name, description, organization_id) VALUES (?, ?, ?, ?)",
      [input.slug, input.name, input.description, organizationId],
    );
    const productId = Number((productResult as { insertId: number }).insertId);
    // 新仓库继承工作区默认触发模式（051）：push 为 schema 默认，非 push 时写入三列
    const [defaultRows] = await connection.execute(
      `SELECT default_analysis_trigger AS triggerMode, default_analysis_trigger_n AS triggerN, default_analysis_trigger_hour AS triggerHour
       FROM organizations WHERE id = ? LIMIT 1`,
      [organizationId],
    );
    const workspaceDefault = (defaultRows as Array<{ triggerMode: string; triggerN: number | null; triggerHour: number | null }>)[0];
    const trigger = workspaceDefault?.triggerMode ?? "push";
    const triggerColumns = trigger === "push" ? "" : ", analysis_trigger, analysis_trigger_n, analysis_trigger_hour";
    const triggerValues = trigger === "push" ? [] : [trigger, workspaceDefault?.triggerN ?? null, workspaceDefault?.triggerHour ?? null];
    const [repositoryResult] = await connection.execute(
      `INSERT INTO repositories (product_id, provider, owner, name, default_branch, connection_id${triggerColumns}) VALUES (?, ?, ?, ?, ?, ?${trigger === "push" ? "" : ", ?, ?, ?"})`,
      [productId, repository.provider, repository.owner, repository.name, defaultBranch, input.connectionId, ...triggerValues],
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
  // 首次分析入队的额度闸门拒绝（契约 §12.2）：映射为可理解的额度语义
  if (error instanceof BillingError) {
    const messages: Record<string, string> = {
      quota_exceeded: "额度不足：首次分析未入队，请升级套餐或购买超额包后重试",
      reconciliation_hold: "账户对账中，暂时无法发起新分析",
    };
    return {
      status: error.code === "quota_exceeded" ? 402 : 409,
      message: messages[error.code] ?? `当前账户状态无法发起新分析（${error.code}）`,
    };
  }
  return {
    status: 400,
    message: error instanceof Error ? error.message : "添加产品失败，请检查仓库名称和访问权限",
  };
}
