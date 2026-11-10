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

async function requireProduct(slug: string, organizationId?: number) {
  const [products] = await getDb().execute(
    organizationId === undefined ? "SELECT id FROM products WHERE slug = ?" : "SELECT id FROM products WHERE slug = ? AND organization_id = ?",
    organizationId === undefined ? [slug] : [slug, organizationId],
  );
  const product = (products as Array<{ id: number }>)[0];
  if (!product) throw new SpecEditorError(404, "产品不存在");
  return product;
}

async function featureProductId(id: number, db: Executor, organizationId?: number) {
  const [rows] = await db.execute(
    organizationId === undefined
      ? "SELECT product_id AS productId FROM features WHERE id = ?"
      : "SELECT product_id AS productId FROM features WHERE id = ? AND product_id IN (SELECT id FROM products WHERE organization_id = ?)",
    organizationId === undefined ? [id] : [id, organizationId],
  );
  const feature = (rows as Array<{ productId: number }>)[0];
  if (!feature) throw new SpecEditorError(404, "功能不存在");
  return feature.productId;
}

async function requireFeature(id: number, db: Executor, organizationId?: number) {
  const [rows] = await db.execute(
    organizationId === undefined
      ? "SELECT id, product_id AS productId, name, source FROM features WHERE id = ? AND active = 1"
      : "SELECT id, product_id AS productId, name, source FROM features WHERE id = ? AND active = 1 AND product_id IN (SELECT id FROM products WHERE organization_id = ?)",
    organizationId === undefined ? [id] : [id, organizationId],
  );
  const feature = (rows as Array<{ id: number; productId: number; name: string; source: "generated" | "manual" }>)[0];
  if (!feature) throw new SpecEditorError(404, "功能不存在或已删除");
  return feature;
}

function assertNameChangeAllowed(feature: { name: string; source: "generated" | "manual" }, nextName: string) {
  if (feature.source === "generated" && feature.name !== nextName) {
    throw new SpecEditorError(400, "生成功能名用于关联代码分析，不能修改；请新建人工功能");
  }
}

export async function createFeature(slug: string, value: unknown, organizationId?: number, editorSub?: string) {
  const input = featureInputSchema.parse(value);
  const product = await requireProduct(slug, organizationId);
  return withTransaction(async (connection) => {
    const features = await activeFeatures(product.id, connection, true);
    assertFeatureParent(features, null, input.parentId);
    const [result] = await connection.execute(
      "INSERT INTO features (product_id, name, summary, parent_id, source, active, last_edited_by, last_edited_at) VALUES (?, ?, ?, ?, 'manual', 1, ?, NOW(3))",
      [product.id, input.name, input.summary, input.parentId, editorSub ?? null],
    );
    return { id: Number((result as { insertId: number }).insertId), name: input.name, summary: input.summary, parentId: input.parentId, source: "manual" };
  });
}

export async function updateFeature(id: number, value: unknown, organizationId?: number, editorSub?: string) {
  const input = featureInputSchema.parse(value);
  return withTransaction(async (connection) => {
    const productId = await featureProductId(id, connection, organizationId);
    const features = await activeFeatures(productId, connection, true);
    const feature = await requireFeature(id, connection, organizationId);
    assertNameChangeAllowed(feature, input.name);
    assertFeatureParent(features, id, input.parentId);
    const [result] = await connection.execute(
      // P1：修订 ≠ 核实——编辑只清确认状态（产生新内容），不再清除漂移标记；
      // stale 只能由核实动作或重新分析合并清除（见 docs/spec-verification-lifecycle-design.md 转换 3）。
      "UPDATE features SET name = ?, summary = ?, parent_id = ?, source = 'manual', verified_at = NULL, verified_by = NULL, last_edited_by = ?, last_edited_at = NOW(3) WHERE id = ? AND active = 1",
      [input.name, input.summary, input.parentId, editorSub ?? null, id],
    );
    if ((result as { affectedRows: number }).affectedRows === 0) throw new SpecEditorError(404, "功能不存在或已删除");
    return { id, name: input.name, summary: input.summary, parentId: input.parentId, source: "manual" };
  });
}

