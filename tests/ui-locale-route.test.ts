import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { POST } from "../app/api/ui-locale/route";

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(new NextRequest("https://radar.example/api/ui-locale", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } }));
}

describe("POST /api/ui-locale", () => {
  it("sets the locale cookie and redirects back", async () => {
    const response = await post({ locale: "en", redirectTo: "/settings" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://radar.example/settings");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("codelphi_locale=en");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=31536000");
  });

  it("rejects invalid locales and unsafe redirects", async () => {
    expect((await post({ locale: "fr", redirectTo: "/" })).status).toBe(400);
    expect((await post({ locale: "en", redirectTo: "https://evil.example" })).status).toBe(400);
    expect((await post({ locale: "en", redirectTo: "//evil.example" })).status).toBe(400);
    // WHATWG URL 在 special scheme 下把 `\` 归一为 `/`：/\evil.example 是跨站重定向
    expect((await post({ locale: "en", redirectTo: "/\\evil.example" })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
  });
});
