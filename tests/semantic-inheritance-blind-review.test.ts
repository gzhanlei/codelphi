import { describe, expect, it } from "vitest";
import { buildBlindReviewMessages, parseReviewVerdict, type BlindReviewPacket } from "../scripts/semantic-inheritance-blind-review";

describe("buildBlindReviewMessages", () => {
  it("includes the candidate and code but excludes the prior decision and expected answer", () => {
    const messages = buildBlindReviewMessages({
      scenario: {
        reference: "HP-1",
        context: "mobile context",
        action: "mobile action",
        outcome: "mobile outcome",
        rationale: "must not leak",
        changeOrigin: "preexisting_discovery",
        expectedVerdict: "support",
      } as BlindReviewPacket["scenario"] & Record<"rationale" | "changeOrigin" | "expectedVerdict", string>,
      evidence: [{ path: "shared/Links.kt", startLine: 40, content: "40: LinkAnnotation.Url" }],
    });

    const prompt = messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("mobile context");
    expect(prompt).toContain("40: LinkAnnotation.Url");
    expect(prompt).not.toContain("must not leak");
    expect(prompt).not.toContain("preexisting_discovery");
    expect(prompt).not.toContain("expectedVerdict");
  });
});

describe("parseReviewVerdict", () => {
  it("parses only the supported verdict schema", () => {
    expect(parseReviewVerdict('{"verdict":"support","reason":"code matches"}')).toEqual({
      verdict: "support",
      reason: "code matches",
    });
    expect(() => parseReviewVerdict('{"verdict":"approve","reason":"wrong enum"}')).toThrow();
  });
});
