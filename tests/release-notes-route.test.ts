import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecute, conn } = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  conn: { beginTransaction: vi.fn(), execute: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() },
}));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute, getConnection: vi.fn(async () => conn) }) }));
vi.mock("../lib/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("../lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("../lib/rate-limit", () => ({ enforceExportRateLimit: vi.fn(async () => null) }));
vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(),
  // 测试无请求作用域：after 直接同步执行回调，验证改写链路可跑通
  after: vi.fn(async (work: () => Promise<void>) => { await work(); }),
}));

import { GET, POST } from "../app/api/products/[slug]/releases/[id]/release-notes/route";
import { GET as markdownGET } from "../app/api/products/[slug]/releases/[id]/release-notes/markdown/route";
import { PATCH, POST as notePOST } from "../app/api/products/[slug]/release-notes/[noteId]/route";
import { getSessionUser } from "../lib/session";
import { requireProductAccess } from "../lib/product-access";

const access = {
  product: { id: 1, slug: "salesbuddy", name: "SalesBuddy", description: "d", organizationId: 7 },
  organization: { id: 7, slug: "team", name: "Team", role: "owner" },
  role: "owner",
  via: "organization",
} as const;

const changeRows = [
  { id: 11, kind: "added", entityType: "scenario", featureName: "助理聊天", scenarioReference: "HP-2", summary: "URL 可点", highlightType: "News", beforeJson: null, afterJson: { scenarios: [{ evidence: [{ path: "lib/chat.ts" }] }] } },
  { id: 12, kind: "changed", entityType: "scenario", featureName: "定价答复", scenarioReference: "EC-1", summary: "确定性答复", highlightType: null, beforeJson: null, afterJson: { scenarios: [{ evidence: [{ path: "lib/pricing.ts" }] }] } },
];

const noteRow = {
  id: 5, status: "draft", emphasis: "", voiceId: null, shareToken: "tok123", publishedAt: null, unpublishedAt: null, releaseId: 9,
};

const blockRows = [
  { position: 1, specChangeId: 11, emphasis: "", summaryOverride: "人工改写后的文案", kind: "added", entityType: "scenario", featureName: "助理聊天", scenarioReference: "HP-2", summary: "URL 可点", highlightType: "News", beforeJson: null, afterJson: { scenarios: [{ evidence: [{ path: "lib/chat.ts" }] }] } },
];

/** 按 SQL 形状分发 mock 返回值：releaseOwned → note（按 release 或按 id）→ changes → blocks。 */
function primeDb({ owned = true, note = null as null | typeof noteRow, changes = changeRows as unknown as Array<Record<string, unknown>>, blocks = [] as Array<Record<string, unknown>> }) {
  dbExecute.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id FROM releases WHERE id = ? AND product_id")) return [owned ? [{ id: 9 }] : [], []];
    if (sql.includes("FROM release_notes WHERE release_id")) return [note ? [note] : [], []];
    if (sql.includes("FROM release_notes WHERE id = ? AND product_id")) return [note ? [note] : [], []];
    if (sql.includes("FROM release_note_blocks b")) return [blocks, []];
    if (sql.includes("FROM spec_changes c")) return [changes, []];
    if (sql.includes("FROM release_note_blocks WHERE release_note_id")) return [[], []];
    return [[], []];
  });
}

