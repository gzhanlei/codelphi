import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { ValidationChange, ValidationImpactResult } from "./types";

const IMPORT_PATTERN = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".vue"];

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.includes(extname(entry.name)))
    .map((entry) => join(entry.parentPath, entry.name));
}

function resolveImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(importer), specifier);
  const candidates = extname(base)
    ? [base]
    : [...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`), ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`))];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function analyzeTypescriptImports(webRoot: string, change: ValidationChange): Promise<ValidationImpactResult> {
  const sourceRoot = join(webRoot, "src");
  const target = resolve(webRoot, change.path);
  if (!existsSync(target)) throw new Error(`target not found: ${change.path}`);
  const reverse = new Map<string, string[]>();
  const files = sourceFiles(sourceRoot).map((file) => resolve(file));
  for (const importer of files) {
    const text = readFileSync(importer, "utf8");
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const dependency = resolveImport(importer, match[1] ?? match[2]);
      if (!dependency) continue;
      reverse.set(dependency, [...(reverse.get(dependency) ?? []), importer]);
    }
  }
  const chains = new Map<string, string[]>([[target, [target]]]);
  const queue = [target];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const importer of reverse.get(current) ?? []) {
      if (chains.has(importer)) continue;
      chains.set(importer, [...(chains.get(current) ?? []), importer]);
      queue.push(importer);
    }
  }
  const affected = [...chains.keys()].filter((path) => /\.(spec|test)\.[^.]+$/.test(path)).sort();
  return {
    adapter: "typescript_relative_imports",
    target: change.path,
    requires: change.requires,
    affected: affected.map((path) => ({
      id: relative(webRoot, path),
      kind: "test_file",
      evidencePath: relative(webRoot, path),
      sourceLine: null,
      dependencyChain: (chains.get(path) ?? []).map((item) => relative(webRoot, item)),
    })),
    coverage: { sourceFileCount: chains.size - 1, dynamicImports: "not_analyzed", externalPackages: "not_analyzed" },
  };
}
