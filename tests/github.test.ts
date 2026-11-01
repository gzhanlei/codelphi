import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubSignature } from "../lib/github";

describe("GitHub webhook signatures", () => {
  it("accepts the matching HMAC and rejects altered payloads", () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const secret = "test-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyGitHubSignature(body, signature, secret)).toBe(true);
    expect(verifyGitHubSignature(`${body} `, signature, secret)).toBe(false);
    expect(verifyGitHubSignature(body, null, secret)).toBe(false);
  });
});
