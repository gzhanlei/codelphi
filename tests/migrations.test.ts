import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("database migrations", () => {
  it("creates products.organization_id before using it in a clean installation", () => {
    const sql = readFileSync(new URL("../migrations/008_multi_tenant.sql", import.meta.url), "utf8");
    const addColumn = sql.indexOf("ALTER TABLE products ADD COLUMN organization_id");
    const update = sql.indexOf("UPDATE products SET organization_id");
    const modify = sql.indexOf("ALTER TABLE products MODIFY organization_id");
    expect(addColumn).toBeGreaterThanOrEqual(0);
    expect(addColumn).toBeLessThan(update);
    expect(addColumn).toBeLessThan(modify);
  });

  it("stores product description provenance and evidence", () => {
    const sql = readFileSync(new URL("../migrations/014_product_description_evidence.sql", import.meta.url), "utf8");
    expect(sql).toContain("description_source");
    expect(sql).toContain("description_evidence");
    expect(sql).toContain("DEFAULT 'manual'");
  });

  it("stores architecture analysis receipts separately from rendering evidence", () => {
    const sql = readFileSync(new URL("../migrations/015_architecture_analysis_receipts.sql", import.meta.url), "utf8");
    expect(sql).toContain("ALTER TABLE architecture_documents");
    expect(sql).toContain("analysis_receipt JSON NULL");
  });

  it("records old product slugs for redirect after rename", () => {
    const sql = readFileSync(new URL("../migrations/024_product_slug_history.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS product_slug_history");
    expect(sql).toContain("UNIQUE KEY product_slug_history_old_slug_unique (old_slug)");
    expect(sql).toContain("REFERENCES products(id) ON DELETE CASCADE");
  });

  it("scopes product slug history uniqueness to the owning product for cross-org slug reuse", () => {
    const sql = readFileSync(new URL("../migrations/048_product_slug_history_product_scoped.sql", import.meta.url), "utf8");
    expect(sql).toContain("DROP INDEX product_slug_history_old_slug_unique");
    expect(sql).toContain("ADD UNIQUE KEY product_slug_history_product_old_unique (product_id, old_slug)");
  });

  it("replaces personal workspace slugs with non-identifying random slugs", () => {
    const sql = readFileSync(new URL("../migrations/049_personal_workspace_slug_randomize.sql", import.meta.url), "utf8");
    expect(sql).toContain("UPDATE organizations");
    expect(sql).toContain("CONCAT('u-', SUBSTRING(MD5(RAND()), 1, 10))");
    expect(sql).toContain("WHERE slug LIKE 'u-%'");
  });

  it("adds the public demo flag to products with a closed default", () => {
    const sql = readFileSync(new URL("../migrations/025_product_public_demo.sql", import.meta.url), "utf8");
    expect(sql).toContain("ALTER TABLE products ADD COLUMN is_public_demo TINYINT(1) NOT NULL DEFAULT 0");
  });

  it("marks historical wording-only spec changes without deleting rows", () => {
    const sql = readFileSync(new URL("../migrations/029_wording_only.sql", import.meta.url), "utf8");
    expect(sql).toContain("ALTER TABLE spec_changes");
    expect(sql).toContain("ADD COLUMN wording_only TINYINT(1) NOT NULL DEFAULT 0");
    expect(sql).toContain("ON DELETE CASCADE");
  });

  it("adds explicit feature alias mapping keyed by normalized stable keys", () => {
    const sql = readFileSync(new URL("../migrations/030_feature_aliases.sql", import.meta.url), "utf8");
    expect(sql).toContain("UNIQUE KEY feature_aliases_product_alias_unique (product_id, alias_key)");
    expect(sql).toContain("REFERENCES products(id) ON DELETE CASCADE");
    expect(sql).toContain("SELECT id, '代码仓库连接管理', '代码仓库连接' FROM products WHERE slug = 'codelphi'");
  });

  it("stores semantic feature flows as derived version data", () => {
    const sql = readFileSync(new URL("../migrations/068_feature_flows.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS spec_feature_flows");
    expect(sql).toContain("spec_feature_id BIGINT UNSIGNED NOT NULL PRIMARY KEY");
    expect(sql).toContain("graph_json JSON NOT NULL");
    expect(sql).toContain("scenario_fingerprint CHAR(64) NOT NULL");
    expect(sql).toContain("REFERENCES spec_features(id) ON DELETE CASCADE");
    expect(sql).not.toContain("ALTER TABLE spec_scenarios");
  });
});
