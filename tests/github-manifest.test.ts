import { describe, expect, it } from "vitest";
import { manifestCallbackAllowed, manifestDocument } from "../lib/github-manifest";

describe("GitHub manifest flow", () => {
  it("renders an official POST form without exposing writable permissions", () => {
    const html = manifestDocument({ name: "CoDelphi \"Test\"", default_permissions: { contents: "read", metadata: "read" }, "state\"<script>": "value" }, "state-token");
    expect(html).toContain("https://github.com/settings/apps/new?state=state-token");
    expect(html).toContain("https://github.com/settings/apps/new");
    expect(html).toContain("method=\"post\"");
    expect(html).toContain("name=\"manifest\"");
    expect(html).toContain("contents");
    expect(html).not.toContain("<script>alert");
  });

  it("requires a code and matching state", () => {
    expect(manifestCallbackAllowed({ code: "code", state: "state", expectedState: "state" })).toBe(true);
    expect(manifestCallbackAllowed({ code: null, state: "state", expectedState: "state" })).toBe(false);
    expect(manifestCallbackAllowed({ code: "code", state: "wrong", expectedState: "state" })).toBe(false);
    expect(manifestCallbackAllowed({ code: "code", state: "state", expectedState: undefined })).toBe(false);
  });
});
