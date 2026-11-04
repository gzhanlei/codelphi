import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { productRemovalError, removeProduct } from "../lib/product-removal";

function fixture(options: { missing?: boolean; active?: boolean; shared?: boolean; databaseError?: boolean } = {}) {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT id FROM products WHERE slug = ? AND organization_id = ?")) return [options.missing ? [] : [{ id: 42 }]];
    if (sql.includes("SELECT id FROM products WHERE slug = ? AND id <> ?")) return [options.shared ? [{ id: 99 }] : []];
    if (sql.includes("FROM analysis_runs")) return [options.active ? [{ id: 8 }] : []];
    if (sql.startsWith("DELETE FROM products")) {
      if (options.databaseError) throw new Error("database unavailable");
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const connection = { execute, beginTransaction: vi.fn(async () => undefined), commit: vi.fn(async () => undefined), rollback: vi.fn(async () => undefined), release: vi.fn() };
  const getConnection = vi.fn(async () => connection);
  const removeArtifacts = vi.fn(async () => undefined);
  const services = { getConnection, removeArtifacts, root: "/tmp/radar-product-removal" };
  return { execute, connection, getConnection, removeArtifacts, services };
}

describe("product removal", () => {
  it("deletes only the scoped product and cleans its artifacts after commit", async () => {
    const { execute, connection, removeArtifacts, services } = fixture();
    const result = await removeProduct("radar", 7, services as never);
    expect(result).toEqual({ status: "deleted", artifactsRemoved: true });
    const deletion = execute.mock.calls.find(([sql]) => sql.startsWith("DELETE FROM products"));
    expect(deletion).toEqual(["DELETE FROM products WHERE id = ? AND organization_id = ?", [42, 7]]);
    expect(execute.mock.calls.some(([sql]) => sql.includes("repository_connections"))).toBe(false);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(removeArtifacts).toHaveBeenCalledWith(join("/tmp/radar-product-removal", "artifacts/products/radar"));
    expect(removeArtifacts.mock.invocationCallOrder[0]).toBeGreaterThan(connection.commit.mock.invocationCallOrder[0]);
  });

  it("returns 404 without deleting artifacts for a missing or cross-workspace product", async () => {
    const { connection, removeArtifacts, services } = fixture({ missing: true });
    await expect(removeProduct("radar", 7, services as never)).rejects.toMatchObject({ status: 404, message: "产品不存在或不属于当前工作区" });
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(removeArtifacts).not.toHaveBeenCalled();
  });

  it("rejects removal while an analysis is queued or running", async () => {
    const { execute, connection, removeArtifacts, services } = fixture({ active: true });
    await expect(removeProduct("radar", 7, services as never)).rejects.toMatchObject({ status: 409, message: "当前产品正在分析，请完成后再移除" });
    expect(execute.mock.calls.some(([sql]) => sql.startsWith("DELETE FROM products"))).toBe(false);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(removeArtifacts).not.toHaveBeenCalled();
  });

  it("preserves a same-slug artifact directory used by another workspace", async () => {
    const { connection, removeArtifacts, services } = fixture({ shared: true });
    await expect(removeProduct("radar", 7, services as never)).resolves.toEqual({ status: "deleted", artifactsRemoved: false });
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(removeArtifacts).not.toHaveBeenCalled();
  });

  it("rolls back database failures and releases the connection", async () => {
    const { connection, removeArtifacts, services } = fixture({ databaseError: true });
    await expect(removeProduct("radar", 7, services as never)).rejects.toThrow("database unavailable");
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(removeArtifacts).not.toHaveBeenCalled();
  });

  it("reports an explicit partial result if artifact cleanup fails after deletion", async () => {
    const { connection, removeArtifacts, services } = fixture();
    removeArtifacts.mockRejectedValue(new Error("permission denied"));
    await expect(removeProduct("radar", 7, services as never)).rejects.toMatchObject({ status: 500, message: "产品记录已移除，但生成文件清理失败，请联系管理员" });
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("maps unsafe and unexpected failures without exposing internals", async () => {
    expect(productRemovalError(new ZodError([]))).toEqual({ status: 400, message: "产品标识无效" });
    expect(productRemovalError(new Error("sensitive database details"))).toEqual({ status: 500, message: "移除产品失败，请稍后重试" });
  });

  it("rejects an unsafe slug before opening a database connection", async () => {
    const { getConnection, services } = fixture();
    await expect(removeProduct("../radar", 7, services as never)).rejects.toThrow();
    expect(getConnection).not.toHaveBeenCalled();
  });
});
