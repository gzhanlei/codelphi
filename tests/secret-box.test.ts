import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../lib/secret-box";

describe("integration credential encryption", () => {
  it("round-trips secrets without storing plaintext", () => {
    const encrypted = encryptSecret("private-key", "session-secret");
    expect(encrypted).not.toContain("private-key");
    expect(decryptSecret(encrypted, "session-secret")).toBe("private-key");
  });

  it("uses a fresh nonce and rejects tampering and wrong keys", () => {
    const first = encryptSecret("same", "session-secret");
    const second = encryptSecret("same", "session-secret");
    expect(first).not.toBe(second);
    expect(() => decryptSecret(first, "wrong-secret")).toThrow();
    expect(() => decryptSecret(`${first.slice(0, -2)}aa`, "session-secret")).toThrow();
    expect(() => decryptSecret(Buffer.alloc(28).toString("base64url"), "session-secret")).toThrow();
    expect(() => decryptSecret("", "session-secret")).toThrow();
  });
});
