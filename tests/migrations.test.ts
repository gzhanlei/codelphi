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
});
