import { describe, expect, it, vi } from "vitest";
import { loadPublishedChangelog } from "../lib/changelog";

const { dbExecute } = vi.hoisted(() => ({ dbExecute: vi.fn() }));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute }) }));

describe("published changelog loader (M11)", () => {
  it("keeps only published notes in descending publish order with block views", async () => {
    const noteRows = [
      { id: 2, status: "published", emphasis: "重点", voiceId: null, shareToken: "t2", publishedAt: new Date("2026-11-10T00:00:00Z"), unpublishedAt: null, releaseId: 9, releaseTitle: "新版", releaseSha: "bbb", releaseUrl: "https://github.com/x/y/compare/b", committedAt: new Date("2026-11-10T00:00:00Z") },
      { id: 1, status: "draft", emphasis: "", voiceId: null, shareToken: "t1", publishedAt: null, unpublishedAt: null, releaseId: 8, releaseTitle: "旧版", releaseSha: "aaa", releaseUrl: null, committedAt: new Date("2026-11-01T00:00:00Z") },
      { id: 3, status: "unpublished", emphasis: "", voiceId: null, shareToken: "t3", publishedAt: new Date("2026-11-09T00:00:00Z"), unpublishedAt: new Date("2026-11-09T01:00:00Z"), releaseId: 7, releaseTitle: "下线版", releaseSha: "ccc", releaseUrl: null, committedAt: new Date("2026-11-09T00:00:00Z") },
    ];
    dbExecute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM release_notes n JOIN releases")) return [noteRows, []];
      if (sql.includes("FROM release_note_blocks b")) {
        return [[{ position: 1, specChangeId: 11, emphasis: "", summaryOverride: "人工改写文案", kind: "added", entityType: "scenario", featureName: "助理聊天", scenarioReference: "HP-2", summary: "URL 可点", highlightType: "News", beforeJson: null, afterJson: null }], []];
      }
      return [[], []];
    });
    const entries = await loadPublishedChangelog(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].releaseId).toBe(9);
    expect(entries[0].emphasis).toBe("重点");
    expect(entries[0].blocks[0].summary).toBe("人工改写文案");
    expect(entries[0].blocks[0].overridden).toBe(true);
  });

  it("caps the number of entries", async () => {
    dbExecute.mockImplementation(async () => [[], []]);
    await loadPublishedChangelog(1, 5);
    expect(dbExecute.mock.calls[0][0]).toContain("LIMIT 5");
  });
});
