import { describe, expect, it } from "vitest";
import { loginErrorMessage } from "../components/login-error";

describe("login errors", () => {
  it("maps known and unknown failures without leaking internals", () => {
    expect(loginErrorMessage("invalid_oauth_state")).toContain("重新发起登录");
    expect(loginErrorMessage("database-password")).toBe("登录失败，请重试。");
    expect(loginErrorMessage(undefined)).toBe("");
  });
});
