import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/settings/analysis-trigger-default/route";

const PATCHBody = (body: unknown) =>
  PATCH({ json: async () => body } as never).then(async (result) => ({ status: result.status, body: await (result as Response).json() as unknown as Record<string, unknown> }));

vi.mock("@/lib/session", () => ({ requireSessionUser: vi.fn(async () => ({ id: 1 })) }));
const { updateDefault, requireOrganization } = vi.hoisted(() => ({ updateDefault: vi.fn(async () => undefined), requireOrganization: vi.fn() }));
vi.mock("@/lib/organizations", () => ({ requireOrganization: (...args: unknown[]) => requireOrganization(...args) }));
vi.mock("@/lib/analysis-trigger", () => ({ updateWorkspaceTriggerDefault: updateDefault, getWorkspaceTriggerDefault: vi.fn(async () => ({ trigger: "push", n: null, hour: null })) }));

const connection = { execute: vi.fn(async () => [{ id: 8 }]) };

vi.mock("@/lib/db", () => ({ getDb: () => ({ execute: connection.execute }) }));

beforeEach(() => {
  vi.clearAllMocks();
  requireOrganization.mockResolvedValue({ id: 7, slug: "ws", name: "WS", role: "editor" });
});

describe("PATCH /api/settings/analysis-trigger-default", () => {
  it("updates the workspace default for workspace editors", async () => {
    const { status, body } = await PATCHBody({ trigger: "daily", hour: 4 });
    expect(status).toBe(200);
    expect(body).toEqual({ status: "updated", trigger: "daily", n: 5, hour: 4 });
    expect(updateDefault).toHaveBeenCalledWith(7, { trigger: "daily", n: 5, hour: 4 });
  });

  it("rejects viewers with 403", async () => {
    requireOrganization.mockRejectedValue(new Error("forbidden"));
    const { status } = await PATCHBody({ trigger: "daily" });
    expect(status).toBe(403);
    expect(updateDefault).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    const { status } = await PATCHBody({ trigger: "hourly" });
    expect(status).toBe(400);
    expect(updateDefault).not.toHaveBeenCalled();
  });
});
