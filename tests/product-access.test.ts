import { describe, expect, it, vi } from "vitest";
import { requireFeatureProductAccess, requireProductAccess, requireScenarioProductAccess } from "../lib/product-access";

const TEAM_ORG = { id: 2, slug: "team", name: "Team Workspace" };

function createAccessDb(memberships: Array<{ sub: string; slug: string; organization: { id: number; slug: string; name: string }; role: string }>, productMembers: Array<{ sub: string; productSlug: string; role: string }>, orgProducts: Array<{ slug: string; organizationId: number }>) {
  const execute = vi.fn(async (sql: string, parameters: Array<string | number | null>) => {
    if (sql.includes("FROM organizations o JOIN organization_members m")) {
      const [sub, slug] = parameters as [string, string];
      const membership = memberships.find((item) => item.sub === sub && item.slug === slug);
      return [membership ? [{ id: membership.organization.id, slug: membership.organization.slug, name: membership.organization.name, role: membership.role }] : []];
    }
    if (sql.includes("SELECT id, slug, name, description, organization_id FROM products")) {
      const [slug, organizationId] = parameters as [string, number];
      const product = orgProducts.find((item) => item.slug === slug && item.organizationId === organizationId);
      return [product ? [{ id: 7, slug: product.slug, name: "CoDelphi", description: "产品知识中心", organization_id: product.organizationId }] : []];
    }
    if (sql.includes("FROM product_members pm")) {
      const [sub, slug] = parameters as [string, string];
      const grant = productMembers.find((item) => item.sub === sub && item.productSlug === slug);
      return [grant ? [{ id: 7, slug: grant.productSlug, name: "CoDelphi", description: "产品知识中心", organization_id: TEAM_ORG.id, role: grant.role, org_slug: TEAM_ORG.slug, org_name: TEAM_ORG.name }] : []];
    }
    if (sql.includes("SELECT p.slug FROM features f")) {
      const [featureId] = parameters as [number];
      return [featureId === 5 ? [{ slug: "radar" }] : []];
    }
    if (sql.includes("SELECT p.slug FROM scenarios s")) {
      const [scenarioId] = parameters as [number];
      return [scenarioId === 6 ? [{ slug: "radar" }] : []];
    }
    return [{}];
  });
  return { execute };
}

const OWNER = { sub: "owner-sub", email: "owner@example.com" };
const OUTSIDER = { sub: "outsider-sub", email: "outsider@example.com" };

describe("product access", () => {
  it("workspace members reach the product through the organization path", async () => {
    const db = createAccessDb([{ sub: OWNER.sub, slug: "team", organization: TEAM_ORG, role: "owner" }], [], [{ slug: "radar", organizationId: 2 }]);
    const access = await requireProductAccess(OWNER, "radar", "editor", db.execute, "team");
    expect(access).toMatchObject({ role: "owner", via: "organization", product: { slug: "radar", organizationId: 2 }, organization: { id: 2, role: "owner" } });
  });

  it("falls back to the product membership row when the workspace role is insufficient", async () => {
    const db = createAccessDb([{ sub: OUTSIDER.sub, slug: "personal", organization: { id: 3, slug: "u-outsider-sub", name: "Personal" }, role: "viewer" }], [{ sub: OUTSIDER.sub, productSlug: "radar", role: "editor" }], [{ slug: "radar", organizationId: 2 }]);
    const access = await requireProductAccess(OUTSIDER, "radar", "editor", db.execute, "personal");
    expect(access).toMatchObject({ role: "editor", via: "product", organization: { id: 2, slug: "team" }, product: { organizationId: 2 } });
  });

  it("lets a workspace viewer read a product with the organization path", async () => {
    const db = createAccessDb([{ sub: OUTSIDER.sub, slug: "team", organization: TEAM_ORG, role: "viewer" }], [], [{ slug: "radar", organizationId: 2 }]);
    const access = await requireProductAccess(OUTSIDER, "radar", "viewer", db.execute, "team");
    expect(access).toMatchObject({ role: "viewer", via: "organization" });
  });

  it("denies when neither path grants the required role", async () => {
    const viewerOnly = createAccessDb([{ sub: OUTSIDER.sub, slug: "personal", organization: { id: 3, slug: "u-outsider-sub", name: "Personal" }, role: "viewer" }], [{ sub: OUTSIDER.sub, productSlug: "radar", role: "viewer" }], [{ slug: "radar", organizationId: 2 }]);
    await expect(requireProductAccess(OUTSIDER, "radar", "editor", viewerOnly.execute, "personal")).resolves.toBeNull();
    const stranger = createAccessDb([{ sub: OUTSIDER.sub, slug: "personal", organization: { id: 3, slug: "u-outsider-sub", name: "Personal" }, role: "viewer" }], [], [{ slug: "radar", organizationId: 2 }]);
    await expect(requireProductAccess(OUTSIDER, "radar", "viewer", stranger.execute, "personal")).resolves.toBeNull();
  });

  it("resolves features and scenarios to their product before checking access", async () => {
    const db = createAccessDb([{ sub: OUTSIDER.sub, slug: "personal", organization: { id: 3, slug: "u-outsider-sub", name: "Personal" }, role: "viewer" }], [{ sub: OUTSIDER.sub, productSlug: "radar", role: "editor" }], []);
    const featureAccess = await requireFeatureProductAccess(OUTSIDER, 5, "editor", db.execute, "personal");
    expect(featureAccess).toMatchObject({ via: "product", product: { slug: "radar" } });
    const scenarioAccess = await requireScenarioProductAccess(OUTSIDER, 6, "editor", db.execute, "personal");
    expect(scenarioAccess).toMatchObject({ via: "product", product: { slug: "radar" } });
    await expect(requireFeatureProductAccess(OUTSIDER, 99, "editor", db.execute, "personal")).resolves.toBeNull();
    await expect(requireScenarioProductAccess(OUTSIDER, 99, "editor", db.execute, "personal")).resolves.toBeNull();
  });

  it("denies feature access when the product membership role is too low", async () => {
    const db = createAccessDb([{ sub: OUTSIDER.sub, slug: "personal", organization: { id: 3, slug: "u-outsider-sub", name: "Personal" }, role: "viewer" }], [{ sub: OUTSIDER.sub, productSlug: "radar", role: "viewer" }], []);
    await expect(requireFeatureProductAccess(OUTSIDER, 5, "editor", db.execute, "personal")).resolves.toBeNull();
  });
});
