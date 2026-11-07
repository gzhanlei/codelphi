import { describe, expect, it } from "vitest";
import { userDisplayName, userInitial } from "../lib/user-display";

describe("user display", () => {
  it("prefers the profile name and falls back predictably", () => {
    expect(userDisplayName({ sub: "u1", name: "韩磊", email: "person@example.com" })).toBe("韩磊");
    expect(userDisplayName({ sub: "u1", email: "person@example.com" })).toBe("person@example.com");
    expect(userDisplayName({ sub: "u1" })).toBe("CoDelphi 用户");
  });

  it("uses the first visible character for the avatar", () => {
    expect(userInitial({ sub: "u1", name: "韩磊" })).toBe("韩");
    expect(userInitial({ sub: "u1", email: "person@example.com" })).toBe("P");
    expect(userInitial({ sub: "u1" })).toBe("C");
  });
});
