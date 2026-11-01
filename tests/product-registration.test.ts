import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { productInputSchema } from "../lib/product-input";
import { registrationError, resolveGitHubRegistration } from "../lib/product-registration";

const input = productInputSchema.parse({ name: "SalesBuddy", slug: "salesbuddy", description: "", repository: "gzhanlei/salesbuddy", defaultBranch: "", analyze: true });

describe("product registration", () => {
  it("uses the repository default branch and resolves its head", async () => {
    const github = {
      getRepository: vi.fn(async () => ({ owner: "gzhanlei", name: "salesbuddy", defaultBranch: "main" })),
      getBranchHead: vi.fn(async () => "sha-1"),
    };
    const result = await resolveGitHubRegistration(input, github);
    expect(result.defaultBranch).toBe("main");
    expect(result.afterSha).toBe("sha-1");
    expect(github.getBranchHead).toHaveBeenCalledWith({ owner: "gzhanlei", name: "salesbuddy", defaultBranch: "main" }, { connectionId: null });
  });

  it("keeps an explicitly selected branch", async () => {
    const github = {
      getRepository: vi.fn(async () => ({ owner: "gzhanlei", name: "salesbuddy", defaultBranch: "main" })),
      getBranchHead: vi.fn(async () => "sha-2"),
    };
    const result = await resolveGitHubRegistration({ ...input, defaultBranch: "develop" }, github);
    expect(result.defaultBranch).toBe("develop");
    expect(github.getBranchHead).toHaveBeenCalledWith(expect.objectContaining({ defaultBranch: "develop" }), { connectionId: null });
  });

  it("passes the selected installation connection to GitHub", async () => {
    const github = {
      getRepository: vi.fn(async () => ({ owner: "gzhanlei", name: "salesbuddy", defaultBranch: "main" })),
      getBranchHead: vi.fn(async () => "sha-3"),
    };
    await resolveGitHubRegistration({ ...input, connectionId: 9 }, github);
    expect(github.getRepository).toHaveBeenCalledWith(expect.anything(), { connectionId: 9 });
    expect(github.getBranchHead).toHaveBeenCalledWith(expect.anything(), { connectionId: 9 });
  });

  it("maps validation, duplicate and unexpected errors consistently", () => {
    let validation: ZodError;
    try { productInputSchema.parse({}); } catch (error) { validation = error as ZodError; }
    expect(registrationError(validation!).status).toBe(400);
    expect(registrationError({ code: "ER_DUP_ENTRY" })).toEqual({ status: 409, message: "产品 Slug 或 GitHub 仓库已经注册" });
    expect(registrationError(new Error("GitHub API 404"))).toEqual({ status: 400, message: "GitHub API 404" });
    expect(registrationError(null).message).toBe("添加产品失败，请检查仓库名称和访问权限");
  });
});
