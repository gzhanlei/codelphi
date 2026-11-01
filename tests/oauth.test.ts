import { describe, expect, it } from "vitest";
import { pkceChallenge, safeNextPath } from "../lib/oauth";

describe("OAuth helpers", () => {
  it("creates an RFC 7636 S256 challenge", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("only allows local redirect paths", () => {
    expect(safeNextPath("/products/radar?view=spec")).toBe("/products/radar?view=spec");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\\\evil.example")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });
});
