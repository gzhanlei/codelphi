import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { analyzedChangeFiles, analyzedChangePaths, evidenceKind, isImplementationSurfaceFile, isSchemaArtifact } from "../lib/evidence";
import { EvidenceLinks } from "../components/evidence-links";

describe("isImplementationSurfaceFile", () => {
  it("is the implementation tier minus migration scripts", () => {
    expect(isImplementationSurfaceFile("lib/auth.ts")).toBe(true);
    expect(isImplementationSurfaceFile("prisma/schema.prisma")).toBe(true);
    expect(isImplementationSurfaceFile("migrations/001_init.sql")).toBe(false);
    expect(isImplementationSurfaceFile("tests/a.test.ts")).toBe(false);
    expect(isImplementationSurfaceFile("README.md")).toBe(false);
  });
});

describe("analyzedChangeFiles / analyzedChangePaths", () => {
  const path = (file: { path: string }) => file.path;

  it("keeps the changed files that are still in the analysis target and drops migration scripts", () => {
    const files = [{ path: "lib/auth.ts", status: "modified", patch: "+auth" }, { path: "migrations/090_add_gift_wallet.sql", status: "added", patch: "+CREATE TABLE" }, { path: "db/schema.sql" }, { path: "lib/models.ts" }];
    expect(analyzedChangeFiles(files).map(path)).toEqual(["lib/auth.ts", "lib/models.ts"]);
    // 原对象原样返回：补丁等内容不丢。
    expect(analyzedChangeFiles(files)[0]).toBe(files[0]);
    expect(analyzedChangePaths(files)).toEqual(["lib/auth.ts", "lib/models.ts"]);
  });

  it("keeps order and repetition, so every caller deduplicates exactly as it did before", () => {
    expect(analyzedChangePaths([{ path: "lib/a.ts" }, { path: "lib/a.ts" }, { path: "lib/b.ts" }])).toEqual(["lib/a.ts", "lib/a.ts", "lib/b.ts"]);
    expect(analyzedChangePaths([])).toEqual([]);
  });
});

describe("isSchemaArtifact", () => {
  it("recognises migration scripts and SQL files", () => {
    expect(isSchemaArtifact("migrations/083_product_presentations.sql")).toBe(true);
    expect(isSchemaArtifact("superset/migrations/versions/2026_11_01.py")).toBe(true);
    expect(isSchemaArtifact("db/migration/001_init.rb")).toBe(true);
    expect(isSchemaArtifact("internal/store/sqlc/queries/oauth_clients.sql")).toBe(true);
  });

  it("leaves ordinary source, ORM model code and look-alike names alone", () => {
    expect(isSchemaArtifact("lib/billing/gift-wallet.ts")).toBe(false);
    expect(isSchemaArtifact("prisma/schema.prisma")).toBe(false);
    expect(isSchemaArtifact("django_app/models.py")).toBe(false);
    expect(isSchemaArtifact("docs/migrations.md")).toBe(false);
    expect(isSchemaArtifact("lib/migration-planner.ts")).toBe(false);
  });

  it("is a separate predicate: the evidence tier of a migration file does not change", () => {
    // 不给 evidenceKind 加档位：否则只引用迁移的场景会被当成弱证据，打上“测试佐证”。
    expect(evidenceKind("migrations/083_product_presentations.sql")).toBe("implementation");
  });
});

describe("evidenceKind", () => {
  it("classifies test files", () => {
    expect(evidenceKind("tests/release-card.test.ts")).toBe("test");
    expect(evidenceKind("lib/foo.spec.ts")).toBe("test");
  });

  it("classifies documentation and prompt declarations", () => {
    expect(evidenceKind("README.md")).toBe("document");
    expect(evidenceKind("docs/plan.md")).toBe("document");
  });

  it("treats everything else as implementation code", () => {
    expect(evidenceKind("components/release-card.tsx")).toBe("implementation");
    expect(evidenceKind("app/api/products/[slug]/route.ts")).toBe("implementation");
    expect(evidenceKind("lib/ai.ts")).toBe("implementation");
  });
});

describe("EvidenceLinks", () => {
  const value = [
    { path: "components/release-card.tsx", startLine: 116, url: "https://github.com/o/r/blob/abc/components/release-card.tsx#L116" },
    { path: "tests/release-card.test.ts", startLine: 50, url: "https://github.com/o/r/blob/abc/tests/release-card.test.ts#L50" },
    { path: "README.md", url: "https://github.com/o/r/blob/abc/README.md" },
  ];

  it("marks test and document evidence with their weaker strength, leaving implementation unmarked", () => {
    const html = renderToStaticMarkup(createElement(EvidenceLinks, { value }));
    expect(html).toContain("[测试]");
    expect(html).toContain("[文档]");
    expect(html).not.toContain("[实现]");
  });
});
