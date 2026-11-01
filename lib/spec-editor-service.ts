import { z } from "zod";
import type { PoolConnection } from "mysql2/promise";
import { getDb } from "./db";
import { FeatureParentError, featureInputSchema, nextScenarioReference, scenarioInputSchema, assertFeatureParent } from "./spec-editor";

type Executor = Pick<PoolConnection, "execute">;

export class SpecEditorError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function isDuplicateError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";
}

export function specEditorErrorInfo(error: unknown) {
  if (error instanceof SpecEditorError) return { status: error.status, message: error.message };
  if (error instanceof FeatureParentError) return { status: 400, message: error.message };
  if (error instanceof z.ZodError) return { status: 400, message: error.issues[0]?.message || "输入无效" };
  if (error instanceof SyntaxError) return { status: 400, message: "请求 JSON 无效" };
  if (isDuplicateError(error)) return { status: 409, message: "功能或场景已经存在" };
  return { status: 500, message: "保存失败，请重试" };
}

async function withTransaction<T>(work: (connection: PoolConnection) => Promise<T>) {
  const connection = await getDb().getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function activeFeatures(productId: number, db: Executor = getDb(), lock = false) {
  const [rows] = await db.execute(`SELECT id, parent_id AS parentId FROM features WHERE product_id = ? AND active = 1${lock ? " FOR UPDATE" : ""}`, [productId]);
  return rows as Array<{ id: number; parentId: number | null }>;
}

async function requireProduct(slug: string) {
  const [products] = await getDb().execute("SELECT id FROM products WHERE slug = ?", [slug]);
  const product = (products as Array<{ id: number }>)[0];
  if (!product) throw new SpecEditorError(404, "产品不存在");
  return product;
}

async function featureProductId(id: number, db: Executor) {
  const [rows] = await db.execute("SELECT product_id AS productId FROM features WHERE id = ?", [id]);
  const feature = (rows as Array<{ productId: number }>)[0];
  if (!feature) throw new SpecEditorError(404, "功能不存在");
  return feature.productId;
}

async function requireFeature(id: number, db: Executor) {
  const [rows] = await db.execute("SELECT id, product_id AS productId, name, source FROM features WHERE id = ? AND active = 1", [id]);
  const feature = (rows as Array<{ id: number; productId: number; name: string; source: "generated" | "manual" }>)[0];
  if (!feature) throw new SpecEditorError(404, "功能不存在或已删除");
  return feature;
}

function assertNameChangeAllowed(feature: { name: string; source: "generated" | "manual" }, nextName: string) {
  if (feature.source === "generated" && feature.name !== nextName) {
    throw new SpecEditorError(400, "生成功能名用于关联代码分析，不能修改；请新建人工功能");
  }
}

export async function createFeature(slug: string, value: unknown) {
  const input = featureInputSchema.parse(value);
  const product = await requireProduct(slug);
  return withTransaction(async (connection) => {
    const features = await activeFeatures(product.id, connection, true);
    assertFeatureParent(features, null, input.parentId);
    const [result] = await connection.execute(
      "INSERT INTO features (product_id, name, summary, parent_id, source, active) VALUES (?, ?, ?, ?, 'manual', 1)",
      [product.id, input.name, input.summary, input.parentId],
    );
    return { id: Number((result as { insertId: number }).insertId), name: input.name, summary: input.summary, parentId: input.parentId, source: "manual" };
  });
}

export async function updateFeature(id: number, value: unknown) {
  const input = featureInputSchema.parse(value);
  return withTransaction(async (connection) => {
    const productId = await featureProductId(id, connection);
    const features = await activeFeatures(productId, connection, true);
    const feature = await requireFeature(id, connection);
    assertNameChangeAllowed(feature, input.name);
    assertFeatureParent(features, id, input.parentId);
    const [result] = await connection.execute(
      "UPDATE features SET name = ?, summary = ?, parent_id = ?, source = 'manual' WHERE id = ? AND active = 1",
      [input.name, input.summary, input.parentId, id],
    );
    if ((result as { affectedRows: number }).affectedRows === 0) throw new SpecEditorError(404, "功能不存在或已删除");
    return { id, name: input.name, summary: input.summary, parentId: input.parentId, source: "manual" };
  });
}

export async function deleteFeature(id: number) {
  return withTransaction(async (connection) => {
    const productId = await featureProductId(id, connection);
    await connection.execute("SELECT id FROM features WHERE product_id = ? FOR UPDATE", [productId]);
    await connection.execute("UPDATE features SET parent_id = NULL, source = 'manual' WHERE parent_id = ? AND active = 1", [id]);
    await connection.execute("UPDATE features SET active = 0, source = 'manual' WHERE id = ?", [id]);
    await connection.execute("UPDATE scenarios SET active = 0, source = 'manual' WHERE feature_id = ?", [id]);
    return { status: "deleted" };
  });
}

export async function createScenario(featureId: number, value: unknown) {
  const input = scenarioInputSchema.parse(value);
  return withTransaction(async (connection) => {
    const [features] = await connection.execute("SELECT id FROM features WHERE id = ? AND active = 1 FOR UPDATE", [featureId]);
    if ((features as unknown[]).length === 0) throw new SpecEditorError(404, "功能不存在或已删除");
    const [rows] = await connection.execute("SELECT reference FROM scenarios WHERE feature_id = ?", [featureId]);
    const reference = nextScenarioReference(input.category, (rows as Array<{ reference: string }>).map((row) => row.reference));
    const [result] = await connection.execute(
      `INSERT INTO scenarios (feature_id, reference, context, action, outcome, category, source, active, evidence)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', 1, '[]')`,
      [featureId, reference, input.context, input.action, input.outcome, input.category],
    );
    return { id: Number((result as { insertId: number }).insertId), reference, ...input, source: "manual" };
  });
}

async function requireScenario(id: number) {
  const [rows] = await getDb().execute("SELECT id FROM scenarios WHERE id = ? AND active = 1", [id]);
  if ((rows as unknown[]).length === 0) throw new SpecEditorError(404, "场景不存在或已删除");
}

export async function updateScenario(id: number, value: unknown) {
  const input = scenarioInputSchema.parse(value);
  await requireScenario(id);
  const [result] = await getDb().execute(
    "UPDATE scenarios SET context = ?, action = ?, outcome = ?, category = ?, source = 'manual' WHERE id = ? AND active = 1",
    [input.context, input.action, input.outcome, input.category, id],
  );
  if ((result as { affectedRows: number }).affectedRows === 0) throw new SpecEditorError(404, "场景不存在或已删除");
  return { id, ...input, source: "manual" };
}

export async function deleteScenario(id: number) {
  await getDb().execute("UPDATE scenarios SET active = 0, source = 'manual' WHERE id = ?", [id]);
  return { status: "deleted" };
}
