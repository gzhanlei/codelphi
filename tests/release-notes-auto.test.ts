import { beforeEach, describe, expect, it, vi } from "vitest";

const { conn } = vi.hoisted(() => ({
  conn: { execute: vi.fn() },
}));

vi.mock("../lib/db", () => ({ getDb: () => ({}) }));

import { ensureAutoReleaseNoteDraft } from "../lib/release-notes-service";

const change = (id: number, highlightType: string | null) => ({
  id,
  kind: "added",
  entityType: "scenario",
  featureName: "助理聊天",
  scenarioReference: `HP-${id}`,
  summary: `变化 ${id}`,
  highlightType,
  evidencePaths: ["lib/chat.ts"],
  beforeJson: null,
  afterJson: null,
  releaseTitle: "t",
  releaseUrl: "u",
});

describe("ensureAutoReleaseNoteDraft (自动 release notes 草稿)", () => {
  beforeEach(() => vi.clearAllMocks());

  const prime = ({ noteRows = [] as unknown[], changeRows }: { noteRows?: unknown[]; changeRows: unknown[] }) => {
    conn.execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM spec_changes c")) return [changeRows, []];
      if (sql.includes("FROM release_notes WHERE release_id")) return [noteRows, []];
      if (sql.includes("INSERT INTO release_notes")) return [{ insertId: 12 }];
      return [[{ id: 12 }], []];
    });
  };

  it("auto-drafts with highlight-only selection when highlights exist and no draft exists", async () => {
    prime({ changeRows: [change(11, "News"), change(12, null)] });
    const noteId = await ensureAutoReleaseNoteDraft(conn, 9);
    expect(noteId).toBe(12);
    const insert = conn.execute.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO release_note_blocks"));
    expect(insert).toBeDefined();
    // 仅 Highlight 项入选（不自动全选红线）
    expect(insert?.[1]).toEqual([12, 1, 11, ""]);
    const noteInsert = conn.execute.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO release_notes"));
    expect(String(noteInsert?.[0])).toContain("'draft'");
  });

  it("skips releases without any highlight (owner picks manually)", async () => {
    prime({ changeRows: [change(12, null)] });
    expect(await ensureAutoReleaseNoteDraft(conn, 9)).toBeNull();
    expect(conn.execute.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO release_notes"))).toBe(false);
  });

  it("never overwrites an existing draft or published note", async () => {
    prime({ noteRows: [{ id: 4, status: "draft" }], changeRows: [change(11, "News")] });
    expect(await ensureAutoReleaseNoteDraft(conn, 9)).toBeNull();
    expect(conn.execute.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO release_notes"))).toBe(false);
  });
});
