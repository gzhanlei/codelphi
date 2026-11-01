import { describe, expect, it } from "vitest";
import { isValidDatabaseName, databaseName } from "../scripts/create-database";

describe("database names", () => {
  it("accepts only simple MySQL schema names", () => {
    expect(isValidDatabaseName("radar_test")).toBe(true);
    expect(isValidDatabaseName("radar-test")).toBe(false);
    expect(isValidDatabaseName("radar`; DROP DATABASE mysql;--")).toBe(false);
    expect(isValidDatabaseName(undefined)).toBe(false);
    expect(databaseName({ database: "radar" })).toBe("radar");
    expect(() => databaseName({ database: "bad-name" })).toThrow("simple database name");
  });
});
