import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ValidationChange, ValidationImpactResult } from "./types";
import { analyzeSwiftcReadme } from "./swiftc";
import { analyzeTypescriptImports } from "./typescript";

export { analyzeSwiftcReadme, analyzeTypescriptImports };
export type { ValidationChange, ValidationImpactItem, ValidationImpactResult } from "./types";

export async function analyzeValidationImpact(repoRoot: string, change: ValidationChange, adapter?: ValidationImpactResult["adapter"]): Promise<ValidationImpactResult> {
  if (adapter === "swiftc_readme") return analyzeSwiftcReadme(repoRoot, change);
  if (adapter === "typescript_relative_imports") return analyzeTypescriptImports(repoRoot, change);
  if (existsSync(join(repoRoot, "ios", "Tests", "README.md"))) return analyzeSwiftcReadme(repoRoot, change);
  if (existsSync(join(repoRoot, "src"))) return analyzeTypescriptImports(repoRoot, change);
  throw new Error("no supported validation adapter for repository");
}
