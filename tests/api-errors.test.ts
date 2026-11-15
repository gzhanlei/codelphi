import { describe, expect, it } from "vitest";
import { apiErrorBody, ERROR_MESSAGES, ERROR_CODES } from "../lib/api-errors";
import { errorMessageFromData, errorMessage } from "../lib/error-message";

describe("api error codes (4e)", () => {
  it("defines a bilingual message for every code", () => {
    for (const code of ERROR_CODES) {
      const entry = ERROR_MESSAGES[code];
      expect(entry["zh-CN"]).toBeTruthy();
      expect(entry.en).toBeTruthy();
    }
  });

  it("returns the zh message as error text plus the code field", () => {
    const body = apiErrorBody("product_not_found");
    expect(body).toEqual({ error: "产品不存在或不属于当前工作区", code: "product_not_found" });
    expect(apiErrorBody("unauthorized").error).toBe("未登录");
  });
});

describe("errorMessageFromData (client locale mapping)", () => {
  it("maps a known code to the requested locale", () => {
    expect(errorMessageFromData({ code: "product_not_found", error: "产品不存在或不属于当前工作区" }, "fallback", "en")).toBe("The product does not exist in this workspace");
    expect(errorMessageFromData({ code: "unauthorized" }, "fallback", "zh-CN")).toBe("未登录");
  });

  it("falls back to the raw message then the default fallback", () => {
    expect(errorMessageFromData({ error: "业务专属中文错误" }, "fallback", "en")).toBe("业务专属中文错误");
    expect(errorMessageFromData({}, "fallback", "en")).toBe("fallback");
    expect(errorMessageFromData(null, "fallback", "en")).toBe("fallback");
  });

  it("maps an Error carrying a response code via errorMessage", () => {
    const error = Object.assign(new Error("产品不存在或不属于当前工作区"), { code: "product_not_found" });
    expect(errorMessage(error, "fallback", "en")).toBe("The product does not exist in this workspace");
    expect(errorMessage(error, "fallback")).toBe("产品不存在或不属于当前工作区");
    expect(errorMessage(new Error("业务专属中文错误"), "fallback", "en")).toBe("业务专属中文错误");
    expect(errorMessage("not an error", "fallback", "en")).toBe("fallback");
  });
});
