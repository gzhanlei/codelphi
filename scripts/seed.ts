import "dotenv/config";
import { getDb } from "../lib/db";
import { parseRepository } from "../lib/github";

async function seed() {
  const db = getDb();
  try {
    const repository = parseRepository(process.env.GITHUB_REPOSITORY ?? "gzhanlei/codelphi");
    await db.execute(
      `INSERT INTO products (slug, name, description, organization_id)
       VALUES ('radar', 'CoDelphi', '产品知识与变更中心：从代码和发布中维护可追溯的产品规格。', 1)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)`,
    );
    const [products] = await db.execute("SELECT id FROM products WHERE slug = 'radar'");
    const productId = Number((products as Array<{ id: number }>)[0].id);
    await db.execute(
      `INSERT INTO repositories (product_id, owner, name, default_branch)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE product_id = VALUES(product_id), default_branch = VALUES(default_branch)`,
      [productId, repository.owner, repository.name, repository.defaultBranch],
    );
    console.log(`Registered CoDelphi: ${repository.owner}/${repository.name}`);
    // 按 PUBLIC_DEMO_SLUGS 回填数据库公开演示开关（产品设置页可改；env 白名单仅作过渡兜底）。
    const demoSlugs = (process.env.PUBLIC_DEMO_SLUGS ?? "").split(",").map((slug) => slug.trim().toLowerCase()).filter(Boolean);
    for (const slug of demoSlugs) {
      await db.execute("UPDATE products SET is_public_demo = 1 WHERE slug = ?", [slug]);
      console.log(`Public demo enabled: ${slug}`);
    }
  } finally {
    await db.end();
  }
}

seed().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
