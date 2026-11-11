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
  featureName: `功能${id % 2}`,
  scenarioReference: `HP-${id}`,
  summary: `变化 ${id}`,
  highlightType,
  evidencePaths: ["lib/chat.ts"],
  beforeJson: null,
  afterJson: null,
  releaseTitle: "t",
  releaseUrl: "u",
});

describe("ensureAutoReleaseNoteDraft (合并发布草稿)", () => {
  beforeEach(() => vi.clearAllMocks());

  const prime = ({ noteRows = [] as unknown[], changeRows }: { noteRows?: unknown[]; changeRows: unknown[] }) => {
    conn.execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM spec_changes c")) return [changeRows, []];
      if (sql.includes("FROM release_notes WHERE release_id")) return [noteRows, []];
      if (sql.includes("INSERT INTO release_notes")) return [{ insertId: 12 }];
      return [[{ id: 12 }], []];
    });
  };

  it("merges ALL behavior changes of the release into one draft (跨功能全量合并)", async () => {
    prime({ changeRows: [change(11, "News"), change(12, null), change(13, "Security")] });
    const noteId = await ensureAutoReleaseNoteDraft(conn, 9);
    expect(noteId).toBe(12);
    const blockInserts = conn.execute.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO release_note_blocks"));
    // 合并发布：全量入选（无 Highlight 过滤、无 Top-N 截断）
    expect(blockInserts).toHaveLength(3);
    // publishOrder：九类序 Security(4) 先于 News(8)，无 Highlight 的 12 靠后
    expect(blockInserts.map(([sql, params]) => (params as unknown[])[2])).toEqual([13, 11, 12]);
    const noteInsert = conn.execute.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO release_notes"));
    expect(String(noteInsert?.[0])).toContain("'draft'");
  });

  it("skips releases without behavior changes", async () => {
    prime({ changeRows: [] });
    expect(await ensureAutoReleaseNoteDraft(conn, 9)).toBeNull();
    expect(conn.execute.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO release_notes"))).toBe(false);
  });

  it("never overwrites an existing draft or published note", async () => {
    prime({ noteRows: [{ id: 4, status: "draft" }], changeRows: [change(11, "News")] });
    expect(await ensureAutoReleaseNoteDraft(conn, 9)).toBeNull();
    expect(conn.execute.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO release_notes"))).toBe(false);
  });
});
