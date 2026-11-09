export interface Evidence {
  path: string;
  startLine?: number;
  endLine?: number;
  url?: string;
  note?: string;
}

export interface SessionUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

export interface ProductRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
}

export interface RepositoryRecord {
  id: string;
  productId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface FeatureRow {
  id: number;
  name: string;
  summary: string;
  parentId: number | null;
  source: "generated" | "manual";
  staleSince?: Date | string | null;
  staleChangeId?: number | null;
  verifiedAt?: Date | string | null;
  verifiedBy?: string | null;
}

export interface ScenarioRow {
  id: number;
  featureId: number;
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: "happy" | "edge" | "error";
  source: "generated" | "manual";
  evidence: unknown;
  staleSince?: Date | string | null;
  staleChangeId?: number | null;
  verifiedAt?: Date | string | null;
  verifiedBy?: string | null;
}

export interface ReleaseRow {
  id: number;
  title: string;
  summary: string;
  sha: string;
  url: string;
  committedAt: Date;
  specVersionId: number | null;
}

export interface BehaviorChangeRow {
  id: number;
  releaseId: number;
  kind: "added" | "changed" | "removed";
  entityType: "feature" | "scenario";
  featureName: string;
  scenarioReference: string;
  summary: string;
  /** A3 Highlight 九类分类（确定性规则打标，绝大多数 change 为 NULL）。 */
  highlightType?: string | null;
  highlightReason?: string | null;
  before: unknown;
  after: unknown;
  /** C-lite 展示信号：与本条构成疑似改名的对侧功能名（不改数据）。 */
  suspectedRenameWith?: string;
}

/** 被等价判定折叠、未计入行为变化的差异（发布变化视图的审计展示；id 为负数合成键，不对应落库行）。 */
export interface FoldedBehaviorChangeRow extends BehaviorChangeRow {
  reason: "wording" | "renumber" | "tests-only";
}

export interface ChangeRow {
  id: number;
  releaseId: number;
  featureName: string;
  kind: string;
  description: string;
  userImpact: string;
  evidence: unknown;
}
