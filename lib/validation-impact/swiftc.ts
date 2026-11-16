import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidationChange, ValidationImpactResult } from "./types";

interface ValidationCommand {
  suite: string;
  line: number;
  sources: string[];
}

function commands(readme: string): ValidationCommand[] {
  const commands: ValidationCommand[] = [];
  let inBash = false;
  let pending = "";
  const finish = (line: number) => {
    if (!pending.trimStart().startsWith("swiftc")) {
      pending = "";
      return;
    }
    const command = pending.replaceAll("$SRC", "Tingfeng");
    const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const sources = tokens.filter((token) => token.endsWith(".swift"));
    const test = sources.find((source) => source.startsWith("Tests/"));
    commands.push({ suite: test?.split("/")[1] ?? `line-${line}`, line, sources });
    pending = "";
  };
  readme.split("\n").forEach((line, index) => {
    if (line.startsWith("```bash")) {
      inBash = true;
      return;
    }
    if (line.startsWith("```") && inBash) {
      inBash = false;
      return;
    }
    if (!inBash) return;
    pending += line;
    if (line.endsWith("\\")) {
      pending = `${pending.slice(0, -1)} `;
      return;
    }
    finish(index + 1);
  });
  return commands;
}

export async function analyzeSwiftcReadme(repoRoot: string, change: ValidationChange): Promise<ValidationImpactResult> {
  const evidencePath = "ios/Tests/README.md";
  const parsed = commands(readFileSync(join(repoRoot, evidencePath), "utf8"));
  const target = change.path.replace(/^ios\//, "");
  const requires = change.requires.map((path) => path.replace(/^ios\//, ""));
  const affected = parsed.filter((command) => command.sources.includes(target)
    && requires.some((required) => !command.sources.includes(required)));
  return {
    adapter: "swiftc_readme",
    target: change.path,
    requires: change.requires,
    affected: affected.map((command) => ({
      id: command.suite,
      kind: "command",
      evidencePath,
      sourceLine: command.line,
      dependencyChain: [change.path, command.suite],
    })),
    coverage: { commandCount: parsed.length, dynamicImports: "not_analyzed", externalPackages: "not_analyzed" },
  };
}
