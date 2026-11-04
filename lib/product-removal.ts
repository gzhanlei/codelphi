import { rm } from "node:fs/promises";
import type { PoolConnection } from "mysql2/promise";
import { ZodError } from "zod";
import { getDb } from "./db";
import { productInputSchema } from "./product-input";
import { safeArtifactAbsolutePath } from "./architecture-store";

export class ProductRemovalError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ProductRemovalError";
  }
}

interface ProductRemovalServices {
  getConnection: () => Promise<PoolConnection>;
  removeArtifacts: (path: string) => Promise<void>;
  root: string;
}

function defaultServices(): ProductRemovalServices {
  return {
    getConnection: () => getDb().getConnection(),
    removeArtifacts: (path) => rm(path, { recursive: true, force: true }),
    root: process.cwd(),
  };
}

export async function removeProduct(rawSlug: string, organizationId: number, services: ProductRemovalServices = defaultServices()) {
  const slug = productInputSchema.shape.slug.parse(rawSlug);
  const connection = await services.getConnection();
  let sharedArtifacts = false;
  try {
    await connection.beginTransaction();
    const [productRows] = await connection.execute("SELECT id FROM products WHERE slug = ? AND organization_id = ? FOR UPDATE", [slug, organizationId]);
    const product = (productRows as Array<{ id: number }>)[0];
    if (!product) throw new ProductRemovalError(404, "产品不存在或不属于当前工作区");
    const productId = Number(product.id);

    const [sharedRows] = await connection.execute("SELECT id FROM products WHERE slug = ? AND id <> ?", [slug, productId]);
    sharedArtifacts = (sharedRows as Array<{ id: number }>).length > 0;
    const [activeRows] = await connection.execute(
      `SELECT r.id FROM analysis_runs r JOIN repositories repo ON repo.id = r.repository_id
       WHERE repo.product_id = ? AND r.status IN ('queued', 'running') LIMIT 1 FOR UPDATE`,
      [productId],
    );
    if ((activeRows as Array<{ id: number }>).length > 0) throw new ProductRemovalError(409, "当前产品正在分析，请完成后再移除");

    await connection.execute("DELETE FROM products WHERE id = ? AND organization_id = ?", [productId, organizationId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  if (sharedArtifacts) return { status: "deleted" as const, artifactsRemoved: false };
  try {
    await services.removeArtifacts(safeArtifactAbsolutePath(`artifacts/products/${slug}`, services.root));
  } catch {
    throw new ProductRemovalError(500, "产品记录已移除，但生成文件清理失败，请联系管理员");
  }
  return { status: "deleted" as const, artifactsRemoved: true };
}

export function productRemovalError(error: unknown) {
  if (error instanceof ProductRemovalError) return { status: error.status, message: error.message };
  if (error instanceof ZodError) return { status: 400, message: "产品标识无效" };
  return { status: 500, message: "移除产品失败，请稍后重试" };
}
