import { describe, expect, it } from "vitest";
import { evaluateOracleChecks } from "../scripts/semantic-inheritance-oracle";

describe("evaluateOracleChecks", () => {
  it("uses Git content to verify required and forbidden implementation facts", async () => {
    const results = await evaluateOracleChecks([
      { id: "has-mobile-link", path: "shared/Links.kt", text: "LinkAnnotation.Url", expected: "present" },
      { id: "no-turnstile-field", path: "internal/auth.go", text: "cf_turnstile_response", expected: "absent" },
      { id: "new-file-missing", path: "internal/turnstile.go", text: "package turnstile", expected: "absent" },
    ], async (_sha, filePath) => ({
      "shared/Links.kt": "LinkAnnotation.Url",
      "internal/auth.go": "package auth",
      "internal/turnstile.go": null,
    })[filePath] ?? null);

    expect(results).toEqual([
      { id: "has-mobile-link", passed: true },
      { id: "no-turnstile-field", passed: true },
      { id: "new-file-missing", passed: true },
    ]);
  });

  it("fails closed when a required implementation fact is absent or unreadable", async () => {
    const results = await evaluateOracleChecks([
      { id: "required-config", path: "internal/config.go", text: "must be set together", expected: "present" },
    ], async () => null);

    expect(results).toEqual([{ id: "required-config", passed: false }]);
  });
});
