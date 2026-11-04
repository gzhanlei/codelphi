import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { githubCodeHostingAdapter } from "../lib/code-hosting";
import { productInputSchema } from "../lib/product-input";
import { registrationError, resolveRepositoryRegistration, type RepositoryRegistrationAdapter } from "../lib/product-registration";

const input = productInputSchema.parse({ name: "SalesBuddy", slug: "salesbuddy", description: "", repository: "gzhanlei/salesbuddy", defaultBranch: "", analyze: true });

function adapter(overrides: Partial<RepositoryRegistrationAdapter>): RepositoryRegistrationAdapter {
  return { ...githubCodeHostingAdapter, ...overrides };
}

describe("product registration", () => {
  it("uses the repository default branch and resolves its head through the provider", async () => {
    const github = adapter({
      getRepository: vi.fn(async () => ({ owner: "gzhanlei", name: "salesbuddy", defaultBranch: "main" })),
      getBranchHead: vi.fn(async () => "sha-1"),
    });
    const result = await resolveRepositoryRegistration(input, github);
    expect(result.defaultBranch).toBe("main");
    expect(result.afterSha).toBe("sha-1");
    expect(result.repository.provider).toBe("github");
    expect(github.getBranchHead).toHaveBeenCalledWith({ owner: "gzhanlei", name: "salesbuddy", defaultBranch: "main" }, { connectionId: null, organizationId: 1 });
  });

  it("keeps an explicitly selected branch", async () => {
    const github = adapter({
      getRepository: vi.fn(async () => ({ owner: "gzhanlei", name: "salesbuddy", defaultBranch: "main" })),
      getBranchHead: vi.fn(async () => "sha-2"),
    });
    const result = await resolveRepositoryRegistration({ ...input, defaultBranch: "develop" }, github);
    expect(result.defaultBranch).toBe("develop");
    expect(github.getBranchHead).toHaveBeenCalledWith(expect.objectContaining({ defaultBranch: "develop" }), { connectionId: null, organizationId: 1 });
  });

  it("passes the selected installation connection to the provider", async () => {
    const github = adapter({
      getRepository: vi.fn(async () => ({ owner: "gzhanlei", name: "salesbuddy", defaultBranch: "main" })),
      getBranchHead: vi.fn(async () => "sha-3"),
    });
    await resolveRepositoryRegistration({ ...input, connectionId: 9, organizationId: 7 }, github);
    expect(github.getRepository).toHaveBeenCalledWith(expect.anything(), { connectionId: 9, organizationId: 7 });
    expect(github.getBranchHead).toHaveBeenCalledWith(expect.anything(), { connectionId: 9, organizationId: 7 });
  });

  it("uses the provider's registration error guidance", async () => {
    const github = adapter({
      getRepository: vi.fn(async () => {
        throw new Error('GitHub API 404: {"message":"Not Found"}');
      }),
      getBranchHead: vi.fn(async () => "sha-404"),
    });
    await expect(resolveRepositoryRegistration({ ...input, connectionId: 9 }, github)).rejects.toThrow("GitHub App 尚未授权该仓库");
  });

  it("maps validation, duplicate and unexpected errors consistently", () => {
    let validation: ZodError;
    try { productInputSchema.parse({}); } catch (error) { validation = error as ZodError; }
    expect(registrationError(validation!).status).toBe(400);
    expect(registrationError({ code: "ER_DUP_ENTRY" })).toEqual({ status: 409, message: "产品 Slug 或代码仓库已经注册" });
    expect(registrationError(new Error("GitHub API 404"))).toEqual({ status: 400, message: "GitHub API 404" });
    expect(registrationError(null).message).toBe("添加产品失败，请检查仓库名称和访问权限");
  });
});
