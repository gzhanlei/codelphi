export interface ValidationChange {
  path: string;
  requires: string[];
}

export interface ValidationImpactItem {
  id: string;
  kind: "command" | "test_file";
  evidencePath: string;
  sourceLine: number | null;
  dependencyChain: string[];
  command?: string;
}

export interface ValidationImpactResult {
  adapter: "swiftc_readme" | "typescript_relative_imports";
  target: string;
  requires: string[];
  affected: ValidationImpactItem[];
  coverage: {
    commandCount?: number;
    sourceFileCount?: number;
    dynamicImports: "not_analyzed";
    externalPackages: "not_analyzed";
  };
}
