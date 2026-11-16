import { exec, execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { analyzeValidationImpact } from "./index";
import type { ValidationChange, ValidationImpactResult } from "./types";

export interface ValidationExecutionRequest {
  adapter: ValidationImpactResult["adapter"];
  id: string;
  command?: string;
  webRoot?: string;
}

export interface ValidationExecutionResult {
  returnCode: number;
  output: string;
}

export type ValidationExecutor = (request: ValidationExecutionRequest) => Promise<ValidationExecutionResult>;

export interface ValidationWorkflowOptions {
  expectFailures?: boolean;
  execute?: ValidationExecutor;
}

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export function executionWorkingDirectory(adapter: ValidationImpactResult["adapter"], repoRoot: string): string {
  return adapter === "swiftc_readme" ? join(repoRoot, "ios") : repoRoot;
}

async function defaultExecutor(request: ValidationExecutionRequest): Promise<ValidationExecutionResult> {
  try {
    if (request.adapter === "swiftc_readme") {
      if (!request.command || !request.webRoot) throw new Error(`missing swift command for ${request.id}`);
      const result = await execAsync(request.command, { cwd: executionWorkingDirectory(request.adapter, request.webRoot), maxBuffer: 16 * 1024 * 1024 });
      return { returnCode: 0, output: `${result.stdout}${result.stderr}` };
    }
    if (!request.webRoot) throw new Error(`missing web root for ${request.id}`);
    const result = await execFileAsync("npx", ["vitest", "run", request.id], { cwd: request.webRoot, maxBuffer: 16 * 1024 * 1024 });
    return { returnCode: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return { returnCode: 1, output: `${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? ""}` };
  }
}

export async function runValidationWorkflow(repoRoot: string, changes: ValidationChange[], options: ValidationWorkflowOptions = {}) {
  const impacts = [] as ValidationImpactResult[];
  for (const change of changes) impacts.push(await analyzeValidationImpact(repoRoot, change));
  const byId = new Map<string, ValidationImpactResult["affected"][number] & { adapter: ValidationImpactResult["adapter"] }>();
  for (const impact of impacts) {
    for (const item of impact.affected) byId.set(item.id, { ...item, adapter: impact.adapter });
  }
  const predicted = [...byId.keys()].sort();
  const execute = options.execute ?? defaultExecutor;
  const actual = await Promise.all(predicted.map(async (id) => {
    const item = byId.get(id)!;
    const result = await execute({ adapter: item.adapter, id, command: item.command, webRoot: repoRoot });
    return { id, ...result, failed: result.returnCode !== 0 || result.output.includes("error:") || result.output.includes("FAIL") };
  }));
  const actualFailures = new Set(actual.filter((item) => item.failed).map((item) => item.id));
  const predictedSet = new Set(predicted);
  return {
    predicted,
    actual,
    missingPredictions: [...actualFailures].filter((id) => !predictedSet.has(id)).sort(),
    falsePositives: options.expectFailures ? predicted.filter((id) => !actualFailures.has(id)) : [],
  };
}
