import { describe, expect, it, vi } from "vitest";
import { upsertCodelphiUser } from "../lib/users";

describe("CoDelphi user persistence", () => {
  it("upserts the Chandler identity and normalizes nullable profile fields", async () => {
    const execute = vi.fn(async () => ({}));
    await upsertCodelphiUser({ sub: "usr_1", email: "person@example.com" }, execute);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("ON DUPLICATE KEY UPDATE"), ["usr_1", "person@example.com", null, null]);
    const emptyExecute = vi.fn(async () => ({}));
    await upsertCodelphiUser({ sub: "usr_2", email: "", name: "", picture: "" }, emptyExecute);
    expect(emptyExecute).toHaveBeenCalledWith(expect.any(String), ["usr_2", "", "", ""]);
  });
});
