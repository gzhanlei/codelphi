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
  before: unknown;
  after: unknown;
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
