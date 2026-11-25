export interface OracleCheck {
  id: string;
  path: string;
  text: string;
  expected: "present" | "absent";
}

export async function evaluateOracleChecks(
  checks: readonly OracleCheck[],
  readFile: (sha: string, path: string) => Promise<string | null>,
  sha = "target",
) {
  const results: Array<{ id: string; passed: boolean }> = [];
  for (const check of checks) {
    const content = await readFile(sha, check.path);
    const contains = content?.includes(check.text) ?? false;
    results.push({
      id: check.id,
      passed: check.expected === "present" ? contains : !contains,
    });
  }
  return results;
}
