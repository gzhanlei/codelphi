import { readdirSync, readFileSync } from "node:fs";
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
    expect(sql).toContain("CONCAT('u-', SUBSTRING(SHA2(RAND(), 256), 1, 10))");
    expect(sql).toContain("WHERE slug LIKE 'u-%'");
  });

  it("never calls a function that MySQL 9 no longer has, so an empty database builds on 8 and 9 alike", () => {
    // 049 原先写的是 MD5()：生产是 MySQL 8，早已执行过，但在 9 上从零建库会在这里失败。
    const directory = new URL("../migrations/", import.meta.url);
    const statements = (file: string) => readFileSync(new URL(file, directory), "utf8").split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    const offenders = readdirSync(directory).filter((file) => file.endsWith(".sql")).filter((file) => /\b(MD5|SHA1)\s*\(/i.test(statements(file)));
    expect(offenders).toEqual([]);
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

  describe("client analysis (085)", () => {
    const sql = readFileSync(new URL("../migrations/085_client_analysis.sql", import.meta.url), "utf8");

    it("adds the executor switch with a closed default, so every existing product stays server-analysed", () => {
      expect(sql).toContain("ALTER TABLE products\n    ADD COLUMN analysis_executor VARCHAR(16) NOT NULL DEFAULT 'server';");
      // 不复用 analyze_mode：那一列表示的是全量还是增量。
      expect(sql).not.toMatch(/ALTER TABLE products\s+MODIFY/);
    });

    it("only adds: the new columns are nullable or defaulted, and no existing column or key changes", () => {
      for (const forbidden of ["DROP ", "MODIFY ", "CHANGE COLUMN", " AFTER ", "RENAME ", "DROP INDEX"]) expect(sql).not.toContain(forbidden);
      const added = [...sql.matchAll(/ADD COLUMN ([^\n]+)/g)].map((match) => match[1].replace(/[;,]$/, ""));
      expect(added).toHaveLength(5);
      for (const column of added) expect(column, column).toMatch(/NULL$|DEFAULT 'server'$/);
      // repositories 的唯一键不动：同一个 provider/owner/name 仍然只有一条托管记录。
      expect(sql).not.toMatch(/UNIQUE KEY repositories_/);
    });

    it("makes the proposal idempotency key and content hash unique per repository", () => {
      expect(sql).toContain("ADD UNIQUE KEY analysis_runs_client_idempotency_unique (repository_id, client_idempotency_key)");
      expect(sql).toContain("ADD UNIQUE KEY analysis_runs_client_proposal_unique (repository_id, client_proposal_hash)");
    });

    it("stores rejected proposals without any request content", () => {
      const start = sql.indexOf("CREATE TABLE IF NOT EXISTS client_proposal_rejections (");
      expect(start).toBeGreaterThanOrEqual(0);
      const body = sql.slice(start, sql.indexOf(") ENGINE=InnoDB", start));
      for (const column of ["organization_id", "product_id", "repository_id", "revision_sha", "proposal_hash", "error_code", "details_json"]) expect(body).toContain(column);
      for (const forbidden of ["payload", "body", "content", "snippet", "text "]) expect(body).not.toContain(forbidden);
      expect(body).toContain("CONSTRAINT client_proposal_rejections_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE");
    });

    it("keeps comment lines free of the statement separator the migration runner splits on", () => {
      for (const line of sql.split("\n")) {
        if (line.trimStart().startsWith("--")) expect(line, line).not.toContain(";");
      }
    });
  });

  describe("identity layer (084)", () => {
    const sql = readFileSync(new URL("../migrations/084_spec_identity.sql", import.meta.url), "utf8");

    it("creates the two identity registries and the two link tables", () => {
      for (const table of ["feature_identities", "scenario_identities", "feature_identity_links", "scenario_identity_links"]) {
        expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
        const body = sql.slice(sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`));
        expect(body).toContain("CONSTRAINT " + table + "_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE");
      }
      // 身份在一个产品内唯一，按逐字精确的比较。
      expect(sql).toContain("UNIQUE KEY feature_identities_product_key_unique (product_id, identity_key)");
      expect(sql).toContain("UNIQUE KEY scenario_identities_product_key_unique (product_id, identity_key)");
      // 按功能身份找它的场景身份。
      expect(sql).toContain("KEY scenario_identities_product_feature_idx (product_id, feature_identity_key, reference)");
    });

    it("keeps the registries append-only: a version chain's state lives in the version rows, not here", () => {
      // 身份是产品级的，版本链是仓库级的。一个产品下有几个仓库时，登记表上说不出
      // “这个身份现在在不在链上”。所以登记表只追加，退休和恢复由关系表按版本记录。
      for (const table of ["feature_identities", "scenario_identities"]) {
        const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
        const body = sql.slice(start, sql.indexOf(") ENGINE=InnoDB", start));
        expect(body, table).not.toContain("retired");
        expect(body, table).not.toContain("ON UPDATE");
      }
    });

    it("adds nullable identity columns to existing tables and changes nothing else", () => {
      expect(sql).toContain("ALTER TABLE spec_features\n    ADD COLUMN identity_key VARCHAR(191) COLLATE utf8mb4_bin NULL,\n    ADD COLUMN parent_identity_key VARCHAR(191) COLLATE utf8mb4_bin NULL;");
      expect(sql).toContain("ALTER TABLE spec_scenarios\n    ADD COLUMN identity_key VARCHAR(512) COLLATE utf8mb4_bin NULL;");
      expect(sql).toContain("ALTER TABLE spec_changes\n    ADD COLUMN feature_identity_key VARCHAR(191) COLLATE utf8mb4_bin NULL,\n    ADD COLUMN scenario_identity_key VARCHAR(512) COLLATE utf8mb4_bin NULL;");
      expect(sql).toContain("ALTER TABLE features\n    ADD COLUMN identity_key VARCHAR(191) COLLATE utf8mb4_bin NULL;");
      expect(sql).toContain("ALTER TABLE scenarios\n    ADD COLUMN identity_key VARCHAR(512) COLLATE utf8mb4_bin NULL;");
      // 只做加法：新列全部可空，既有列一列不动。旧应用要能在新表结构上继续服务。
      const added = [...sql.matchAll(/ADD COLUMN ([^\n]+)/g)].map((match) => match[1].replace(/[;,]$/, ""));
      expect(added).toHaveLength(7);
      for (const column of added) {
        expect(column, column).toMatch(/\bNULL$/);
        expect(column, column).not.toContain("NOT NULL");
      }
      for (const forbidden of ["DROP ", "MODIFY ", "CHANGE COLUMN", " AFTER ", "RENAME "]) expect(sql).not.toContain(forbidden);
    });

    it("declares every identity column with the exact-collation binary collation", () => {
      // 现有名称列是不区分大小写和重音的排序规则，身份比较必须和应用层的名称键规则一致。
      const columns = [...sql.matchAll(/(?:identity_key|parent_identity_key|feature_identity_key|name_key) VARCHAR\(\d+\)( COLLATE utf8mb4_bin)?/g)];
      expect(columns).toHaveLength(15);
      for (const column of columns) expect(column[1], column[0]).toBe(" COLLATE utf8mb4_bin");
    });

    it("keeps comment lines free of the statement separator the migration runner splits on", () => {
      // scripts/migrate.ts 按行尾的分号切分语句，注释里的分号会把一句话切成两段。
      for (const line of sql.split("\n")) {
        if (line.trimStart().startsWith("--")) expect(line, line).not.toContain(";");
      }
      // 每条语句都以行尾分号结束。
      const statements = sql.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean);
      expect(statements.length).toBeGreaterThan(4);
      for (const statement of statements) expect(statement).toMatch(/^(?:--|CREATE TABLE|ALTER TABLE)/);
    });
  });
});
