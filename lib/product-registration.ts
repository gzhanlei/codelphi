import { ZodError, type z } from "zod";
import { queueAnalysis } from "./analysis";
import { getDb } from "./db";
import { getBranchHead, getRepository, parseRepository, type GitHubRepository } from "./github";
import type { GitHubAccess } from "./github-access";
import type { productInputSchema } from "./product-input";

type ProductInput = z.infer<typeof productInputSchema>;

interface GitHubGateway {
  getRepository: (repo: GitHubRepository, access?: GitHubAccess) => Promise<GitHubRepository>;
  getBranchHead: (repo: GitHubRepository, access?: GitHubAccess) => Promise<string>;
}

export async function resolveGitHubRegistration(input: ProductInput, github: GitHubGateway = { getRepository, getBranchHead }) {
  const repository = parseRepository(input.repository);
  const access = { connectionId: input.connectionId };
  try {
    const metadata = await github.getRepository(repository, access);
    const defaultBranch = input.defaultBranch || metadata.defaultBranch;
    const afterSha = await github.getBranchHead({ ...repository, defaultBranch }, access);
    return { repository, defaultBranch, afterSha };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GitHub API 404")) {
      const guidance = input.connectionId
        ? "GitHub App 尚未授权该仓库。请先在 GitHub 安装 radar-product-observer 并选择该仓库，或改用服务器 Token。"
        : "仓库不存在，或服务器 Token 无权访问该仓库。";
      throw new Error(`${guidance}（${error.message}）`);
    }
    throw error;
  }
}

async function insertRegistration(input: ProductInput, repository: GitHubRepository, defaultBranch: string) {
  const connection = await getDb().getConnection();
  try {
    await connection.beginTransaction();
    const [productResult] = await connection.execute(
      "INSERT INTO products (slug, name, description) VALUES (?, ?, ?)",
      [input.slug, input.name, input.description],
    );
    const productId = Number((productResult as { insertId: number }).insertId);
    const [repositoryResult] = await connection.execute(
      "INSERT INTO repositories (product_id, owner, name, default_branch, connection_id) VALUES (?, ?, ?, ?, ?)",
      [productId, repository.owner, repository.name, defaultBranch, input.connectionId],
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

export async function registerProduct(input: ProductInput) {
  const resolved = await resolveGitHubRegistration(input);
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
    return { status: 409, message: "产品 Slug 或 GitHub 仓库已经注册" };
  }
  return {
    status: 400,
    message: error instanceof Error ? error.message : "添加产品失败，请检查仓库名称和访问权限",
  };
}
