import { describe, expect, it, vi } from "vitest";
import { pick, resolveUiLocaleValue, UI_LOCALE_COOKIE, UI_LOCALE_LABELS } from "../lib/ui-locale";
import { NAV_LABELS, COMMON_LABELS, SIDEBAR_NOTE, BRAND_TAGLINE } from "../lib/ui-strings";

describe("ui locale resolution", () => {
  it("parses the cookie value and falls back to zh-CN", () => {
    expect(resolveUiLocaleValue("en")).toBe("en");
    expect(resolveUiLocaleValue("zh-CN")).toBe("zh-CN");
    expect(resolveUiLocaleValue(undefined)).toBe("zh-CN");
    expect(resolveUiLocaleValue("fr")).toBe("zh-CN");
  });

  it("exposes a self-named label for every locale", () => {
    expect(UI_LOCALE_LABELS["zh-CN"]).toBe("中文");
    expect(UI_LOCALE_LABELS.en).toBe("English");
    expect(UI_LOCALE_COOKIE).toBe("codelphi_locale");
  });
});

describe("ui strings dictionary", () => {
  it("labels every shell nav entry in both locales", () => {
    expect(pick("zh-CN", NAV_LABELS.overview)).toBe("产品总览");
    expect(pick("en", NAV_LABELS.overview)).toBe("Products");
    expect(pick("en", NAV_LABELS.settings)).toBe("Settings");
    expect(pick("zh-CN", NAV_LABELS.settings)).toBe("设置");
    for (const entry of Object.values(NAV_LABELS)) {
      expect(entry["zh-CN"]).toBeTruthy();
      expect(entry.en).toBeTruthy();
    }
  });

  it("labels shell chrome entries in both locales", () => {
    expect(pick("en", COMMON_LABELS.logout)).toBe("Sign out");
    expect(pick("zh-CN", COMMON_LABELS.logout)).toBe("退出");
    expect(pick("en", COMMON_LABELS.login)).toContain("Sign in");
    expect(pick("en", SIDEBAR_NOTE)).toContain("Every release");
    expect(pick("en", BRAND_TAGLINE)).toBeTruthy();
  });
});
