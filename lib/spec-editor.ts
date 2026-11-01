import { z } from "zod";

export const featureInputSchema = z.object({
  name: z.string().trim().min(1, "请输入功能名称").max(191),
  summary: z.string().trim().max(4_000).default(""),
  parentId: z.number().int().positive().nullable().default(null),
});

export const scenarioInputSchema = z.object({
  context: z.string().trim().min(1, "请输入使用情境").max(2_000),
  action: z.string().trim().min(1, "请输入用户操作").max(2_000),
  outcome: z.string().trim().min(1, "请输入系统结果").max(2_000),
  category: z.enum(["happy", "edge", "error"]),
});

export function canAssignParent(features: Array<{ id: number; parentId: number | null }>, featureId: number | null, parentId: number | null) {
  if (parentId === null) return true;
  if (featureId !== null && features.some((feature) => feature.parentId === featureId)) return false;
  if (featureId === parentId) return false;
  const parent = features.find((feature) => feature.id === parentId);
  return Boolean(parent && parent.parentId === null);
}

export class FeatureParentError extends Error {}

export function assertFeatureParent(features: Array<{ id: number; parentId: number | null }>, featureId: number | null, parentId: number | null) {
  if (!canAssignParent(features, featureId, parentId)) {
    throw new FeatureParentError("父功能必须是顶级功能，且不能形成循环");
  }
}

export function nextScenarioReference(category: "happy" | "edge" | "error", references: string[]) {
  const prefix = { happy: "HP", edge: "EC", error: "ER" }[category];
  const maximum = references.reduce((max, reference) => {
    const match = reference.match(new RegExp(`^${prefix}-(\\d+)$`));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}-${maximum + 1}`;
}
