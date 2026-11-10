import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../lib/db";
import { createFeature, createScenario, deleteFeature, deleteScenario, updateFeature, updateScenario } from "../lib/spec-editor-service";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

const execute = vi.fn();
const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };

beforeEach(() => {
  execute.mockReset();
  connection.beginTransaction.mockReset();
  connection.commit.mockReset();
  connection.rollback.mockReset();
  connection.release.mockReset();
  vi.mocked(getDb).mockReturnValue({ execute, getConnection: vi.fn().mockResolvedValue(connection) } as never);
});

describe("spec editor persistence", () => {
  it("locks the product feature rows before creating a child", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM products")) return [[{ id: 2 }]];
      if (sql.includes("SELECT id, parent_id")) return [[]];
      if (sql.includes("INSERT INTO features")) return [{ insertId: 5 }];
      return [{}];
    });
    await expect(createFeature("radar", { name: "Child", summary: "", parentId: null })).resolves.toMatchObject({ id: 5 });
    expect(execute).toHaveBeenCalledWith("SELECT id, parent_id AS parentId FROM features WHERE product_id = ? AND active = 1 FOR UPDATE", [2]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("updates only active features without resurrecting deleted rows", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT product_id AS productId")) return [[{ productId: 2 }]];
      if (sql.includes("SELECT id, parent_id")) return [[{ id: 1, parentId: null }, { id: 4, parentId: null }]];
      if (sql.includes("SELECT id, product_id")) return [[{ id: 1, productId: 2, name: "Root", source: "manual" }]];
      if (sql.includes("UPDATE features")) return [{ affectedRows: 1 }];
      return [{}];
    });
    await expect(updateFeature(1, { name: "Root", summary: "Updated", parentId: 4 })).resolves.toMatchObject({ id: 1, parentId: 4, source: "manual" });
    expect(execute).toHaveBeenCalledWith("UPDATE features SET name = ?, summary = ?, parent_id = ?, source = 'manual', verified_at = NULL, verified_by = NULL, last_edited_by = ?, last_edited_at = NOW(3) WHERE id = ? AND active = 1", ["Root", "Updated", 4, null, 1]);
    expect(execute).toHaveBeenCalledWith("SELECT id, parent_id AS parentId FROM features WHERE product_id = ? AND active = 1 FOR UPDATE", [2]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("rejects a concurrent feature deletion", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT product_id AS productId")) return [[{ productId: 2 }]];
      if (sql.includes("SELECT id, parent_id")) return [[{ id: 1, parentId: null }]];
      if (sql.includes("SELECT id, product_id")) return [[{ id: 1, productId: 2, name: "Root", source: "manual" }]];
      if (sql.includes("UPDATE features")) return [{ affectedRows: 0 }];
      return [{}];
    });
    await expect(updateFeature(1, { name: "Root", summary: "", parentId: null })).rejects.toMatchObject({ status: 404 });
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it("allows generated summaries to be edited without changing the stable name", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT product_id AS productId")) return [[{ productId: 2 }]];
      if (sql.includes("SELECT id, parent_id")) return [[{ id: 1, parentId: null }]];
      if (sql.includes("SELECT id, product_id")) return [[{ id: 1, productId: 2, name: "Authentication", source: "generated" }]];
      if (sql.includes("UPDATE features")) return [{ affectedRows: 1 }];
      return [{}];
    });
    await expect(updateFeature(1, { name: "Authentication", summary: "Curated", parentId: null })).resolves.toMatchObject({ name: "Authentication", summary: "Curated" });
  });

  it("does not rename a generated feature and break its analysis identity", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT product_id AS productId")) return [[{ productId: 2 }]];
      if (sql.includes("SELECT id, parent_id")) return [[{ id: 1, parentId: null }]];
      if (sql.includes("SELECT id, product_id")) return [[{ id: 1, productId: 2, name: "Authentication", source: "generated" }]];
      return [{}];
    });
    await expect(updateFeature(1, { name: "Login", summary: "", parentId: null })).rejects.toMatchObject({ status: 400 });
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE features SET"), expect.anything());
  });

  it("locks the parent feature while allocating and inserting a scenario", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM features")) return [[{ id: 4 }]];
      if (sql.includes("SELECT reference FROM scenarios")) return [[{ reference: "HP-1" }]];
      if (sql.includes("INSERT INTO scenarios")) return [{ insertId: 9 }];
      return [{}];
    });
    const input = { context: "User", action: "Acts", outcome: "Done", category: "happy" as const };
    await expect(createScenario(4, input)).resolves.toMatchObject({ id: 9, reference: "HP-2" });
    expect(execute).toHaveBeenCalledWith("SELECT id FROM features WHERE id = ? AND active = 1 FOR UPDATE", [4]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("rejects scenario creation when the parent is already deleted", async () => {
    execute.mockResolvedValue([[]]);
    const input = { context: "User", action: "Acts", outcome: "Done", category: "happy" as const };
    await expect(createScenario(4, input)).rejects.toMatchObject({ status: 404 });
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO scenarios"), expect.anything());
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it("does not update a soft-deleted scenario", async () => {
    execute.mockResolvedValue([[]]);
    await expect(updateScenario(8, { context: "User", action: "Acts", outcome: "Done", category: "happy" })).rejects.toMatchObject({ status: 404 });
    expect(execute).toHaveBeenCalledWith("SELECT id FROM scenarios WHERE id = ? AND active = 1", [8]);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE scenarios SET"), expect.anything());
  });

  it("keeps staleness but clears verification when a scenario is saved manually (P1: 修订 ≠ 核实)", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM scenarios")) return [[{ id: 8 }]];
      if (sql.includes("UPDATE scenarios")) return [{ affectedRows: 1 }];
      return [{}];
    });
    await expect(updateScenario(8, { context: "User", action: "Acts", outcome: "Done", category: "happy" })).resolves.toMatchObject({ id: 8, source: "manual" });
    expect(execute).toHaveBeenCalledWith(
      "UPDATE scenarios SET context = ?, action = ?, outcome = ?, category = ?, source = 'manual', verified_at = NULL, verified_by = NULL, last_edited_by = ?, last_edited_at = NOW(3) WHERE id = ? AND active = 1",
      ["User", "Acts", "Done", "happy", null, 8],
    );
  });

  it("records the editor identity on manual writes (P2 编辑归因)", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM scenarios")) return [[{ id: 8 }]];
      if (sql.includes("UPDATE scenarios")) return [{ affectedRows: 1 }];
      return [{}];
    });
    await updateScenario(8, { context: "User", action: "Acts", outcome: "Done", category: "happy" }, undefined, "user-42");
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("last_edited_by = ?, last_edited_at = NOW(3)"),
      ["User", "Acts", "Done", "happy", "user-42", 8],
    );
    await deleteScenario(8, undefined, "user-42");
    expect(execute).toHaveBeenCalledWith(
      "UPDATE scenarios SET active = 0, source = 'manual', last_edited_by = ?, last_edited_at = NOW(3) WHERE id = ?",
      ["user-42", 8],
    );
  });

  it("promotes surviving children and writes manual tombstones when deleting", async () => {
    execute.mockImplementation(async (sql: string) => sql.includes("SELECT product_id AS productId") ? [[{ productId: 2 }]] : [{ affectedRows: 1 }]);
    await deleteFeature(4);
    expect(execute).toHaveBeenCalledWith("SELECT id FROM features WHERE product_id = ? FOR UPDATE", [2]);
    expect(execute).toHaveBeenCalledWith("UPDATE features SET parent_id = NULL, source = 'manual' WHERE parent_id = ? AND active = 1", [4]);
    expect(execute).toHaveBeenCalledWith("UPDATE features SET active = 0, source = 'manual', last_edited_by = ?, last_edited_at = NOW(3) WHERE id = ?", [null, 4]);
    expect(execute).toHaveBeenCalledWith("UPDATE scenarios SET active = 0, source = 'manual', last_edited_by = ?, last_edited_at = NOW(3) WHERE feature_id = ?", [null, 4]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();

    execute.mockResolvedValue([{ affectedRows: 1 }]);
    await deleteScenario(9);
    expect(execute).toHaveBeenCalledWith("UPDATE scenarios SET active = 0, source = 'manual', last_edited_by = ?, last_edited_at = NOW(3) WHERE id = ?", [null, 9]);
  });
});
