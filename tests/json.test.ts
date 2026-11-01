import { describe, expect, it } from "vitest";
import { parseJsonValue } from "../lib/json";

describe("database JSON values", () => {
  it("accepts objects and serialized JSON", () => {
    expect(parseJsonValue('{"reference":"HP-1"}')).toEqual({ reference: "HP-1" });
    expect(parseJsonValue(null)).toBeNull();
  });

  it("returns null for malformed serialized values", () => {
    expect(parseJsonValue("not-json")).toBeNull();
    expect(parseJsonValue(false)).toBe(false);
    expect(parseJsonValue(0)).toBe(0);
  });
});
