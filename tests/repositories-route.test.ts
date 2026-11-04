import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryListError } from "../lib/github-repositories";
import { repositoryListErrorResponse } from "../lib/repository-list-response";
import { GET } from "../app/api/repositories/route";
import { getCodeHostingAdapter } from "@/lib/code-hosting";

const { listRepositories, getAdapter } = vi.hoisted(() => {
  const list = vi.fn();
  return { listRepositories: list, getAdapter: vi.fn(() => ({ listRepositories: list })) };
});
vi.mock("@/lib/code-hosting", () => ({ getCodeHostingAdapter: getAdapter }));
vi.mock("@/lib/session", () => ({ requireSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("@/lib/organizations", () => ({ requireOrganization: vi.fn(async () => ({ id: 7, role: "owner" })) }));

describe("repository listing route", () => {
  beforeEach(() => {
    listRepositories.mockReset();
    getAdapter.mockClear();
  });

  it("lists only repositories visible to the current workspace connection", async () => {
    listRepositories.mockResolvedValue({ repositories: [{ id: 1, fullName: "owner/radar", defaultBranch: "main", private: true }], hasMore: false });
    const response = await GET(new NextRequest("http://localhost/api/repositories?provider=github&connectionId=9&page=2"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getAdapter).toHaveBeenCalledWith("github");
    expect(listRepositories).toHaveBeenCalledWith({ connectionId: 9, organizationId: 7 }, 2);
    expect(await response.json()).toEqual({ repositories: [{ id: 1, fullName: "owner/radar", defaultBranch: "main", private: true }], hasMore: false });
  });

  it("maps provider and unexpected failures to safe responses", async () => {
    const mapped = repositoryListErrorResponse(new RepositoryListError("denied", 400));
    expect(mapped.status).toBe(400);
    expect(await mapped.json()).toEqual({ error: "denied" });
    const generic = repositoryListErrorResponse(new Error("upstream failed"));
    expect(generic.status).toBe(500);
    expect(await generic.json()).toEqual({ error: "upstream failed" });
    expect(repositoryListErrorResponse("unknown").status).toBe(500);
  });

  it("enforces page boundaries without rewriting empty parameters", async () => {
    for (const query of ["connectionId=9&page=0", "connectionId=9&page=6", "connectionId=9&page=", "connectionId=0&page=1"]) {
      const response = await GET(new NextRequest(`http://localhost/api/repositories?provider=github&${query}`));
      expect(response.status).toBe(400);
    }
    expect(listRepositories).not.toHaveBeenCalled();
    listRepositories.mockResolvedValue({ repositories: [], hasMore: false });
    const lastPage = await GET(new NextRequest("http://localhost/api/repositories?provider=github&connectionId=9&page=5"));
    expect(lastPage.status).toBe(200);
    expect(listRepositories).toHaveBeenCalledWith({ connectionId: 9, organizationId: 7 }, 5);
    await GET(new NextRequest("http://localhost/api/repositories?provider=&connectionId=9&page=1"));
    expect(getAdapter).toHaveBeenLastCalledWith("");
  });

  it("rejects a missing connection or invalid page before calling GitHub", async () => {
    const missing = await GET(new NextRequest("http://localhost/api/repositories?provider=github&page=1"));
    expect(missing.status).toBe(400);
    const invalid = await GET(new NextRequest("http://localhost/api/repositories?provider=github&connectionId=9&page=6"));
    expect(invalid.status).toBe(400);
    expect(listRepositories).not.toHaveBeenCalled();
  });
});
