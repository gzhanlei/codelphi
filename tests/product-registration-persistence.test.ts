import { beforeEach, describe, expect, it, vi } from "vitest";
import { productInputSchema } from "../lib/product-input";
import { registerProduct } from "../lib/product-registration";

const connection = {
  execute: vi.fn(),
  beginTransaction: vi.fn(async () => undefined),
  commit: vi.fn(async () => undefined),
  rollback: vi.fn(async () => undefined),
  release: vi.fn(),
};

vi.mock("../lib/db", () => ({ getDb: () => ({ getConnection: async () => connection }) }));
vi.mock("../lib/code-hosting", () => ({
  getCodeHostingAdapter: () => ({
    provider: "github",
    parseRepository: (value: string) => {
      const [owner, name] = value.split("/");
      return { owner, name, defaultBranch: "main" };
    },
    getRepository: async () => ({ owner: "gzhanlei", name: "codelphi", defaultBranch: "main" }),
    getBranchHead: async () => "sha-head",
  }),
}));

const input = productInputSchema.parse({ name: "CoDelphi", slug: "radar", description: "", repository: "gzhanlei/codelphi", defaultBranch: "", analyze: false, connectionId: 42 });

describe("product registration persistence", () => {
  beforeEach(() => {
    connection.execute.mockReset();
    connection.beginTransaction.mockClear();
    connection.commit.mockClear();
    connection.rollback.mockClear();
    connection.release.mockClear();
  });

  it("stores the provider and installation in one transaction", async () => {
    connection.execute.mockImplementation(async (sql: string) => [{ insertId: sql.includes("INSERT INTO products") ? 4 : 9 }]);
    const result = await registerProduct({ ...input, organizationId: 7 });
    expect(result).toEqual({ slug: "radar", analyze: false, repositoryId: 9, afterSha: "sha-head" });
    const insert = connection.execute.mock.calls.find((call) => String(call[0]).includes("INSERT INTO repositories"));
    expect(insert?.[1]).toEqual([4, "github", "gzhanlei", "codelphi", "main", 42]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the connection when persistence fails", async () => {
    connection.execute.mockRejectedValue(new Error("write failed"));
    await expect(registerProduct({ ...input, organizationId: 7 })).rejects.toThrow("write failed");
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });
});