function releaseRequest(method: "GET" | "POST", body?: unknown) {
  return new NextRequest("https://codelphi.example/api/products/salesbuddy/releases/9/release-notes", {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
}

function noteRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest("https://codelphi.example/api/products/salesbuddy/release-notes/5", {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
}

describe("release notes routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionUser).mockResolvedValue({ id: 3, sub: "user-1", email: "a@b.c", name: "A", picture: "" } as never);
    vi.mocked(requireProductAccess).mockResolvedValue(access as never);
    conn.execute.mockResolvedValue([[{ id: 5 }], []]);
  });

  it("401 for anonymous and 404 when the release belongs to another product", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect((await GET(releaseRequest("GET"), { params: Promise.resolve({ slug: "salesbuddy", id: "9" }) })).status).toBe(401);
    vi.mocked(getSessionUser).mockResolvedValue({ id: 3, sub: "user-1", email: "a@b.c", name: "A", picture: "" } as never);
    primeDb({ owned: false });
    expect((await GET(releaseRequest("GET"), { params: Promise.resolve({ slug: "salesbuddy", id: "9" }) })).status).toBe(404);
    const post = await POST(releaseRequest("POST", { slug: "salesbuddy", releaseId: 9, selectedIds: [11] }));
    expect(post.status).toBe(404);
  });

  it("GET without a note returns highlight-ordered candidates and never auto-selects", async () => {
    primeDb({ note: null });
    const response = await GET(releaseRequest("GET"), { params: Promise.resolve({ slug: "salesbuddy", id: "9" }) });
    const data = await response.json();
    expect(data.note).toBeNull();
    expect(data.candidates.map((candidate: { id: number }) => candidate.id)).toEqual([11, 12]);
  });

  it("GET with a note returns blocks with the human override applied and the public url", async () => {
    primeDb({ note: noteRow, blocks: blockRows });
    const response = await GET(releaseRequest("GET"), { params: Promise.resolve({ slug: "salesbuddy", id: "9" }) });
    const data = await response.json();
    expect(data.note.id).toBe(5);
    expect(data.note.publicUrl).toContain("/share/notes/tok123");
    expect(data.blocks[0].summary).toBe("人工改写后的文案");
    expect(data.blocks[0].overridden).toBe(true);
  });

  it("POST refuses to regenerate a published note with 409 (已发布只读)", async () => {
    primeDb({ note: { ...noteRow, status: "published" } });
    const response = await POST(releaseRequest("POST", { slug: "salesbuddy", releaseId: 9, selectedIds: [11] }));
    expect(response.status).toBe(409);
    expect(conn.execute).not.toHaveBeenCalled();
  });

  it("POST regenerating a draft keeps the existing share token and writes blocks inside a transaction", async () => {
    primeDb({ note: noteRow });
    const response = await POST(releaseRequest("POST", { slug: "salesbuddy", releaseId: 9, selectedIds: [11, 12], emphasis: "重点" }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.shareToken).toBe("tok123");
    expect(data.publicUrl).toContain("/share/notes/tok123");
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    const blockInsert = conn.execute.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO release_note_blocks"));
    expect(String(blockInsert?.[0])).toContain("summary_override");
    expect(conn.release).toHaveBeenCalled();
  });

  it("PATCH rejects editing a published note and saves draft block overrides", async () => {
    primeDb({ note: { ...noteRow, status: "published" }, blocks: blockRows });
    const published = await PATCH(noteRequest("PATCH", { emphasis: "x" }), { params: Promise.resolve({ slug: "salesbuddy", noteId: "5" }) });
    expect(published.status).toBe(409);

    primeDb({ note: noteRow });
    const saved = await PATCH(noteRequest("PATCH", { blocks: [{ position: 1, summaryOverride: "新措辞" }] }), { params: Promise.resolve({ slug: "salesbuddy", noteId: "5" }) });
    expect(saved.status).toBe(200);
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
  });

  it("note POST publish returns the share token and public url; unpublish too", async () => {
    dbExecute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM release_notes WHERE id = ? AND product_id")) return [[noteRow], []];
      if (sql.includes("FROM release_note_blocks WHERE release_note_id")) return [[{ spec_change_id: 11 }], []];
      return [[{ id: 11 }], []];
    });
    const published = await notePOST(noteRequest("POST", { action: "publish" }), { params: Promise.resolve({ slug: "salesbuddy", noteId: "5" }) });
    const data = await published.json();
    expect(data.status).toBe("published");
    expect(data.shareToken).toBe("tok123");
    expect(data.publicUrl).toContain("/share/notes/tok123");
  });

  it("markdown export 404s without a note and serves an attachment with one", async () => {
    primeDb({ note: null });
    const missing = await markdownGET(releaseRequest("GET"), { params: Promise.resolve({ slug: "salesbuddy", id: "9" }) });
    expect(missing.status).toBe(404);
    dbExecute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM releases WHERE id = ? AND product_id")) return [[{ id: 9 }], []];
      if (sql.includes("FROM release_notes WHERE release_id")) return [[noteRow], []];
      if (sql.includes("SELECT title, sha, url FROM releases")) return [[{ title: "助理聊天支持可点链接", sha: "3142b9688bbe", url: "https://github.com/x/y/compare/a...b" }], []];
      if (sql.includes("FROM release_note_blocks b")) return [blockRows, []];
      return [[], []];
    });
    const response = await markdownGET(releaseRequest("GET"), { params: Promise.resolve({ slug: "salesbuddy", id: "9" }) });
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(await response.text()).toContain("# 发布说明 · 助理聊天支持可点链接");
  });
});
