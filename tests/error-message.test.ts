import { describe, expect, it } from "vitest";
import { errorMessage } from "../lib/error-message";

describe("error messages", () => {
  it("preserves real errors and uses a fallback for unknown values", () => {
    expect(errorMessage(new Error("root cause"), "fallback")).toBe("root cause");
    expect(errorMessage(null, "fallback")).toBe("fallback");
  });
});
