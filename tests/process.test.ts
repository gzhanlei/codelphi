import { describe, expect, it } from "vitest";
import { execCommand } from "../lib/process";

describe("process runner", () => {
  it("captures stdout without a shell", async () => {
    const result = await execCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toBe("");
  });

  it("preserves output on a non-zero exit", async () => {
    await expect(execCommand(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(2)"])).rejects.toMatchObject({ stdout: "", stderr: "bad" });
  });
});
