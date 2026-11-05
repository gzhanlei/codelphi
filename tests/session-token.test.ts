import { describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "../lib/session-token";

describe("session tokens", () => {
  it("round-trips a signed user session", async () => {
    const token = await createSessionToken({ sub: "usr_1", email: "person@example.com" }, "test-secret");
    await expect(verifySessionToken(token, "test-secret")).resolves.toEqual({ sub: "usr_1", email: "person@example.com" });
  });

  it("returns null for invalid credentials and tokens", async () => {
    await expect(verifySessionToken("not-a-jwt", "test-secret")).resolves.toBeNull();
    const token = await createSessionToken({ sub: "usr_1" }, "test-secret");
    await expect(verifySessionToken(token, "wrong-secret")).resolves.toBeNull();
  });
});
