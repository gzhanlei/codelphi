import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { getSessionUser } from "../lib/session";
import { createSessionToken } from "../lib/session-token";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const SECRET = "session-test-secret";

function withCookieValue(value: string | undefined) {
  vi.mocked(cookies).mockResolvedValue({ get: () => (value === undefined ? undefined : { value }) } as never);
}

describe("session user resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SESSION_SECRET", SECRET);
  });

  it("resolves the signed-in user from the session cookie", async () => {
    const token = await createSessionToken({ sub: "usr_1", email: "person@example.com" }, SECRET);
    withCookieValue(token);
    await expect(getSessionUser()).resolves.toEqual({ sub: "usr_1", email: "person@example.com" });
  });

  it("returns null without a cookie, without a secret, or with a forged token", async () => {
    withCookieValue(undefined);
    await expect(getSessionUser()).resolves.toBeNull();
    vi.unstubAllEnvs();
    const token = await createSessionToken({ sub: "usr_1" }, SECRET);
    withCookieValue(token);
    await expect(getSessionUser()).resolves.toBeNull();
    vi.stubEnv("SESSION_SECRET", SECRET);
    withCookieValue(await createSessionToken({ sub: "usr_1" }, "other-secret"));
    await expect(getSessionUser()).resolves.toBeNull();
  });
});
