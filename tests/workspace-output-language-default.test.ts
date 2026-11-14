import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceOutputLanguageDefault, updateWorkspaceOutputLanguageDefault } from "../lib/analysis-trigger";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../lib/db", () => ({ defaultExecute: execute }));

describe("workspace output language default (lib)", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("reads the workspace default and falls back to zh-CN", async () => {
    execute.mockResolvedValueOnce([[{ defaultOutputLanguage: "en" }]]);
    await expect(getWorkspaceOutputLanguageDefault(7)).resolves.toBe("en");
    execute.mockResolvedValueOnce([[]]);
    await expect(getWorkspaceOutputLanguageDefault(7)).resolves.toBe("zh-CN");
  });

  it("updates the workspace default column", async () => {
    execute.mockResolvedValue([[]]);
    await updateWorkspaceOutputLanguageDefault(7, "en");
    expect(execute).toHaveBeenCalledWith(
      "UPDATE organizations SET default_output_language = ? WHERE id = ?",
      ["en", 7],
    );
  });
});
