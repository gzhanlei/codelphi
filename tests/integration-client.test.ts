import { describe, expect, it } from "vitest";
import { connectionAction } from "../lib/integration-client";

describe("integration actions", () => {
  it("returns connection status including an API-reported disconnection", async () => {
    const response = await connectionAction(9, "check", async () => new Response(JSON.stringify({ status: "disconnected", error: "denied" }), { status: 503 }));
    expect(response.status).toBe("disconnected");
  });

  it("throws when the response has no usable error", async () => {
    await expect(connectionAction(9, "disconnect", async () => new Response(JSON.stringify({}), { status: 500 }))).rejects.toThrow("操作失败");
  });
});