export async function deleteFeature(id: number, organizationId?: number, editorSub?: string) {
  return withTransaction(async (connection) => {
    const productId = await featureProductId(id, connection, organizationId);
    await connection.execute("SELECT id FROM features WHERE product_id = ? FOR UPDATE", [productId]);
    await connection.execute("UPDATE features SET parent_id = NULL, source = 'manual' WHERE parent_id = ? AND active = 1", [id]);
    await connection.execute("UPDATE features SET active = 0, source = 'manual', last_edited_by = ?, last_edited_at = NOW(3) WHERE id = ?", [editorSub ?? null, id]);
    await connection.execute("UPDATE scenarios SET active = 0, source = 'manual', last_edited_by = ?, last_edited_at = NOW(3) WHERE feature_id = ?", [editorSub ?? null, id]);
    return { status: "deleted" };
  });
}

export async function createScenario(featureId: number, value: unknown, organizationId?: number, editorSub?: string) {
  const input = scenarioInputSchema.parse(value);
  return withTransaction(async (connection) => {
    const [features] = await connection.execute(
      organizationId === undefined
        ? "SELECT id FROM features WHERE id = ? AND active = 1 FOR UPDATE"
        : "SELECT id FROM features WHERE id = ? AND active = 1 AND product_id IN (SELECT id FROM products WHERE organization_id = ?) FOR UPDATE",
      organizationId === undefined ? [featureId] : [featureId, organizationId],
    );
    if ((features as unknown[]).length === 0) throw new SpecEditorError(404, "功能不存在或已删除");
    const [rows] = await connection.execute("SELECT reference FROM scenarios WHERE feature_id = ?", [featureId]);
    const reference = nextScenarioReference(input.category, (rows as Array<{ reference: string }>).map((row) => row.reference));
    const [result] = await connection.execute(
      `INSERT INTO scenarios (feature_id, reference, context, action, outcome, category, source, active, evidence, last_edited_by, last_edited_at)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', 1, '[]', ?, NOW(3))`,
      [featureId, reference, input.context, input.action, input.outcome, input.category, editorSub ?? null],
    );
    return { id: Number((result as { insertId: number }).insertId), reference, ...input, source: "manual" };
  });
}

async function requireScenario(id: number, organizationId?: number) {
  const [rows] = await getDb().execute(
    organizationId === undefined
      ? "SELECT id FROM scenarios WHERE id = ? AND active = 1"
      : "SELECT id FROM scenarios WHERE id = ? AND active = 1 AND feature_id IN (SELECT id FROM features WHERE product_id IN (SELECT id FROM products WHERE organization_id = ?))",
    organizationId === undefined ? [id] : [id, organizationId],
  );
  if ((rows as unknown[]).length === 0) throw new SpecEditorError(404, "场景不存在或已删除");
}

export async function updateScenario(id: number, value: unknown, organizationId?: number, editorSub?: string) {
  const input = scenarioInputSchema.parse(value);
  await requireScenario(id, organizationId);
  const [result] = await getDb().execute(
    // P1：修订 ≠ 核实（同 updateFeature 注释）。
    "UPDATE scenarios SET context = ?, action = ?, outcome = ?, category = ?, source = 'manual', verified_at = NULL, verified_by = NULL, last_edited_by = ?, last_edited_at = NOW(3) WHERE id = ? AND active = 1",
    [input.context, input.action, input.outcome, input.category, editorSub ?? null, id],
  );
  if ((result as { affectedRows: number }).affectedRows === 0) throw new SpecEditorError(404, "场景不存在或已删除");
  return { id, ...input, source: "manual" };
}

export async function deleteScenario(id: number, organizationId?: number, editorSub?: string) {
  await requireScenario(id, organizationId);
  await getDb().execute("UPDATE scenarios SET active = 0, source = 'manual', last_edited_by = ?, last_edited_at = NOW(3) WHERE id = ?", [editorSub ?? null, id]);
  return { status: "deleted" };
}
